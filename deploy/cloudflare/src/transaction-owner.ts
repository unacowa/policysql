// The transaction owner (ADR 0007, ADR 0022) as an executor of core's step machine (ADR 0024
// pull request 7). It makes no decision that the specification determines: every client
// command, callback query, timer, and effect outcome is one call of `runtime.step_json`, and
// the owner runs the effects it returns, in order ("Effect execution contract"):
//
// 1. call `step_json` with the current durable and volatile texts, the event, and fresh host
//    facts (time, entropy, request id, owner name, configured checks); keep the returned
//    texts in memory as current, verbatim (never a JavaScript round trip);
// 2. run the immediate effects (`respond`, `log`, `observe`, `reset`) without awaiting them;
// 3. run the awaited effect, which is last, map its outcome or exception to exactly one
//    outcome event with the effect's id and a class, and go to 1.
//
// Client commands run one at a time on the client lane, callback queries one at a time on the
// callback lane, and a timer is fed at once. A lane's caller gets its reply as soon as a
// `respond` for that lane runs (a commit waiting on its validator is answered at expiry),
// while the lane's effects run to completion before its next event.
//
// The owner holds the database connection the machine opened. Whenever the machine drops its
// volatile state (`reset`, `abandon`, a discarded record, the end of a transaction) the owner
// closes that connection and drops every reference to it: `reset` and the fail-closed paths
// emit no `rollback` effect (ADR 0024 pull request 4 obligation).
//
// Atomic executions on an owner (an execute whose envelope could trigger a commit check) run
// the same machine since ADR 0024 pull request 8: the engine's `request` step forwards the
// owner input, and the owner's step answers it. An unreadable record is discarded by the
// machine (an atomic input ignores it and resolves a keyed retry through
// `policysql_idempotency`).
import { EngineError, operationError } from "./errors.ts";
import { checkDatabaseBinding, databaseTransportFactory, validateDatabaseProvider } from "./database.ts";
import type { DatabaseProvider } from "./database.ts";
import type { OutboundFetch } from "./redirects.ts";
import { runtimeBytesLimit } from "./binary.ts";
import { validateConfig } from "./engine-config.ts";
import type { PolicySqlConfig, ValidatedConfig } from "./engine-config.ts";
import { callCommitCheckHook } from "./adapters/commit-check-hook.ts";
import { parseExact, stringifyExact } from "./exact-json.ts";
import { checkBatch, decodeArgs, commitFailureClass, encodeResults, entropyHex, failureClass, observeCost, validatorFailureClass } from "./step-effects.ts";
import { OWNER_NAME, runInBackground, validateOwnerFacilities } from "./transaction-owner-port.ts";
import type {
  OwnerAtomicInput, OwnerBeginInput, OwnerCallbackInput, OwnerCommandInput, OwnerCommandKind,
  OwnerFacilities, OwnerReply, TransactionOwnerHandle,
} from "./transaction-owner-port.ts";

/** What a transaction owner needs. It receives the same `config` as `createApp` (ADR 0021). */
export type TransactionOwnerDependencies = {
  getRuntime: () => any;
  database: DatabaseProvider;
  config: PolicySqlConfig;
  /** Omitted: commit-check calls use the host fetch through fetchNoFollow. */
  fetchImpl?: OutboundFetch;
};

export { checkBatch } from "./step-effects.ts";

const KEY = "transaction";
type Lane = "client" | "callback";

const internalReply = (): OwnerReply => ({
  ok: false, error: operationError(new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.")),
});

const replyRequestId = (requestId: unknown) =>
  typeof requestId === "string" && requestId !== "" ? requestId : crypto.randomUUID();

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The forwarded input of `kind`: the handle's input with the kind its method names. */
const forwarded = (kind: string, input: unknown) => {
  const { kind: _ignored, ...fields } = isObject(input) ? input : {};
  return { type: "forwarded", input: { kind, ...fields } };
};

/** The owner an input names: its transaction id, or `tx_` and the hex of its validation id. */
const namedOwner = (input: unknown): string | null => {
  if (!isObject(input)) return null;
  const id = typeof input.transactionId === "string" ? input.transactionId
    : typeof input.validationId === "string" ? input.validationId.replace(/^cval_/u, "tx_") : null;
  return id !== null && OWNER_NAME.test(id) ? id : null;
};

/** The owner a stored record names, so a timer can run before any message arrived. */
const recordOwner = (stored: unknown): string | null => {
  let value = stored;
  if (typeof stored === "string") {
    try { value = JSON.parse(stored); } catch { return null; }
  }
  if (!isObject(value)) return null;
  const name = typeof value.owner === "string" ? value.owner : value.transactionId;
  return typeof name === "string" && OWNER_NAME.test(name) ? name : null;
};

/** The re-check of a validator endpoint at the outbound exit: `https:`, no credentials. */
const secureUrl = (raw: string) => {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("insecure validator URL");
  return url;
};

/**
 * The owner of one transaction name (ADR 0007, ADR 0022, ADR 0024). An adapter creates one
 * instance per live owner, injects its durable store, timer, and background tasks, and
 * delivers every call for that name to it. Every input (begin, statement, commit, rollback,
 * atomic, callback query) and every timer runs the step machine.
 */
export class TransactionOwnerCore implements TransactionOwnerHandle {
  facilities: OwnerFacilities;
  config: ValidatedConfig;
  getRuntime: () => any;
  database: DatabaseProvider;
  fetchImpl?: OutboundFetch;
  configuredChecks: string[];
  /** The owner name; fixed for the instance's lifetime once known. */
  name: string | null;
  loaded: boolean;
  /** The durable and volatile texts the last step returned, kept verbatim. */
  durable: string | null;
  volatile: string | null;
  /** The open database transaction of the machine's connection, if any. */
  connection: any;
  queues: Record<Lane, Promise<unknown>>;
  waiters: Record<Lane, ((reply: OwnerReply) => void) | null>;
  /** When set to an array (tests), every step's four inputs and output text (ADR 0024 transcripts). */
  transcript: Array<Record<string, string | null>> | null;
  /** Replies the machine sent with no caller waiting on that lane (bounded; tests read it). */
  unrouted: Array<{ lane: string; reply: unknown }>;

  constructor(facilities: OwnerFacilities, dependencies: TransactionOwnerDependencies) {
    if (typeof dependencies?.getRuntime !== "function") throw new TypeError("getRuntime is required");
    validateDatabaseProvider(dependencies.database);
    // Validated before the owner can serve any request, so a bad setting never reaches I/O.
    this.config = validateConfig(dependencies.config);
    this.facilities = validateOwnerFacilities(facilities);
    this.getRuntime = dependencies.getRuntime;
    this.database = dependencies.database;
    this.fetchImpl = dependencies.fetchImpl;
    // The ids with an endpoint; none without a public base URL (ADR 0021).
    this.configuredChecks = this.config.publicBaseUrl === undefined
      ? [] : Object.keys(dependencies.config?.commitChecks ?? {}).filter((id) => this.config.commitCheck(id) !== undefined);
    this.name = this.facilities.name ?? null;
    this.loaded = false;
    this.durable = null;
    this.volatile = null;
    this.connection = null;
    this.queues = { client: Promise.resolve(), callback: Promise.resolve() };
    this.waiters = { client: null, callback: null };
    this.transcript = null;
    this.unrouted = [];
  }

  /**
   * The name the adapter routed a message to. The first one known is kept; a message routed
   * to another name is an adapter fault, which the caller answers with POLICYSQL_INTERNAL.
   */
  bindName(name: unknown): boolean {
    if (typeof name !== "string" || !OWNER_NAME.test(name)) return false;
    if (this.name === null) this.name = name;
    return this.name === name;
  }

  // ---- handle methods -------------------------------------------------------------------

  begin(input: OwnerBeginInput, requestId: string): Promise<OwnerReply> {
    return this.lane("client", input, forwarded("begin", input), requestId);
  }

  command(kind: OwnerCommandKind, input: OwnerCommandInput, requestId: string): Promise<OwnerReply> {
    // An unknown kind reaches the machine as such, which answers it as invalid.
    return this.lane("client", input, forwarded(typeof kind === "string" ? kind : "", input), requestId);
  }

  callbackQuery(input: OwnerCallbackInput, requestId: string): Promise<OwnerReply> {
    const fields: Record<string, unknown> = isObject(input) ? input : {};
    // A capability that is not a string is presented as none.
    const capability = typeof fields.capability === "string" ? fields.capability : "";
    return this.lane("callback", input, forwarded("callbackQuery", { ...fields, capability }), requestId);
  }

  atomic(input: OwnerAtomicInput, requestId: string): Promise<OwnerReply> {
    return this.lane("client", input, forwarded("atomic", input), requestId);
  }

  /** Called by the adapter when this owner's timer fires; not queued behind either lane. */
  async onTimer(): Promise<void> {
    if (this.name === null) {
      // A restarted owner learns its name from its record; with none, nothing can expire.
      this.name = recordOwner(await this.facilities.store.get(KEY));
      if (this.name === null) return;
    }
    try {
      await this.drive({ type: "timerFired" }, crypto.randomUUID());
    } catch {
      await this.abandon(crypto.randomUUID());
    }
  }

  /** Resolves once both lanes have run every effect of every event they were given. */
  async settled(): Promise<void> {
    let lanes: Array<Promise<unknown>>;
    do {
      lanes = [this.queues.client, this.queues.callback];
      await Promise.all(lanes);
    } while (lanes[0] !== this.queues.client || lanes[1] !== this.queues.callback);
  }

  // ---- the executor ---------------------------------------------------------------------

  /**
   * Runs `event` on `lane` after the lane's previous event ran all its effects, and resolves
   * with the lane's reply as soon as the machine sends it.
   */
  lane(lane: Lane, input: unknown, event: any, rawRequestId: string): Promise<OwnerReply> {
    const requestId = replyRequestId(rawRequestId);
    let resolveReply: (reply: OwnerReply) => void;
    const reply = new Promise<OwnerReply>((resolve) => { resolveReply = resolve; });
    const run = this.queues[lane].then(async () => {
      if (this.name === null) this.name = namedOwner(input);
      if (this.name === null) {
        // The adapter delivered a message without an owner name: a port fault.
        resolveReply(internalReply());
        return;
      }
      this.waiters[lane] = resolveReply;
      try {
        await this.drive(event, requestId);
      } catch {
        // Invalid host facts or an engine fault: Abandon with the previous state, then 500.
        await this.abandon(requestId);
        if (this.waiters[lane] === resolveReply) {
          this.waiters[lane] = null;
          resolveReply(internalReply());
        }
      }
      // Every event is answered by the step that decides it.
      if (this.waiters[lane] === resolveReply) {
        this.waiters[lane] = null;
        this.noteUnrouted(lane, "no reply");
        resolveReply(internalReply());
      }
    });
    this.queues[lane] = run.catch(() => undefined);
    return reply;
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.facilities.store.get(KEY);
    // A stored value that is not the machine's JSON text is passed on as text and discarded
    // as unreadable (ADR 0024 "Fail-closed rules").
    this.durable = stored === undefined || stored === null ? null : typeof stored === "string" ? stored : JSON.stringify(stored);
    this.volatile = null;
    this.loaded = true;
  }

  step(event: any, requestId: string) {
    const host = JSON.stringify({
      nowMs: Date.now(), entropy: entropyHex(), requestId, owner: this.name, configuredChecks: this.configuredChecks,
    });
    const eventText = stringifyExact(event);
    const outputText: string = this.getRuntime().step_json(this.durable ?? undefined, this.volatile ?? undefined, eventText, host);
    this.transcript?.push({ durable: this.durable, volatile: this.volatile, event: eventText, host, output: outputText });
    const output = parseExact(outputText);
    if (output.error) throw new EngineError(output.error.code, output.error.message);
    this.durable = output.durable;
    this.volatile = output.volatile;
    // No volatile part: the machine holds no connection. Close any the owner still has.
    if (output.volatile === null) this.closeConnection();
    return output;
  }

  closeConnection() {
    const connection = this.connection;
    this.connection = null;
    if (connection?.open) connection.rollback().catch(() => undefined);
  }

  /** Drops the in-memory state; the next event starts from the store, as a successor would. */
  reset() {
    this.closeConnection();
    this.loaded = false;
    this.durable = null;
    this.volatile = null;
  }

  /** `abandon` for the current state; its one `persist` runs before the state is dropped. */
  async abandon(requestId: string) {
    try { await this.drive({ type: "abandon" }, requestId); } catch { /* discarded below */ }
    this.reset();
  }

  noteUnrouted(lane: string, reply: unknown) {
    console.log(JSON.stringify({ event: "owner_reply_unrouted", transactionId: this.name, lane }));
    if (this.unrouted.length < 16) this.unrouted.push({ lane, reply });
  }

  /** Runs one event and every effect it leads to. */
  async drive(event: any, requestId: string) {
    let next = event;
    while (next) {
      // A `reset` on another lane dropped the state: reload it, as a successor would.
      await this.load();
      const output = this.step(next, requestId);
      next = null;
      checkBatch(output.effects);
      for (const effect of output.effects) {
        switch (effect.type) {
          case "respond": {
            const lane: Lane = effect.lane === "callback" ? "callback" : "client";
            const waiter = this.waiters[lane];
            this.waiters[lane] = null;
            if (waiter) waiter(effect.reply); else this.noteUnrouted(lane, effect.reply);
            break;
          }
          case "log":
            try { console.log(stringifyExact(effect.record)); } catch { /* a log write never fails the lane */ }
            break;
          case "observe":
            runInBackground(this.facilities.background, observeCost(effect, {
              getRuntime: this.getRuntime, database: this.database, costCatalog: this.config.costCatalog,
            }), requestId);
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

  async perform(effect: any, output: any, requestId: string) {
    const { id } = effect;
    const runtime = this.getRuntime();
    switch (effect.type) {
      case "checkBinding":
        try {
          await checkDatabaseBinding(this.database, effect.binding, effect.binding?.snapshot, effect.deadlineMs ?? undefined);
          return { type: "bindingChecked", id, allowed: true };
        } catch (error) {
          const errorClass = failureClass(error);
          return errorClass === "rejected" ? { type: "bindingChecked", id, allowed: false } : { type: "bindingCheckFailed", id, class: errorClass };
        }
      case "open":
        try {
          this.closeConnection();
          const factory = databaseTransportFactory(this.database, effect.binding, runtimeBytesLimit(runtime), effect.deadlineMs);
          const transport = await factory(requestId);
          this.connection = await transport.begin(effect.mode, effect.timeoutMs);
          return { type: "opened", id };
        } catch (error) {
          return { type: "openFailed", id, class: failureClass(error) };
        }
      case "execute":
        try {
          if (!this.connection) throw new EngineError("POLICYSQL_DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
          const maxBytes = runtimeBytesLimit(runtime);
          const results = await this.connection.execute(effect.statements.map((statement) => ({
            sql: statement.sql,
            args: decodeArgs(statement.args, maxBytes),
          })));
          return { type: "executed", id, results: encodeResults(results, maxBytes) };
        } catch (error) {
          return { type: "executeFailed", id, class: failureClass(error) };
        }
      case "commit":
        try {
          if (!this.connection) throw new Error("no connection");
          await this.connection.commit();
          return { type: "committed", id };
        } catch (error) {
          // A COMMIT error never proves that nothing committed (ADR 0007); only a failure the
          // transport raised before sending COMMIT is `not_committed` (#54).
          return { type: "commitFailed", id, class: commitFailureClass(error) };
        } finally {
          this.connection = null;
        }
      case "rollback":
        try {
          await this.connection?.rollback();
          return { type: "rolledBack", id };
        } catch (error) {
          return { type: "rollbackFailed", id, class: failureClass(error) };
        } finally {
          this.connection = null;
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
      case "callValidator":
        return await this.callValidator(effect);
      default:
        // An effect this executor does not know: an engine fault (Abandon follows).
        throw new Error(`unknown effect ${effect.type}`);
    }
  }

  async callValidator(effect: any) {
    const { id } = effect;
    // The endpoint and secret are looked up by check id; core never sees them. The hook
    // adapter adds `query` (token, callback URL, expiry) and signs.
    const endpoint = this.config.commitCheck(effect.check);
    let url: URL;
    let publicBaseUrl: URL;
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
}
