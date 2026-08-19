import { HttpError, wasmError } from "./errors.ts";
import { TursoHttpTransport } from "./turso-http.ts";

const remoteFailure = (timeout = false) =>
  new HttpError(
    timeout ? 504 : 503,
    timeout ? "POLICYSQL_DATABASE_TIMEOUT" : "POLICYSQL_DATABASE_UNAVAILABLE",
    timeout ? "The database operation timed out." : "The database is temporarily unavailable.",
  );

const driverArgs = (statement) => {
  const overlap = Object.keys(statement.clientParameters).some((name) =>
    Object.hasOwn(statement.serverParameters, name),
  );
  if (overlap) throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
  return { ...statement.clientParameters, ...statement.serverParameters };
};

const jsonSafeValue = (value) => {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new HttpError(422, "POLICYSQL_SCHEMA_MISMATCH", "The database result does not match the compiled logical contract.");
    }
    return number;
  }
  if (value instanceof Uint8Array) return [...value];
  return value;
};

const rowValues = (columns, row) =>
  columns.map((column, index) => row?.[index] ?? row?.[column] ?? null);

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
    throw new HttpError(
      413,
      "POLICYSQL_LIMIT_EXCEEDED",
      "The request or result exceeded a configured limit.",
    );
  }
  if (elapsedMs > strictestLimit(compiled, "timeoutMs")) {
    throw new HttpError(504, "POLICYSQL_TIMEOUT", "The database operation timed out.");
  }
};

const rawResult = (result, operation) => ({
  columns: result.columns,
  rows: result.rows.map((row) => rowValues(result.columns, row).map(jsonSafeValue)),
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

const validateDriverResults = (runtime, compiled, wasmHandle, driverResults, requestId) =>
  driverResults.map((result, index) => {
    const descriptor = compiled.statements[index];
    console.log(JSON.stringify({
      event: "database_result_received",
      requestId,
      index,
      operation: descriptor.operation,
      columnCount: result.columns.length,
      rowWidths: result.rows.map((row) => rowValues(result.columns, row).length),
      valueTypes: result.rows.map((row) => rowValues(result.columns, row).map((value) =>
        value === null ? "null" : typeof value,
      )),
      rowsAffected: Number(result.rowsAffected ?? 0),
    }));
    const validated = JSON.parse(
      runtime.validate_result_json(
        wasmHandle,
        index,
        JSON.stringify(rawResult(result, descriptor.operation)),
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
    throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
  }
  const handle = BigInt(compiled.executionHandle);
  try {
    const driverResults = await transaction.execute(
      compiled.statements.map((statement) => ({
        sql: statement.protectedSql,
        args: driverArgs(statement),
      })),
    );
    return {
      results: validateDriverResults(runtime, compiled, handle, driverResults, requestId),
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
  env,
  requestId,
  transportFactory = (bindings, id) => new TursoHttpTransport(bindings, id),
  idempotency = null,
) => {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw remoteFailure();
  if (!Number.isSafeInteger(compiled.executionHandle)) {
    throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
  }
  const wasmHandle = BigInt(compiled.executionHandle);
  const started = performance.now();
  let transaction;
  try {
    const timeoutMs = Math.min(...compiled.statements.map((item) => item.limits.timeoutMs));
    const transport = transportFactory(env, requestId);
    transaction = await transport.begin(compiled.transactionMode, timeoutMs);
    const statements = compiled.statements.map((statement) => ({
      sql: statement.protectedSql,
      args: driverArgs(statement),
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
        throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
      }
      if (existingResult.rows.length === 1) {
        const [fingerprint, responseJson] = existingResult.rows[0];
        if (fingerprint !== idempotency.fingerprint) {
          throw new HttpError(
            409,
            "POLICYSQL_IDEMPOTENCY_CONFLICT",
            "The idempotency key is already bound to a different request.",
          );
        }
        let stored;
        try {
          stored = JSON.parse(responseJson);
        } catch {
          throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
        }
        if (
          stored?.version !== 1 ||
          !Array.isArray(stored.results) ||
          typeof stored.originalRequestId !== "string" ||
          typeof stored.transactionId !== "string" ||
          !stored.usage ||
          typeof stored.usage !== "object"
        ) {
          throw new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
        }
        await transaction.rollback();
        transaction = undefined;
        return { ...stored, replayed: true };
      }
    }
    const driverResults = await transaction.execute(statements);
    const results = validateDriverResults(
      runtime,
      compiled,
      wasmHandle,
      driverResults,
      requestId,
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
    return terminal;
  } catch (error) {
    if (transaction) {
      try { await transaction.rollback(); } catch { /* server timeout is terminal */ }
    }
    if (error instanceof HttpError) throw error;
    throw remoteFailure(error?.name === "QueryTimeoutError" || error?.code === "QUERY_TIMEOUT");
  } finally {
    runtime.release_execution(wasmHandle);
  }
};
