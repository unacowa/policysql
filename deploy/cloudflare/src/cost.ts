import { HttpError } from "./errors.ts";
import { TursoHttpTransport } from "./turso-http.ts";

const invalidPlanner = () =>
  new HttpError(403, "POLICYSQL_COST_UNKNOWN", "The query cost could not be bounded safely.");

const parseCatalog = (env) => {
  let value;
  try {
    value = JSON.parse(env.POLICYSQL_COST_CATALOG_JSON);
  } catch {
    throw invalidPlanner();
  }
  if (
    !value ||
    !Number.isSafeInteger(value.maxEstimatedRowsRead) ||
    value.maxEstimatedRowsRead <= 0 ||
    !Number.isSafeInteger(value.maxEstimatedRowsWritten) ||
    value.maxEstimatedRowsWritten <= 0 ||
    !value.resources ||
    Object.values(value.resources).some(
      (item: any) => !Number.isSafeInteger(item?.upperRows) || item.upperRows <= 0,
    )
  ) throw invalidPlanner();
  return value;
};

const args = (statement) => ({ ...statement.clientParameters, ...statement.serverParameters });

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
      throw new HttpError(429, "POLICYSQL_USAGE_BUDGET_EXCEEDED", "The query exceeds the configured usage budget.");
    }
    // SQLite explicitly does not guarantee the format of EXPLAIN QUERY PLAN's `detail` text.
    // Record only the structured row count and keep catalog bounds conservative; never derive a
    // security or billing decision from text matching planner prose.
    const upperRowsWritten = statement.operation === "select" ? 0 : upperRowsRead;
    if (upperRowsWritten > catalog.maxEstimatedRowsWritten) {
      throw new HttpError(429, "POLICYSQL_USAGE_BUDGET_EXCEEDED", "The query exceeds the configured usage budget.");
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

export const estimateSealedOnTransaction = async (compiled, env, transaction) => {
  const catalog = parseCatalog(env);
  const planned = compiled.statements
    .map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => statement.operation !== "insert");
  const results = planned.length === 0
    ? []
    : await transaction.execute(planned.map(({ statement }) => ({
        sql: statement.costExplainSql,
        args: args(statement),
      })));
  return evaluate(compiled, catalog, planned, results);
};

export const estimateSealedEnvelope = async (
  compiled,
  env,
  requestId,
  transportFactory = (bindings, id) => new TursoHttpTransport(bindings, id),
) => {
  const catalog = parseCatalog(env);
  let transaction;
  try {
    const planned = compiled.statements
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => statement.operation !== "insert");
    let results = [];
    if (planned.length > 0) {
      const transport = transportFactory(env, `${requestId}-cost`);
      transaction = await transport.begin("read", 1_000);
      results = await transaction.execute(planned.map(({ statement }) => ({
        sql: statement.costExplainSql,
        args: args(statement),
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
    if (error instanceof HttpError) throw error;
    console.log(JSON.stringify({
      event: "cost_admission_internal_failure",
      requestId,
      internalClass: error?.constructor?.name ?? "UnknownError",
    }));
    throw new HttpError(503, "POLICYSQL_COST_ADMISSION_UNAVAILABLE", "Cost admission is temporarily unavailable.");
  }
};

export const observeCostEnvelope = async (
  compiled,
  env,
  requestId,
  transportFactory = (bindings, id) => new TursoHttpTransport(bindings, id),
) => {
  try {
    const observation = await estimateSealedEnvelope(compiled, env, requestId, transportFactory);
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
      code: error?.code ?? "POLICYSQL_COST_OBSERVATION_FAILED",
      status: Number.isSafeInteger(error?.status) ? error.status : undefined,
    }));
  }
};
