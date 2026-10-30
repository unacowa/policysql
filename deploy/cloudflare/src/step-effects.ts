// The mechanism an executor of the transaction step machine needs (ADR 0024 "Effect execution
// contract"): adapter classes of failures, the driver codec between effects and the database
// port, and the background cost observation of an `observe` effect. Nothing here decides an
// outcome; core judges every class, row, and estimate.
import { EngineError } from "./errors.ts";
import { databaseTransportFactory } from "./database.ts";
import type { DatabaseProvider } from "./database.ts";
import { driverArgs, rawDriverValue, rowValues } from "./driver-values.ts";
import { runtimeBytesLimit } from "./binary.ts";
import { runtimeLimits } from "./limits.ts";
import type { CostCatalog } from "./engine-config.ts";
import { stringifyExact } from "./exact-json.ts";

/** An outcome class core accepts (ADR 0024 "Events and host facts"). */
export type FailureClass = "timeout" | "unavailable" | "rejected" | "not_committed" | "unknown" | "limit";

/**
 * The class of a database or provider failure on an owner: a query timeout is `timeout`, the
 * engine's own database codes map to their class (a result the transport could not carry over
 * a byte bound, `POLICYSQL_LIMIT_EXCEEDED`, is `limit`), anything else is `unknown`.
 */
export const failureClass = (error: unknown): FailureClass => {
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
  return { ...driverArgs({ clientParameters: rest, serverParameters: {} }, maxBytes), ...Object.fromEntries(exact) };
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
  effect: { statements: Array<{ sql: string; args: Record<string, unknown> }>; context: any },
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
      })));
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
