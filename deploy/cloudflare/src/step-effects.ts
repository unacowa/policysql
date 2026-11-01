// The mechanism an executor of the transaction step machine needs (ADR 0024 "Effect execution
// contract"): adapter classes of failures, the driver codec between effects and the database
// port, and the background cost observation of an `observe` effect. Nothing here decides an
// outcome; core judges every class, row, and estimate.
import { CommitNotSentError, EngineError } from "./errors.ts";
import { databaseTransportFactory } from "./database.ts";
import type { DatabaseProvider } from "./database.ts";
import { driverArgs, rawDriverValue, rowValues } from "./driver-values.ts";
import { runtimeBytesLimit } from "./binary.ts";
import { runtimeLimits } from "./limits.ts";
import type { CostCatalog } from "./engine-config.ts";
import { stringifyExact } from "./exact-json.ts";
import { SqlComplexityError } from "./database-complexity.ts";

/** An outcome class core accepts (ADR 0024 "Events and host facts"). */
export type FailureClass = "timeout" | "unavailable" | "rejected" | "not_committed" | "unknown" | "limit" | "complex";

/**
 * The class of a database or provider failure on an owner: a query timeout is `timeout`, the
 * engine's own database codes map to their class (a result the transport could not carry over
 * a byte bound, `POLICYSQL_LIMIT_EXCEEDED`, is `limit`), anything else is `unknown`.
 */
export const failureClass = (error: unknown): FailureClass => {
  if (error instanceof SqlComplexityError) return "complex";
  const coded = error as { name?: unknown; code?: unknown };
  if (coded?.name === "QueryTimeoutError" || coded?.code === "QUERY_TIMEOUT") return "timeout";
  if (error instanceof EngineError) {
    if (error.code === "POLICYSQL_DATABASE_TIMEOUT") return "timeout";
    if (error.code === "POLICYSQL_DATABASE_UNAVAILABLE") return "unavailable";
    if (error.code === "POLICYSQL_DATABASE_BINDING_REJECTED") return "rejected";
    if (error.code === "POLICYSQL_LIMIT_EXCEEDED") return "limit";
  }
  return "unknown";
};

/**
 * The class of a database or provider failure on the engine's direct placement, as the
 * TypeScript direct path classified it before ADR 0024 pull request 8: a query timeout or the
 * engine's own timeout is `timeout`, a rejected binding `rejected`, anything else
 * `unavailable`. Core turns each class into its code.
 */
export const directFailureClass = (error: unknown): FailureClass => {
  const errorClass = failureClass(error);
  return errorClass === "unknown" ? "unavailable" : errorClass;
};

/**
 * The class of a failed `commit` effect on an owner: `not_committed` only for the failure the
 * transport raises before any byte of COMMIT is sent (#54), `unknown` for everything else (a
 * COMMIT error never proves that nothing committed, ADR 0007).
 */
export const commitFailureClass = (error: unknown): FailureClass =>
  (error instanceof CommitNotSentError ? "not_committed" : "unknown");

/**
 * The `executeFailed` event of a failed `execute` effect. A database complexity refusal is class
 * `complex` with the failed statement's index and a fixed cause name; a failure the database
 * reported with a code no class names carries that code (only the code) for core's
 * `database_error_unclassified` log. `classify` is the placement's class function.
 */
export const executeFailedEvent = (id: number, error: unknown, classify: (error: unknown) => FailureClass) => {
  if (error instanceof SqlComplexityError) {
    return { type: "executeFailed", id, class: "complex", statement: error.statement, cause: error.complexityCause };
  }
  const databaseCode = (error as { databaseCode?: unknown } | null | undefined)?.databaseCode;
  return {
    type: "executeFailed", id, class: classify(error),
    ...(typeof databaseCode === "string" ? { databaseCode } : {}),
  };
};

/** The same for the direct placement: any other failure is classified as `directFailureClass`. */
export const directCommitFailureClass = (error: unknown): FailureClass => {
  if (error instanceof CommitNotSentError) return "not_committed";
  // A complexity refusal is a statement outcome, never a COMMIT's (ADR 0027).
  const errorClass = directFailureClass(error);
  return errorClass === "complex" ? "unavailable" : errorClass;
};

const IMMEDIATE = new Set(["respond", "log", "observe", "reset"]);

/**
 * The batch rule (ADR 0024 "Effects"): any number of immediate effects, then at most one
 * awaited effect, last. Anything else is an engine fault (Abandon follows), checked before any
 * effect of the batch runs, so no outcome is ever dropped.
 */
export const checkBatch = (effects: unknown) => {
  if (!Array.isArray(effects)) throw new Error("step output without effects");
  const awaited = effects.flatMap((effect, index) => (IMMEDIATE.has(effect?.type) ? [] : [index]));
  if (awaited.length > 1 || (awaited.length === 1 && awaited[0] !== effects.length - 1)) {
    throw new Error("an awaited effect is not last in its batch");
  }
};

/** 32 fresh random bytes as hex: the `entropy` host fact of one step. */
export const entropyHex = () => [...crypto.getRandomValues(new Uint8Array(32))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The class of a validator call that produced no answer. */
export const validatorFailureClass = (error: unknown): FailureClass => {
  const name = (error as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable";
};

/**
 * An `execute` effect's arguments as the database port takes them: the private BLOB form is
 * decoded, and an integer beyond 2^53 - 1 stays the BigInt the exact parse produced (#70), so
 * the transport binds the digits core wrote.
 */
export const decodeArgs = (args: Record<string, unknown>, maxBytes: number) => {
  const entries = Object.entries(args ?? {});
  const exact = entries.filter(([, value]) => typeof value === "bigint");
  const rest = Object.fromEntries(entries.filter(([, value]) => typeof value !== "bigint"));
  return { ...driverArgs(rest, maxBytes), ...Object.fromEntries(exact) };
};

/**
 * The raw results of an `executed` event: each driver value in the private ABI form, or the
 * `invalid` marker core rejects (a value the codec could not carry).
 */
export const encodeResults = (results: any[], maxBytes: number) => results.map((result) => ({
  columns: result.columns,
  rows: result.rows.map((row) => rowValues(result.columns, row).map((value) => {
    try { return rawDriverValue(value, maxBytes); } catch (error) {
      return { type: "invalid", limit: (error as { code?: unknown })?.code === "POLICYSQL_LIMIT_EXCEEDED" };
    }
  })),
  rowsAffected: Number(result.rowsAffected ?? 0),
  usage: result.usage,
}));

/**
 * Runs an `observe` effect in the background: the cost statements on a separate read
 * connection (`${requestId}-cost`, the runtime's `costTimeoutMs`), evaluated by core's
 * `cost_estimate_json`, logged as `cost_observation` or `cost_observation_failed`. It never
 * affects a reply.
 */
export const observeCost = async (
  effect: { statements: Array<{ sql: string; args: Record<string, unknown> }>; context: any; maxResponseBytes: number },
  { getRuntime, database, costCatalog }: { getRuntime: () => any; database: DatabaseProvider; costCatalog?: Readonly<CostCatalog> },
) => {
  const requestId = `${effect.context.requestId}-cost`;
  const runtime = getRuntime();
  const maxBytes = runtimeBytesLimit(runtime);
  const { costTimeoutMs } = runtimeLimits(runtime);
  const catalog = costCatalog ?? null;
  let transaction;
  let results = [];
  try {
    if (catalog !== null && effect.statements.length > 0) {
      const factory = databaseTransportFactory(database, effect.context.binding, maxBytes);
      const transport = await factory(requestId, Date.now() + costTimeoutMs);
      transaction = await transport.begin("read", costTimeoutMs);
      results = await transaction.execute(effect.statements.map((statement) => ({
        sql: statement.sql, args: decodeArgs(statement.args, maxBytes),
      })), { maxResponseBytes: effect.maxResponseBytes });
      await transaction.commit();
    }
  } catch (error) {
    if (transaction?.open) await transaction.rollback().catch(() => undefined);
    const code = (error as { code?: unknown })?.code;
    console.log(JSON.stringify({
      event: "cost_observation_failed", requestId, code: typeof code === "string" ? code : "POLICYSQL_COST_ADMISSION_UNAVAILABLE",
    }));
    return;
  }
  const output = JSON.parse(runtime.cost_estimate_json(stringifyExact({
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
};
