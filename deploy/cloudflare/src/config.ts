export const SCHEMA_VERSION = "schema_dev_3";
export const POLICY_VERSION = "policy_dev_3";

// No limit lives here. The wrapper configures limits as `RuntimeLimits`, and the engine reads
// the enforced values from the runtime (`limits.ts`, ADR 0024).
