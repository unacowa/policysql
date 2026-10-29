import { EngineError, wasmError } from "./errors.ts";
import { databaseRequired } from "./database.ts";
import { driverArgs, rawDriverValue, rowValues } from "./driver-values.ts";
import { runtimeBytesLimit } from "./binary.ts";
import type { ExecutionTrace } from "./types.ts";

const remoteFailure = (timeout = false) =>
  new EngineError(
    timeout ? "POLICYSQL_DATABASE_TIMEOUT" : "POLICYSQL_DATABASE_UNAVAILABLE",
    timeout ? "The database operation timed out." : "The database is temporarily unavailable.",
  );

const executionTrace = (compiled, statements, requestId, inputStatements): ExecutionTrace => ({
  source: "turso-egress",
  requestId,
  disposition: "executed",
  attempt: 1,
  statements: statements.map((statement, index) => ({
    index,
    operation: compiled.statements[index].operation,
    ...(compiled.statements[index].resource
      ? { resource: compiled.statements[index].resource }
      : {}),
    inputSql: inputStatements?.[index]?.sql ?? "",
    executedSql: statement.sql,
    parameters: [
      ...Object.keys(compiled.statements[index].clientParameters).map((name) => ({
        name,
        source: "client" as const,
        value: "[redacted]" as const,
      })),
      ...Object.keys(compiled.statements[index].serverParameters).map((name) => ({
        name,
        source: "server" as const,
        value: "[redacted]" as const,
      })),
    ].sort((left, right) => left.name.localeCompare(right.name)),
  })),
});

const publishExecutionTrace = async (trace, sink) => {
  if (!sink) return;
  try {
    await sink(trace);
  } catch (error) {
    console.log(JSON.stringify({
      event: "execution_trace_sink_failed",
      requestId: trace.requestId,
      internalClass: error?.constructor?.name ?? "UnknownError",
    }));
  }
};

const strictestLimit = (compiled, name) => {
  const values = compiled.statements
    .map((statement) => statement.limits?.[name])
    .filter((value) => Number.isFinite(value) && value >= 0);
  return values.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...values);
};

const encodedBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const enforceCumulativeLimits = (compiled, results, elapsedMs) => {
  const rows = results.reduce((sum, result) => sum + result.rows.length, 0);
  const bytes = results.reduce((sum, result) => sum + encodedBytes(result.rows), 0);
  if (
    rows > strictestLimit(compiled, "maxRows") ||
    bytes > strictestLimit(compiled, "maxResultBytes")
  ) {
    throw new EngineError("POLICYSQL_LIMIT_EXCEEDED",
      "The request or result exceeded a configured limit.",
    );
  }
  if (elapsedMs > strictestLimit(compiled, "timeoutMs")) {
    throw new EngineError("POLICYSQL_TIMEOUT", "The database operation timed out.");
  }
};

const rawResult = (result, operation, rows, maxBytes: number) => ({
  columns: result.columns,
  rows: rows.map((row) => row.map((value) => rawDriverValue(value, maxBytes))),
  affectedRows:
    operation !== "select" && result.columns.length > 0
      ? result.rows.length
      : Number(result.rowsAffected ?? 0),
});

const publicResultColumn = (column) => ({
  name: column.name,
  type: column.logicalType,
  representation: column.representation === "base64"
    ? "string"
    : (column.representation === "json" ? "object" : column.representation),
  nullable: column.nullable || column.redactedOnNull,
  ...(column.format ? { format: column.format } : {}),
  ...(column.constraints ? { constraints: column.constraints } : {}),
  ...(column.jsonSchema ? { jsonSchema: column.jsonSchema } : {}),
});

const validateDriverResults = (runtime, compiled, wasmHandle, driverResults, requestId, maxBytes: number) =>
  driverResults.map((result, index) => {
    const descriptor = compiled.statements[index];
    // Log raw shape before validation so malformed rows remain observable. Never log cell values.
    console.log(JSON.stringify({
      event: "database_result_received",
      requestId,
      index,
      operation: descriptor.operation,
      columnCount: result.columns.length,
      rowWidths: result.rows.map((row) => Array.isArray(row) ? row.length
        : row && typeof row === "object" ? Object.keys(row).length : null),
      rowsAffected: Number(result.rowsAffected ?? 0),
    }));
    const rows = result.rows.map((row) => rowValues(result.columns, row));
    const validated = JSON.parse(
      runtime.validate_result_json(
        wasmHandle,
        index,
        JSON.stringify(rawResult(result, descriptor.operation, rows, maxBytes)),
      ),
    );
    const error = wasmError(validated);
    if (error) throw error;
    return {
      columns: validated.columns,
      rows: validated.rows.map((row) =>
        Object.fromEntries(validated.columns.map((column, columnIndex) => [column, row[columnIndex]])),
      ),
      rowCount: validated.rows.length,
      ...(descriptor.operation === "select" ? {} : { affectedRows: validated.affectedRows }),
      meta: {
        operation: descriptor.operation,
        ...(descriptor.operation === "select" ? {} : {
          mutation: {
            affectedRows: validated.affectedRows,
            returning: descriptor.result.length > 0,
            operationCheck: descriptor.operationCheck ? "passed" : "not_configured",
          },
        }),
        result: {
          columns: descriptor.result.map(publicResultColumn),
          redactions: validated.redactions.flatMap((row, rowIndex) =>
            row.flatMap((redacted, columnIndex) =>
              redacted
                ? [{ row: rowIndex, column: validated.columns[columnIndex], code: "POLICY_REDACTED" }]
                : [],
            ),
          ),
        },
      },
    };
  });

export const executeSealedOnTransaction = async (
  runtime,
  compiled,
  transaction,
  requestId,
) => {
  if (!Number.isSafeInteger(compiled.executionHandle)) {
    throw new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");
  }
  const handle = BigInt(compiled.executionHandle);
  try {
    // Read the runtime limit once, before any statement reaches the database.
    const maxBytes = runtimeBytesLimit(runtime);
    const driverResults = await transaction.execute(
      compiled.statements.map((statement) => ({
        sql: statement.protectedSql,
        args: driverArgs(statement, maxBytes),
      })),
    );
    return {
      results: validateDriverResults(runtime, compiled, handle, driverResults, requestId, maxBytes),
      usage: {
        rowsRead: driverResults.reduce((sum, result) => sum + result.usage.rowsRead, 0),
        rowsWritten: driverResults.reduce((sum, result) => sum + result.usage.rowsWritten, 0),
        queryDurationMs: driverResults.reduce(
          (sum, result) => sum + result.usage.queryDurationMs,
          0,
        ),
      },
    };
  } finally {
    runtime.release_execution(handle);
  }
};

export const executeSealedEnvelope = async (
  runtime,
  compiled,
  requestId,
  transportFactory: (...args: any[]) => any,
  idempotency = null,
  traceOptions = null,
) => {
  if (!Number.isSafeInteger(compiled.executionHandle)) {
    throw new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");
  }
  const wasmHandle = BigInt(compiled.executionHandle);
  // A misconfigured runtime is a 500 raised before BEGIN, never a retryable 503
  // after opening and rolling back a database transaction.
  let maxBytes: number;
  try {
    maxBytes = runtimeBytesLimit(runtime);
  } catch (error) {
    runtime.release_execution(wasmHandle);
    throw error;
  }
  const started = performance.now();
  let transaction;
  try {
    if (typeof transportFactory !== "function") throw databaseRequired();
    const timeoutMs = Math.min(...compiled.statements.map((item) => item.limits.timeoutMs));
    const deadlineMs = Date.now() + timeoutMs;
    const transport = await transportFactory(requestId, deadlineMs);
    transaction = await transport.begin(compiled.transactionMode, timeoutMs);
    const statements = compiled.statements.map((statement) => ({
      sql: statement.protectedSql,
      args: driverArgs(statement, maxBytes),
    }));
    if (compiled.transactionMode === "write" && idempotency) {
      const [existingResult] = await transaction.execute([
        {
          sql:
            "SELECT fingerprint, response_json FROM policysql_idempotency WHERE key_hash = :key_hash",
          args: { key_hash: idempotency.keyHash },
        },
      ]);
      if (existingResult.rows.length > 1) {
        throw new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");
      }
      if (existingResult.rows.length === 1) {
        const [fingerprint, responseJson] = existingResult.rows[0];
        if (fingerprint !== idempotency.fingerprint) {
          throw new EngineError("POLICYSQL_IDEMPOTENCY_CONFLICT",
            "The idempotency key is already bound to a different request.",
          );
        }
        let stored;
        try {
          stored = JSON.parse(responseJson);
        } catch {
          throw new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");
        }
        if (
          stored?.version !== 1 ||
          !Array.isArray(stored.results) ||
          typeof stored.originalRequestId !== "string" ||
          typeof stored.transactionId !== "string" ||
          !stored.usage ||
          typeof stored.usage !== "object"
        ) {
          throw new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");
        }
        await transaction.rollback();
        transaction = undefined;
        return {
          ...stored,
          replayed: true,
          ...(traceOptions?.enabled ? {
            executionTrace: {
              source: "turso-egress",
              requestId,
              disposition: "idempotency_replay",
              attempt: 1,
              statements: [],
            },
          } : {}),
        };
      }
    }
    const trace = traceOptions?.enabled
      ? executionTrace(compiled, statements, requestId, traceOptions.inputStatements)
      : undefined;
    if (trace) await publishExecutionTrace(trace, traceOptions.sink);
    const driverResults = await transaction.execute(statements);
    const results = validateDriverResults(
      runtime,
      compiled,
      wasmHandle,
      driverResults,
      requestId,
      maxBytes,
    );
    enforceCumulativeLimits(compiled, results, performance.now() - started);
    const policyUsage = {
      rowsReturned: results.reduce((sum, result) => sum + result.rowCount, 0),
      rowsAffected: results.reduce((sum, result) => sum + (result.affectedRows ?? 0), 0),
      rowsRead: driverResults.reduce((sum, result) => sum + result.usage.rowsRead, 0),
      rowsWritten: driverResults.reduce((sum, result) => sum + result.usage.rowsWritten, 0),
      queryDurationMs:
        Math.round(driverResults.reduce((sum, result) => sum + result.usage.queryDurationMs, 0) * 1000) /
        1000,
    };
    const terminal = {
      version: 1,
      results,
      usage: policyUsage,
      originalRequestId: requestId,
      transactionId: idempotency
        ? `atomic_${idempotency.keyHash.slice(0, 24)}`
        : `atomic_${requestId}`,
      replayed: false,
    };
    if (compiled.transactionMode === "write" && idempotency) {
      await transaction.execute([
        {
          sql:
            "INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (:key_hash, :fingerprint, :response_json)",
          args: {
            key_hash: idempotency.keyHash,
            fingerprint: idempotency.fingerprint,
            response_json: JSON.stringify(terminal),
          },
        },
      ]);
    }
    await transaction.commit();
    console.log(JSON.stringify({
      event: "database_usage",
      requestId,
      rowsRead: transaction.usage.reduce((sum, usage) => sum + usage.rowsRead, 0),
      rowsWritten: transaction.usage.reduce((sum, usage) => sum + usage.rowsWritten, 0),
      queryDurationMs: transaction.usage.reduce((sum, usage) => sum + usage.queryDurationMs, 0),
    }));
    transaction = undefined;
    return { ...terminal, ...(trace ? { executionTrace: trace } : {}) };
  } catch (error) {
    if (transaction) {
      try { await transaction.rollback(); } catch { /* server timeout is terminal */ }
    }
    if (error instanceof EngineError) throw error;
    throw remoteFailure(error?.name === "QueryTimeoutError" || error?.code === "QUERY_TIMEOUT");
  } finally {
    runtime.release_execution(wasmHandle);
  }
};
