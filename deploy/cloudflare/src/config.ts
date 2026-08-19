export const SCHEMA_VERSION = "schema_dev_2";
export const POLICY_VERSION = "policy_dev_2";

export const LIMITS = {
  maxRows: 100,
  maxResultBytes: 64_000,
  timeoutMs: 1_000,
  maxStatements: 8,
  maxSqlBytes: 65_536,
  maxRequestBytes: 1_048_576,
  maxJoins: 8,
} as const;
