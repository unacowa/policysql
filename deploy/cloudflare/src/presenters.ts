import { wasmError } from "./errors.ts";
import { POLICY_VERSION, SCHEMA_VERSION } from "./config.ts";
import { runtimeLimits } from "./limits.ts";
import type { AuthContext } from "./types.ts";

export const parsedRuntimeCall = (text: string) => {
  const result = JSON.parse(text);
  const error = wasmError(result);
  if (error) throw error;
  return result;
};

const TEMPORAL_FORMATS = new Map([["date", "iso-date"], ["datetime", "sqlite-datetime"], ["instant", "rfc3339"]]);

// `nullable` is the compiler's statement-wide proof (#20): true only when every
// use of the parameter is a direct INSERT/UPDATE assignment to a nullable column.
// It never depends on the supplied sample value, and execute accepts JSON null
// for exactly these parameters, for every type including bytes.
const valueDescriptor = (name: string, value: unknown, compiledType: string | undefined, nullable: boolean) => {
  if (compiledType === "bytes") {
    return { name, type: "bytes", representation: "string", format: "base64", nullable };
  }
  // Temporal types have exactly one Catalog format each (see `validate_format`).
  const temporalFormat = TEMPORAL_FORMATS.get(compiledType ?? "");
  if (temporalFormat) {
    return { name, type: compiledType, representation: "string", format: temporalFormat, nullable };
  }
  if (["string", "boolean", "integer", "int64", "number", "json"].includes(compiledType ?? "")) {
    const representation = compiledType === "json"
      ? "object"
      : (["integer", "int64", "number"].includes(compiledType!) ? "number" : compiledType);
    return { name, type: compiledType, representation, nullable };
  }
  if (typeof value === "boolean") return { name, type: "boolean", representation: "boolean", nullable };
  if (typeof value === "number") return {
    name,
    type: Number.isInteger(value) ? "int64" : "number",
    representation: "number",
    nullable,
  };
  return { name, type: "string", representation: "string", nullable };
};

const resultColumn = (column: any) => ({
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

export const explainResponse = (compiled: any, auth: AuthContext, id: string) => ({
  statements: compiled.statements.map((statement: any, index: number) => ({
    index,
    operation: statement.operation,
    parameters: Object.entries(statement.clientParameters).map(([name, value]) =>
      valueDescriptor(name, value, statement.clientParameterTypes[name], statement.clientParameterNullable?.[name] === true)),
    result: { columns: statement.result.map(resultColumn) },
    resources: statement.explain.publicResources.map((resource: any) => ({
      ...resource,
      policy: `${resource.name}.${auth.role}.${statement.operation}`,
    })),
    effectiveLimit: statement.explain.policyLimit ?? statement.limits.maxRows,
    serverParameters: Object.keys(statement.serverParameters),
    warnings: [],
  })),
  meta: {
    requestId: id,
    policyVersion: compiled.policyVersion,
    schemaVersion: compiled.schemaVersion,
    role: auth.role,
    transactionMode: compiled.transactionMode,
  },
});

// Every advertised limit is a value the runtime reports and the engine or core enforces;
// nothing here is a constant or an override (ADR 0024, "One place for limits").
export const capabilities = (runtime: any, publicConfig: any = {}) => {
  const enforced = runtimeLimits(runtime);
  const limits = {
    maxRows: enforced.maxRows,
    maxResultBytes: enforced.maxResultBytes,
    timeoutMs: enforced.timeoutMs,
    maxStatements: enforced.maxStatements,
    maxRequestBytes: enforced.maxRequestBytes,
    maxJsonValues: enforced.maxJsonValues,
    maxSqlBytes: enforced.maxSqlBytes,
    maxBytesPerValue: enforced.maxBytesPerValue,
    maxParameters: enforced.maxParameters,
    maxExpressionDepth: enforced.maxExpressionDepth,
    maxProjections: enforced.maxProjections,
    maxJoins: enforced.maxJoins,
  };
  return ({
  id: runtime.snapshot,
  profile: runtime.profile,
  abiVersion: runtime.abi_version,
  schemaVersion: publicConfig.schemaVersion ?? SCHEMA_VERSION,
  policyVersion: publicConfig.policyVersion ?? POLICY_VERSION,
  sqlDialect: "sqlite",
  statements: ["select", "insert", "update", "delete"],
  select: {
    explicitProjection: true,
    joins: ["inner", "left"],
    subqueries: true,
    subqueryForms: ["correlated_exists", "transparent_derived"],
    ctes: "non_recursive",
    cteForms: ["single_transparent", "single_filtered_before_join"],
    aggregations: true,
    windowFunctions: true,
    functions: ["count", "lower", "upper", "json_extract", "row_number"],
  },
  mutations: { presets: true, returning: true, atomicPostChecks: true },
  parameters: { named: true, positional: false },
  limits,
  transactions: {
    atomic: true,
    interactive: true,
    commitChecks: true,
    commitChecksConfigured: runtime.commit_checks_enabled,
    commitCheckQueries: true,
    maxStatements: enforced.maxTransactionStatements,
    maxResultBytes: enforced.maxTransactionResultBytes,
    maxCommitChecks: enforced.maxCommitChecks,
    maxCallbackQueriesPerCheck: enforced.maxTransactionStatements,
    maxCallbackRowsPerCheck: enforced.maxCallbackRows,
    maxCallbackBytesPerCheck: enforced.maxTransactionResultBytes,
    maxHookDurationMs: enforced.maxHookDurationMs,
    maxInteractiveDurationMs: enforced.transactionMs,
  },
  idempotency: {
    mutationsRequired: false,
    interactiveStartRequired: false,
    persistent: true,
    binding: ["principal", "subject", "role", "session", "endpoint", "payload"],
  },
  costObservation: { enabled: true, timing: "after_response", planner: "sqlite-explain-query-plan" },
  });
};
