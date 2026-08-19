import { wasmError } from "./errors.ts";
import { LIMITS, POLICY_VERSION, SCHEMA_VERSION } from "./config.ts";
import type { AuthContext } from "./types.ts";

export const parsedRuntimeCall = (text: string) => {
  const result = JSON.parse(text);
  const error = wasmError(result);
  if (error) throw error;
  return result;
};

const valueDescriptor = (name: string, value: unknown, compiledType?: string) => {
  if (compiledType === "bytes") {
    return { name, type: "bytes", representation: "string", format: "base64", nullable: false };
  }
  if (["string", "boolean", "int64", "number", "json"].includes(compiledType ?? "")) {
    const representation = compiledType === "json"
      ? "object"
      : (["int64", "number"].includes(compiledType!) ? "number" : compiledType);
    return { name, type: compiledType, representation, nullable: false };
  }
  if (value === null) return { name, type: "string", representation: "string", nullable: true };
  if (typeof value === "boolean") return { name, type: "boolean", representation: "boolean", nullable: false };
  if (typeof value === "number") return {
    name,
    type: Number.isInteger(value) ? "int64" : "number",
    representation: "number",
    nullable: false,
  };
  return { name, type: "string", representation: "string", nullable: false };
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
      valueDescriptor(name, value, statement.clientParameterTypes[name])),
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

export const capabilities = (runtime: any, publicConfig: any = {}) => {
  const limits = { ...LIMITS, ...(publicConfig.limits ?? {}) };
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
    maxCommitChecks: 4,
    maxCallbackQueriesPerCheck: limits.maxStatements,
    maxCallbackRowsPerCheck: limits.maxRows,
    maxCallbackBytesPerCheck: limits.maxResultBytes,
    maxHookDurationMs: 1500,
    maxInteractiveDurationMs: 4000,
  },
  idempotency: {
    mutationsRequired: true,
    persistent: true,
    binding: ["issuer", "subject", "role", "session", "endpoint", "payload"],
  },
  costObservation: { enabled: true, timing: "after_response", planner: "sqlite-explain-query-plan" },
  });
};
