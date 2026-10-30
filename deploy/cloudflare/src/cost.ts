import { EngineError } from "./errors.ts";
import { databaseRequired } from "./database.ts";
import { driverArgs } from "./driver-values.ts";
import { bytesLimit } from "./binary.ts";
import type { CostCatalog } from "./engine-config.ts";

const invalidPlanner = () =>
  new EngineError("POLICYSQL_COST_UNKNOWN", "The query cost could not be bounded safely.");

// The wrapper supplies the catalog in `PolicySqlConfig.costCatalog`, validated at
// construction (ADR 0021). An absent catalog means cost cannot be bounded.
const requireCatalog = (catalog: Readonly<CostCatalog> | undefined) => {
  if (catalog === undefined) throw invalidPlanner();
  return catalog;
};

const details = (result) => result.rows.map((row) => {
  const index = result.columns.indexOf("detail");
  const value = row?.[index] ?? row?.detail;
  if (typeof value !== "string") throw invalidPlanner();
  return value;
});

const evaluate = (compiled, catalog, planned, results) => {
  const output = compiled.statements.map((statement) => ({
    lowerRowsRead: 0,
    expectedRowsRead: 0,
    upperRowsRead: 0,
    lowerRowsWritten: statement.operation === "insert" ? 1 : 0,
    expectedRowsWritten: statement.operation === "insert" ? 1 : 0,
    upperRowsWritten: statement.operation === "insert" ? 1 : 0,
    confidence: "conservative",
    access: statement.operation === "insert" ? "none" : "unknown",
    temporaryBTree: null,
    planSteps: 0,
    planner: "sqlite-explain-query-plan",
  }));
  for (const [resultIndex, result] of results.entries()) {
    const index = planned[resultIndex].index;
    const statement = compiled.statements[index];
    const plan = details(result);
    if (statement.explain.resource === null || statement.explain.resource === undefined) continue;
    const resource = catalog.resources[String(statement.explain.resource)];
    if (!resource) throw invalidPlanner();
    const upperRowsRead = resource.upperRows;
    if (upperRowsRead > catalog.maxEstimatedRowsRead) {
      throw new EngineError("POLICYSQL_USAGE_BUDGET_EXCEEDED", "The query exceeds the configured usage budget.");
    }
    // SQLite explicitly does not guarantee the format of EXPLAIN QUERY PLAN's `detail` text.
    // Record only the structured row count and keep catalog bounds conservative; never derive a
    // security or billing decision from text matching planner prose.
    const upperRowsWritten = statement.operation === "select" ? 0 : upperRowsRead;
    if (upperRowsWritten > catalog.maxEstimatedRowsWritten) {
      throw new EngineError("POLICYSQL_USAGE_BUDGET_EXCEEDED", "The query exceeds the configured usage budget.");
    }
    output[index] = {
      ...output[index],
      expectedRowsRead: upperRowsRead,
      upperRowsRead,
      expectedRowsWritten: upperRowsWritten,
      upperRowsWritten,
      access: "unknown",
      temporaryBTree: null,
      planSteps: plan.length,
    };
  }
  return output;
};

// `maxBytes` is the runtime's max_bytes_per_value; cost queries bind the same values.
export const estimateSealedOnTransaction = async (compiled, costCatalog: Readonly<CostCatalog> | undefined, transaction, maxBytes: number) => {
  const catalog = requireCatalog(costCatalog);
  const planned = compiled.statements
    .map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => statement.operation !== "insert");
  const results = planned.length === 0
    ? []
    : await transaction.execute(planned.map(({ statement }) => ({
        sql: statement.costExplainSql,
        args: driverArgs(statement, maxBytes),
      })));
  return evaluate(compiled, catalog, planned, results);
};

export const estimateSealedEnvelope = async (
  compiled,
  costCatalog: Readonly<CostCatalog> | undefined,
  requestId,
  transportFactory: (...args: any[]) => any,
  maxBytes: number,
  timeoutMs: number,
) => {
  if (typeof transportFactory !== "function") throw databaseRequired();
  // A malformed injected limit is a wiring defect: fail before BEGIN, not as a 503.
  bytesLimit(maxBytes);
  // The runtime's `costTimeoutMs`; there is no default of this module's own.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("cost observation requires the runtime's positive timeout");
  }
  const catalog = requireCatalog(costCatalog);
  let transaction;
  try {
    const planned = compiled.statements
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => statement.operation !== "insert");
    let results = [];
    if (planned.length > 0) {
      const transport = await transportFactory(`${requestId}-cost`, Date.now() + timeoutMs);
      transaction = await transport.begin("read", timeoutMs);
      results = await transaction.execute(planned.map(({ statement }) => ({
        sql: statement.costExplainSql,
        args: driverArgs(statement, maxBytes),
      })));
      await transaction.commit();
    }
    const output = evaluate(compiled, catalog, planned, results);
    return {
      estimates: output,
      usage: transaction
        ? {
            rowsRead: transaction.usage.reduce((sum, usage) => sum + usage.rowsRead, 0),
            rowsWritten: transaction.usage.reduce((sum, usage) => sum + usage.rowsWritten, 0),
            queryDurationMs: transaction.usage.reduce(
              (sum, usage) => sum + usage.queryDurationMs,
              0,
            ),
          }
        : { rowsRead: 0, rowsWritten: 0, queryDurationMs: 0 },
    };
  } catch (error) {
    if (transaction?.open) {
      try { await transaction.rollback(); } catch { /* timeout is terminal */ }
    }
    if (error instanceof EngineError) throw error;
    console.log(JSON.stringify({
      event: "cost_admission_internal_failure",
      requestId,
      internalClass: error?.constructor?.name ?? "UnknownError",
    }));
    throw new EngineError("POLICYSQL_COST_ADMISSION_UNAVAILABLE", "Cost admission is temporarily unavailable.");
  }
};

export const observeCostEnvelope = async (
  compiled,
  costCatalog: Readonly<CostCatalog> | undefined,
  requestId,
  transportFactory: (...args: any[]) => any,
  maxBytes: number,
  timeoutMs: number,
) => {
  try {
    const observation = await estimateSealedEnvelope(compiled, costCatalog, requestId, transportFactory, maxBytes, timeoutMs);
    console.log(JSON.stringify({
      event: "cost_observation",
      requestId,
      estimates: observation.estimates,
      usage: observation.usage,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      event: "cost_observation_failed",
      requestId,
      code: typeof error?.code === "string" ? error.code : null,
    }));
  }
};
