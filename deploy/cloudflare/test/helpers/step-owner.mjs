// A test-only effect executor for the transaction step machine (ADR 0024 pull requests 4-6).
// TEST ONLY: no production path uses the machine before the switch-over (pull request 7).
//
// `StepOwnerCore` has the owner-side shape of `TransactionOwnerCore` (the same facilities and
// ports), but makes no decision: every client command, callback query, timer, and effect
// outcome is one call of `runtime.step_json`, and the executor only runs the effects it
// returns, in order (ADR 0024 "Effect execution contract"):
//
// 1. call `step_json` with the current state, the event, and fresh host facts, and keep the
//    returned state as current;
// 2. run immediate effects (`respond`, `log`, `observe`, `reset`) without awaiting them;
// 3. run the awaited effect, map its outcome (or exception) to exactly one outcome event with
//    a class, and go to 1.
//
// Client commands run one at a time on the client lane and callback queries one at a time on
// the callback lane, as in `TransactionOwnerCore`; `onTimer` is fed immediately. A lane's
// caller gets its reply as soon as a `respond` effect for that lane runs (a commit that waits
// on its validator is answered at expiry), while the lane's effects run to completion before
// its next event. Unlike `TransactionOwnerCore`, every command carries the session (`auth`)
// and the verified body text (`bodyText`) the engine would forward (#70), and so does a
// callback query: the machine compiles and hashes that text, never a re-serialization.
//
// `callValidator` runs through the real hook adapter (`callCommitCheckHook`, which adds the
// `query` block and signs), with the endpoint and secret looked up by check id in the
// validated configuration; the host facts' `configuredChecks` are the configured ids when the
// configuration has a `publicBaseUrl` (ADR 0021).
import { EngineError } from "../../src/errors.ts";
import { checkDatabaseBinding, databaseTransportFactory } from "../../src/database.ts";
import { driverArgs, rawDriverValue, rowValues } from "../../src/driver-values.ts";
import { runtimeBytesLimit } from "../../src/binary.ts";
import { validateConfig } from "../../src/engine-config.ts";
import { callCommitCheckHook } from "../../src/adapters/commit-check-hook.ts";

const KEY = "transaction";

/** The adapter class of a database or provider failure (`turso.ts` `remoteFailure` rules). */
export const failureClass = (error) => {
  if (error?.name === "QueryTimeoutError" || error?.code === "QUERY_TIMEOUT") return "timeout";
  if (error instanceof EngineError) {
    if (error.code === "POLICYSQL_DATABASE_TIMEOUT") return "timeout";
    if (error.code === "POLICYSQL_DATABASE_UNAVAILABLE") return "unavailable";
    if (error.code === "POLICYSQL_DATABASE_BINDING_REJECTED") return "rejected";
  }
  return "unknown";
};

/** The class of a validator call that produced no answer. */
const validatorFailureClass = (error) =>
  error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "unavailable";

// Integers beyond 2^53 - 1 keep their exact digits from the step output (BigInt).
const parseExact = (text) => JSON.parse(text, (_key, value, context) =>
  typeof value === "number" && !Number.isSafeInteger(value) && /^-?\d+$/u.test(context?.source ?? "")
    ? BigInt(context.source) : value);

// The driver codec, with integers beyond 2^53 - 1 passed as BigInt (the step output keeps
// their digits; `driverArgs` decodes everything else, BLOBs included).
const decodeArgs = (args, maxBytes) => {
  const exact = Object.entries(args).filter(([, value]) => typeof value === "bigint");
  const rest = Object.fromEntries(Object.entries(args).filter(([, value]) => typeof value !== "bigint"));
  return { ...driverArgs({ clientParameters: rest, serverParameters: {} }, maxBytes), ...Object.fromEntries(exact) };
};

const randomHex = () => [...crypto.getRandomValues(new Uint8Array(32))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

const internalReply = () => ({ ok: false, error: { code: "POLICYSQL_INTERNAL", message: "The request could not be completed.", path: null } });

/** The re-check at the outbound exit (`commit-checks.ts` `secureUrl`). */
const secureUrl = (raw) => {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("insecure validator URL");
  return url;
};

export class StepOwnerCore {
  /**
   * `name` is the owner name the adapter routes to; `dependencies` are `getRuntime`,
   * `database`, `config`, and `fetchImpl`, as for `TransactionOwnerCore`.
   */
  constructor(facilities, { getRuntime, database, config = { environment: "test" }, fetchImpl = undefined }, name) {
    this.facilities = facilities;
    this.getRuntime = getRuntime;
    this.database = database;
    this.config = validateConfig(config);
    this.configuredChecks = this.config.publicBaseUrl === undefined ? [] : Object.keys(config.commitChecks ?? {});
    this.fetchImpl = fetchImpl;
    this.name = name;
    this.loaded = false;
    this.durable = null;
    this.volatile = null;
    this.transaction = null;
    this.queue = Promise.resolve();
    this.callbackQueue = Promise.resolve();
    this.waiters = { client: null, callback: null };
    /** Every step: the four inputs and the output text (a transcript, ADR 0024). */
    this.transcript = [];
    /** Replies the machine sent with no caller waiting on that lane (must stay empty). */
    this.unrouted = [];
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.facilities.store.get(KEY);
    // Records of `TransactionOwnerCore` are objects: the machine reads them as JSON and
    // discards them (no `v`).
    this.durable = stored === undefined ? null : typeof stored === "string" ? stored : JSON.stringify(stored);
    this.volatile = null;
    this.loaded = true;
  }

  step(event, requestId) {
    const host = JSON.stringify({
      nowMs: Date.now(), entropy: randomHex(), requestId, owner: this.name, configuredChecks: this.configuredChecks,
    });
    const eventText = JSON.stringify(event);
    const outputText = this.getRuntime().step_json(this.durable ?? undefined, this.volatile ?? undefined, eventText, host);
    this.transcript.push({ durable: this.durable, volatile: this.volatile, event: eventText, host, output: outputText });
    const output = parseExact(outputText);
    if (output.error) throw new EngineError(output.error.code, output.error.message);
    this.durable = output.durable;
    this.volatile = output.volatile;
    if (output.volatile === null) this.transaction = null;
    return output;
  }

  /** Runs one event and every effect it leads to. */
  async drive(event, requestId) {
    let next = event;
    while (next) {
      // A `reset` on another lane drops the state: reload it, as a successor would.
      await this.load();
      const output = this.step(next, requestId);
      next = null;
      for (const effect of output.effects) {
        switch (effect.type) {
          case "respond": {
            const lane = effect.lane === "callback" ? "callback" : "client";
            const waiter = this.waiters[lane];
            this.waiters[lane] = null;
            if (waiter) waiter(effect.reply); else this.unrouted.push({ lane, reply: effect.reply });
            break;
          }
          case "log":
            console.log(JSON.stringify(effect.record));
            break;
          case "observe":
            // Cost observation runs in the background; the engine-side executor
            // (step-engine.mjs) runs it through `cost_estimate_json`. This owner-side executor
            // does not (TransactionOwnerCore observes before its commit checks, so the owner
            // path's observations are not compared).
            break;
          case "reset":
            this.reset();
            break;
          default:
            next = await this.perform(effect, output, requestId);
        }
      }
    }
  }

  reset() {
    const transaction = this.transaction;
    this.transaction = null;
    if (transaction?.open) transaction.rollback().catch(() => undefined);
    this.loaded = false;
    this.durable = null;
    this.volatile = null;
  }

  async perform(effect, output, requestId) {
    const { id } = effect;
    const runtime = this.getRuntime();
    switch (effect.type) {
      case "checkBinding":
        try {
          await checkDatabaseBinding(this.database, effect.binding, effect.binding.snapshot, effect.deadlineMs);
          return { type: "bindingChecked", id, allowed: true };
        } catch (error) {
          const errorClass = failureClass(error);
          return errorClass === "rejected" ? { type: "bindingChecked", id, allowed: false } : { type: "bindingCheckFailed", id, class: errorClass };
        }
      case "open":
        try {
          const factory = databaseTransportFactory(this.database, effect.binding, runtimeBytesLimit(runtime), effect.deadlineMs);
          const transport = await factory(requestId);
          this.transaction = await transport.begin(effect.mode, effect.timeoutMs);
          return { type: "opened", id };
        } catch (error) {
          return { type: "openFailed", id, class: failureClass(error) };
        }
      case "execute":
        try {
          const maxBytes = runtimeBytesLimit(runtime);
          const results = await this.transaction.execute(effect.statements.map((statement) => ({
            sql: statement.sql,
            args: decodeArgs(statement.args, maxBytes),
          })));
          return {
            type: "executed",
            id,
            results: results.map((result) => ({
              columns: result.columns,
              rows: result.rows.map((row) => rowValues(result.columns, row).map((value) => {
                try { return rawDriverValue(value, maxBytes); } catch (error) {
                  return { type: "invalid", limit: error?.code === "POLICYSQL_LIMIT_EXCEEDED" };
                }
              })),
              rowsAffected: Number(result.rowsAffected ?? 0),
              usage: result.usage,
            })),
          };
        } catch (error) {
          return { type: "executeFailed", id, class: failureClass(error) };
        }
      case "commit":
        try {
          await this.transaction.commit();
          return { type: "committed", id };
        } catch {
          // A COMMIT error never proves that nothing committed (ADR 0007).
          return { type: "commitFailed", id, class: "unknown" };
        }
      case "rollback":
        try {
          await this.transaction?.rollback();
          return { type: "rolledBack", id };
        } catch (error) {
          return { type: "rollbackFailed", id, class: failureClass(error) };
        }
      case "setTimer":
        try {
          await this.facilities.timer.schedule(effect.atMs);
          return { type: "timerSet", id };
        } catch {
          return { type: "timerFailed", id };
        }
      case "persist":
        try {
          // The durable text returned by the step that emitted this effect.
          await this.facilities.store.put(KEY, output.durable);
          return { type: "persisted", id };
        } catch {
          return { type: "persistFailed", id };
        }
      case "callValidator": {
        // The endpoint and secret are looked up by check id; core never sees them. The hook
        // adapter adds `query` (token, callback URL, expiry) and signs.
        const endpoint = this.config.commitCheck(effect.check);
        let url;
        let publicBaseUrl;
        try {
          if (endpoint === undefined || this.config.publicBaseUrl === undefined) throw new TypeError("unconfigured");
          url = secureUrl(endpoint.url);
          publicBaseUrl = secureUrl(this.config.publicBaseUrl);
          if (typeof endpoint.hmacSecret !== "string" || endpoint.hmacSecret.length < 16) throw new TypeError("secret");
        } catch {
          return { type: "validatorFailed", id, class: "rejected" };
        }
        try {
          const reply = await callCommitCheckHook({
            url,
            hmacSecret: endpoint.hmacSecret,
            publicBaseUrl,
            validationId: effect.payload.validationId,
            payload: effect.payload,
            capability: effect.capability,
            timeoutMs: effect.timeoutMs,
            fetchImpl: this.fetchImpl,
          });
          return { type: "validatorReplied", id, ok: reply.ok, decision: reply.decision ?? null };
        } catch (error) {
          return { type: "validatorFailed", id, class: validatorFailureClass(error) };
        }
      }
      default:
        throw new Error(`unknown effect ${effect.type}`);
    }
  }

  /**
   * Runs `event` on `lane` (`client` or `callback`) after the lane's previous event has run
   * all its effects, and resolves with the lane's reply as soon as the machine sends it.
   */
  lane(lane, event, requestId) {
    const queue = lane === "client" ? "queue" : "callbackQueue";
    let resolveReply;
    const reply = new Promise((resolve) => { resolveReply = resolve; });
    const run = this[queue].then(async () => {
      this.waiters[lane] = resolveReply;
      try {
        await this.drive(event, requestId);
      } catch {
        // Invalid host facts or an engine fault: 500, then Abandon with the previous state.
        try { await this.drive({ type: "abandon" }, requestId); } catch { /* discarded */ }
        if (this.waiters[lane] === resolveReply) {
          this.waiters[lane] = null;
          resolveReply(internalReply());
        }
      }
      // Every event is answered by the step that decides it.
      if (this.waiters[lane] === resolveReply) {
        this.waiters[lane] = null;
        this.unrouted.push({ lane, reply: "no reply" });
        resolveReply(internalReply());
      }
    });
    this[queue] = run.catch(() => undefined);
    return reply;
  }

  begin(input, requestId) {
    const { authFingerprint: _computedByCore, ...fields } = input;
    return this.lane("client", { type: "forwarded", input: { kind: "begin", ...fields } }, requestId);
  }

  /** `input` is the owner command plus the session (`auth`) and verified text (`bodyText`). */
  command(kind, input, requestId) {
    return this.lane("client", {
      type: "forwarded",
      input: {
        kind, transactionId: input.transactionId, auth: input.auth, command: input.bodyText,
        databaseBinding: input.databaseBinding, snapshot: input.snapshot,
      },
    }, requestId);
  }

  /**
   * `input` is the machine's own forwarded atomic input (`{ kind: "atomic", validationId, auth,
   * request, databaseBinding, snapshot, idempotency? }`, from a `forward` effect of the engine
   * side, test/helpers/step-engine.mjs), whose `request` is the verified body text (#70).
   */
  atomic(input, requestId) {
    return this.lane("client", { type: "forwarded", input }, requestId);
  }

  /** `input` is `{ validationId, capability, bodyText }`: the verified callback text (#70). */
  callbackQuery(input, requestId) {
    return this.lane("callback", {
      type: "forwarded",
      input: {
        kind: "callbackQuery", validationId: input.validationId,
        capability: typeof input.capability === "string" ? input.capability : "", command: input.bodyText,
      },
    }, requestId);
  }

  /** Resolves once both lanes have run every effect of every event they were given. */
  async settled() {
    let lanes;
    do {
      lanes = [this.queue, this.callbackQueue];
      await Promise.all(lanes);
    } while (lanes[0] !== this.queue || lanes[1] !== this.callbackQueue);
  }

  /** Called by the adapter when this owner's timer fires; not queued behind either lane. */
  async onTimer() {
    await this.load();
    await this.drive({ type: "timerFired" }, crypto.randomUUID());
  }
}
