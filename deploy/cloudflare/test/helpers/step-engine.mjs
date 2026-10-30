// A test-only effect executor for the engine side of the transaction step machine (ADR 0024
// pull request 6): `execute` as a `request` event with no owner, run with placement `direct`
// or forwarded to the owner `tx_<validation hex>` the machine names.
// TEST ONLY: no production path uses the machine before the switch-over (pull request 8).
//
// `StepEngine.execute` takes the inputs of `PolicySqlEngine.execute` and makes no decision of
// its own beyond what `engine.ts` keeps before the machine: the request context, the session
// (core's `authorize_session_json`), and the body text (`parseBodyText`). Every other decision
// is one call of `runtime.step_json`, and the executor only runs the effects it returns, in
// order (ADR 0024 "Effect execution contract"):
//
// - `checkBinding`, `open`, `execute`, `commit`, `rollback` through the wrapper's database
//   provider. Failures are classified as `turso.ts` `remoteFailure` does: a query timeout is
//   `timeout`, anything else `unavailable`;
// - `execute.trace`, when present, is published to the deployment's trace sink before the
//   statements run (the sink call stays in the engine);
// - `forward` through the owners' port (`route(name).atomic`), its reply fed as `ownerReplied`;
// - `observe` in the background: the cost statements on a separate read connection
//   (`${requestId}-cost`, the runtime's `costTimeoutMs`), evaluated by `cost_estimate_json`,
//   and logged as `cost_observation` or `cost_observation_failed`, as `cost.ts` logs them;
// - `respond` is the operation's result; `reset` closes the connection.
import { EngineError, internalError, operationError } from "../../src/errors.ts";
import { checkRequestContext } from "../../src/engine.ts";
import { authorizeSession } from "../../src/session.ts";
import { parseBodyText } from "../../src/request-body.ts";
import { checkDatabaseBinding, databaseTransportFactory } from "../../src/database.ts";
import { driverArgs, rawDriverValue, rowValues } from "../../src/driver-values.ts";
import { runtimeBytesLimit } from "../../src/binary.ts";
import { runtimeLimits } from "../../src/limits.ts";
import { validateConfig } from "../../src/engine-config.ts";

const parseExact = (text) => JSON.parse(text, (_key, value, context) =>
  typeof value === "number" && !Number.isSafeInteger(value) && /^-?\d+$/u.test(context?.source ?? "")
    ? BigInt(context.source) : value);

const decodeArgs = (args, maxBytes) => {
  const exact = Object.entries(args).filter(([, value]) => typeof value === "bigint");
  const rest = Object.fromEntries(Object.entries(args).filter(([, value]) => typeof value !== "bigint"));
  return { ...driverArgs({ clientParameters: rest, serverParameters: {} }, maxBytes), ...Object.fromEntries(exact) };
};

const randomHex = () => [...crypto.getRandomValues(new Uint8Array(32))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** `turso.ts` `remoteFailure`: a query timeout is a timeout, anything else unavailable. */
const directClass = (error) => {
  if (error?.name === "QueryTimeoutError" || error?.code === "QUERY_TIMEOUT") return "timeout";
  if (error instanceof EngineError) {
    if (error.code === "POLICYSQL_DATABASE_TIMEOUT") return "timeout";
    if (error.code === "POLICYSQL_DATABASE_BINDING_REJECTED") return "rejected";
  }
  return "unavailable";
};

const resultsOf = (results, maxBytes) => results.map((result) => ({
  columns: result.columns,
  rows: result.rows.map((row) => rowValues(result.columns, row).map((value) => {
    try { return rawDriverValue(value, maxBytes); } catch (error) {
      return { type: "invalid", limit: error?.code === "POLICYSQL_LIMIT_EXCEEDED" };
    }
  })),
  rowsAffected: Number(result.rowsAffected ?? 0),
  usage: result.usage,
}));

export class StepEngine {
  /**
   * `owners` is a TransactionOwner port whose handles have `atomic(input, requestId)`;
   * `executionTrace` is the deployment's `{ enabled, sink }`.
   */
  constructor({ getRuntime, database, config = { environment: "test" }, owners, executionTrace = undefined }) {
    this.getRuntime = getRuntime;
    this.database = database;
    this.config = validateConfig(config);
    this.owners = owners;
    this.executionTrace = executionTrace;
    /** Every step: the four inputs and the output text. */
    this.transcript = [];
  }

  async execute(input, context, background = undefined) {
    let checked;
    try { checked = checkRequestContext(context, background); } catch (error) {
      return { ok: false, error: operationError(error), requestId: crypto.randomUUID() };
    }
    const { requestId } = checked;
    try {
      const runtime = this.getRuntime();
      const auth = authorizeSession(runtime, checked.session, input.role, "execute", requestId);
      const body = await parseBodyText(input.bodyText);
      const operation = {
        kind: "execute", auth, databaseBinding: checked.databaseBinding, snapshot: runtime.snapshot, bodyText: body.text,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        trace: this.executionTrace?.enabled === true,
      };
      const reply = await this.drive({ type: "request", operation }, requestId, checked.background);
      return reply.ok ? { ok: true, value: reply.value, requestId } : { ok: false, error: reply.error, requestId };
    } catch (error) {
      return { ok: false, error: operationError(error), requestId };
    }
  }

  step(state, event, requestId) {
    const host = JSON.stringify({ nowMs: Date.now(), entropy: randomHex(), requestId, owner: null });
    const eventText = JSON.stringify(event, (_key, value) => (typeof value === "bigint" ? Number(value) : value));
    const outputText = this.getRuntime().step_json(undefined, state.volatile ?? undefined, eventText, host);
    this.transcript.push({ durable: null, volatile: state.volatile, event: eventText, host, output: outputText });
    const output = parseExact(outputText);
    if (output.error) throw new EngineError(output.error.code, output.error.message);
    state.volatile = output.volatile;
    return output;
  }

  async drive(event, requestId, background) {
    const state = { volatile: null, transaction: null };
    let reply = null;
    let next = event;
    try {
      while (next) {
        const output = this.step(state, next, requestId);
        next = null;
        for (const effect of output.effects) {
          switch (effect.type) {
            case "respond": reply = effect.reply; break;
            case "log": console.log(JSON.stringify(effect.record)); break;
            case "observe": this.observe(effect, background); break;
            case "reset":
              if (state.transaction?.open) state.transaction.rollback().catch(() => undefined);
              state.transaction = null;
              state.volatile = null;
              break;
            default:
              next = await this.perform(effect, state, requestId);
          }
        }
      }
    } catch {
      // Invalid host facts or an engine fault: Abandon with the previous state, then 500.
      try { this.step(state, { type: "abandon" }, requestId); } catch { /* discarded */ }
      if (state.transaction?.open) await state.transaction.rollback().catch(() => undefined);
      return { ok: false, error: operationError(internalError()) };
    }
    return reply ?? { ok: false, error: operationError(internalError()) };
  }

  async perform(effect, state, requestId) {
    const { id } = effect;
    const runtime = this.getRuntime();
    const maxBytes = runtimeBytesLimit(runtime);
    switch (effect.type) {
      case "checkBinding":
        try {
          await checkDatabaseBinding(this.database, effect.binding, effect.binding.snapshot, effect.deadlineMs);
          return { type: "bindingChecked", id, allowed: true };
        } catch (error) {
          const errorClass = directClass(error);
          return errorClass === "rejected" ? { type: "bindingChecked", id, allowed: false } : { type: "bindingCheckFailed", id, class: errorClass };
        }
      case "open":
        try {
          const factory = databaseTransportFactory(this.database, effect.binding, maxBytes);
          const transport = await factory(requestId, effect.deadlineMs);
          state.transaction = await transport.begin(effect.mode, effect.timeoutMs);
          return { type: "opened", id };
        } catch (error) {
          return { type: "openFailed", id, class: directClass(error) };
        }
      case "execute":
        try {
          if (effect.trace && this.executionTrace?.sink) {
            try { await this.executionTrace.sink(effect.trace); } catch (error) {
              console.log(JSON.stringify({
                event: "execution_trace_sink_failed", requestId, internalClass: error?.constructor?.name ?? "UnknownError",
              }));
            }
          }
          const results = await state.transaction.execute(effect.statements.map((statement) => ({
            sql: statement.sql, args: decodeArgs(statement.args, maxBytes),
          })));
          return { type: "executed", id, results: resultsOf(results, maxBytes) };
        } catch (error) {
          return { type: "executeFailed", id, class: directClass(error) };
        }
      case "commit":
        try {
          await state.transaction.commit();
          return { type: "committed", id };
        } catch (error) {
          return { type: "commitFailed", id, class: directClass(error) };
        }
      case "rollback":
        try {
          await state.transaction?.rollback();
          return { type: "rolledBack", id };
        } catch (error) {
          return { type: "rollbackFailed", id, class: directClass(error) };
        } finally {
          state.transaction = null;
        }
      case "forward":
        try {
          const reply = await this.owners.route(effect.owner).atomic(effect.input, requestId);
          return { type: "ownerReplied", id, reply };
        } catch {
          return { type: "forwardFailed", id, class: "unavailable" };
        }
      default:
        throw new Error(`unknown effect ${effect.type}`);
    }
  }

  /** The background cost observation of a committed envelope (`cost.ts` orchestration). */
  observe(effect, background) {
    const task = this.observeTask(effect).catch(() => undefined);
    if (background) background.run(task);
  }

  async observeTask(effect) {
    const requestId = `${effect.context.requestId}-cost`;
    const runtime = this.getRuntime();
    const maxBytes = runtimeBytesLimit(runtime);
    const { costTimeoutMs } = runtimeLimits(runtime);
    const catalog = this.config.costCatalog ?? null;
    let transaction;
    let results = [];
    try {
      if (catalog !== null && effect.statements.length > 0) {
        const transport = await databaseTransportFactory(this.database, effect.context.binding, maxBytes)(requestId, Date.now() + costTimeoutMs);
        transaction = await transport.begin("read", costTimeoutMs);
        results = await transaction.execute(effect.statements.map((statement) => ({ sql: statement.sql, args: decodeArgs(statement.args, maxBytes) })));
        await transaction.commit();
      }
    } catch (error) {
      if (transaction?.open) await transaction.rollback().catch(() => undefined);
      console.log(JSON.stringify({ event: "cost_observation_failed", requestId, code: typeof error?.code === "string" ? error.code : "POLICYSQL_COST_ADMISSION_UNAVAILABLE" }));
      return;
    }
    const output = JSON.parse(runtime.cost_estimate_json(JSON.stringify({
      catalog,
      statements: effect.context.statements,
      results: results.map((result) => ({ columns: result.columns, rows: result.rows.map((row) => rowValues(result.columns, row)) })),
    })));
    if (output.error) {
      console.log(JSON.stringify({ event: "cost_observation_failed", requestId, code: output.error.code }));
      return;
    }
    const usage = transaction?.usage ?? [];
    console.log(JSON.stringify({
      event: "cost_observation",
      requestId,
      estimates: output.estimates,
      usage: {
        rowsRead: usage.reduce((sum, item) => sum + item.rowsRead, 0),
        rowsWritten: usage.reduce((sum, item) => sum + item.rowsWritten, 0),
        queryDurationMs: usage.reduce((sum, item) => sum + item.queryDurationMs, 0),
      },
    }));
  }
}
