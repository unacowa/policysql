// The engine-side executor of the transaction step machine's `request` kind (ADR 0024 pull
// request 8). An `execute` is one `request` event with no owner in the host facts; the
// machine checks the binding, compiles the verified body text (#70), computes the idempotency
// identity, and either runs the envelope here (placement `direct`) or names the owner that
// runs it (`forward`). This module makes no decision that the specification determines: it
// calls `runtime.step_json`, runs the effects in order ("Effect execution contract"), and
// maps each awaited effect's outcome or exception to exactly one outcome event:
//
// - `checkBinding`, `open`, `execute`, `commit`, `rollback` through the wrapper's database
//   provider; a failure is classified as the TypeScript direct path classified it before ADR
//   0024 pull request 8 (`directFailureClass`: a timeout is `timeout`, a rejected binding
//   `rejected`, anything else `unavailable`);
// - `execute.trace`, when present, is published to the deployment's trace sink before the
//   statements run;
// - `forward` through the TransactionOwner port's `atomic`, with the engine's request id, which
//   becomes the owner's `HostFacts.request_id`, so the owner's reply and its stored record keep
//   the engine's request id (`meta.requestId`, `originalRequestId`);
// - `observe` in the background (`step-effects.ts` `observeCost`);
// - `respond` is the operation's reply; `reset` closes the connection.
//
// ADR 0023 order: the engine asks the provider about the binding before it reads the body,
// so a body is never read for a caller whose database is rejected. The machine then emits its
// own `checkBinding` for that same binding; the executor answers that one effect with the
// outcome it already has (`checked`), so the provider is asked once per request, as before.
// The cache is consumed by the first `checkBinding` whatever it names; that one when it does
// not match (another binding, a deadline), and every later one, calls the provider.
import { EngineError, internalError, operationError } from "./errors.ts";
import { checkDatabaseBinding, databaseTransportFactory, noteReadCap, sameDatabaseBinding } from "./database.ts";
import { runtimeLimits } from "./limits.ts";
import type { DatabaseBinding, DatabaseProvider } from "./database.ts";
import { parseExact, stringifyExact } from "./exact-json.ts";
import { checkBatch, decodeArgs, directCommitFailureClass, directFailureClass, encodeResults, entropyHex, executeFailedEvent, observeCost } from "./step-effects.ts";
import type { CostCatalog } from "./engine-config.ts";
import { runInBackground } from "./transaction-owner-port.ts";
import type { BackgroundTasks, OwnerReply, TransactionOwnerHandle } from "./transaction-owner-port.ts";
import type { ExecutionTraceSink } from "./types.ts";

export type RequestStepDependencies = {
  getRuntime: () => any;
  database: DatabaseProvider;
  costCatalog?: Readonly<CostCatalog>;
  /** The owner handle for a name the machine forwards to (validated by the engine). */
  owner: (name: string) => TransactionOwnerHandle;
  executionTrace?: { enabled: boolean; sink?: ExecutionTraceSink };
};

export type RequestStepContext = {
  requestId: string;
  /** The binding the engine's provider call allowed for this request. */
  checked: DatabaseBinding;
  /** The runtime's per-value byte limit, read before the body (a misconfigured runtime is 500). */
  maxBytes: number;
  background?: BackgroundTasks;
};

const internalReply = (): OwnerReply => ({ ok: false, error: operationError(internalError()) });

const publishTrace = async (trace: any, sink: ExecutionTraceSink | undefined) => {
  if (!sink) return;
  try {
    await sink(trace);
  } catch (error) {
    console.log(JSON.stringify({
      event: "execution_trace_sink_failed",
      requestId: trace?.requestId,
      internalClass: (error as { constructor?: { name?: string } })?.constructor?.name ?? "UnknownError",
    }));
  }
};

/**
 * The machine's reply as plain data. Its results went through core's validation; an integer
 * beyond 2^53 - 1 in them becomes a JavaScript number, as every result of before did (the
 * public response is written with `JSON.stringify`).
 */
const plainReply = (reply: unknown): OwnerReply => JSON.parse(stringifyExact(reply));

/** Runs one `request` event and every effect it leads to; resolves with the reply. */
export const runRequestStep = async (
  dependencies: RequestStepDependencies,
  operation: Record<string, unknown>,
  context: RequestStepContext,
): Promise<OwnerReply> => {
  const { requestId, maxBytes } = context;
  const runtime = dependencies.getRuntime();
  let volatile: string | null = null;
  let connection: any = null;
  let checked: DatabaseBinding | null = context.checked;
  let reply: OwnerReply | null = null;

  const closeConnection = () => {
    const open = connection;
    connection = null;
    if (open?.open) open.rollback().catch(() => undefined);
  };

  const step = (event: unknown) => {
    const host = JSON.stringify({ nowMs: Date.now(), entropy: entropyHex(), requestId, owner: null });
    const output = parseExact(runtime.step_json(undefined, volatile ?? undefined, stringifyExact(event), host));
    if (output.error) throw new EngineError(output.error.code, output.error.message);
    volatile = output.volatile;
    if (volatile === null) closeConnection();
    return output;
  };

  const perform = async (effect: any) => {
    const { id } = effect;
    switch (effect.type) {
      case "checkBinding":
        {
          // Only the first `checkBinding` of the request may be answered by the engine's own
          // provider call (made before the body was read), and only when it names the same
          // binding with no deadline. The cache is consumed either way, so no later check can
          // ever be answered from it.
          const cached = checked;
          checked = null;
          if (cached !== null && effect.deadlineMs == null && sameDatabaseBinding(effect.binding, cached)) {
            return { type: "bindingChecked", id, allowed: true };
          }
        }
        try {
          await checkDatabaseBinding(dependencies.database, effect.binding, effect.binding?.snapshot, effect.deadlineMs ?? undefined);
          return { type: "bindingChecked", id, allowed: true };
        } catch (error) {
          const errorClass = directFailureClass(error);
          return errorClass === "rejected" ? { type: "bindingChecked", id, allowed: false } : { type: "bindingCheckFailed", id, class: errorClass };
        }
      case "open":
        try {
          closeConnection();
          noteReadCap(dependencies.database, runtimeLimits(runtime).maxResultBytes);
          const factory = databaseTransportFactory(dependencies.database, effect.binding, maxBytes);
          const transport = await factory(requestId, effect.deadlineMs);
          connection = await transport.begin(effect.mode, effect.timeoutMs);
          return { type: "opened", id };
        } catch (error) {
          return { type: "openFailed", id, class: directFailureClass(error) };
        }
      case "execute":
        try {
          if (!connection) throw new EngineError("POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
          if (effect.trace) await publishTrace(effect.trace, dependencies.executionTrace?.sink);
          const results = await connection.execute(effect.statements.map((statement: any) => ({
            sql: statement.sql,
            args: decodeArgs(statement.args, maxBytes),
          })), { maxResponseBytes: effect.maxResponseBytes });
          return { type: "executed", id, results: encodeResults(results, maxBytes) };
        } catch (error) {
          return executeFailedEvent(id, error, directFailureClass);
        }
      case "commit": {
        const open = connection;
        connection = null;
        try {
          if (!open) throw new EngineError("POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
          await open.commit();
        } catch (error) {
          // The machine rolls the connection back next (harmless if COMMIT applied).
          connection = open;
          return { type: "commitFailed", id, class: directCommitFailureClass(error) };
        }
        const usage: any[] = Array.isArray(open.usage) ? open.usage : [];
        console.log(JSON.stringify({
          event: "database_usage",
          requestId,
          rowsRead: usage.reduce((sum, item) => sum + item.rowsRead, 0),
          rowsWritten: usage.reduce((sum, item) => sum + item.rowsWritten, 0),
          queryDurationMs: usage.reduce((sum, item) => sum + item.queryDurationMs, 0),
        }));
        return { type: "committed", id };
      }
      case "rollback":
        try {
          await connection?.rollback();
          return { type: "rolledBack", id };
        } catch (error) {
          return { type: "rollbackFailed", id, class: directFailureClass(error) };
        } finally {
          connection = null;
        }
      case "forward":
        try {
          const handle = dependencies.owner(effect.owner);
          return { type: "ownerReplied", id, reply: await handle.atomic(effect.input, requestId) };
        } catch {
          return { type: "forwardFailed", id, class: "unavailable" };
        }
      default:
        // An effect the engine does not run (persist, timers, validators belong to owners).
        throw new Error(`unknown effect ${effect.type}`);
    }
  };

  let next: unknown = { type: "request", operation };
  try {
    while (next) {
      const output = step(next);
      next = null;
      checkBatch(output.effects);
      for (const effect of output.effects) {
        switch (effect.type) {
          case "respond":
            reply = plainReply(effect.reply);
            break;
          case "log":
            try { console.log(stringifyExact(effect.record)); } catch { /* a log write never fails the request */ }
            break;
          case "observe":
            runInBackground(context.background, observeCost(effect, {
              getRuntime: dependencies.getRuntime, database: dependencies.database, costCatalog: dependencies.costCatalog,
            }), requestId);
            break;
          case "reset":
            closeConnection();
            volatile = null;
            break;
          default:
            next = await perform(effect);
        }
      }
    }
  } catch {
    // Invalid host facts or an engine fault: Abandon with the previous state, then 500.
    try { step({ type: "abandon" }); } catch { /* discarded below */ }
    closeConnection();
    return internalReply();
  }
  closeConnection();
  return reply ?? internalReply();
};
