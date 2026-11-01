export const testBinding = (snapshot = "test-snapshot") => ({
  version: 1, scope: "test", databaseId: "test-db", generation: "1", snapshot,
});
// The minimal explicit deployment configuration (ADR 0021).
export const testConfig = (overrides = {}) => ({ environment: "test", ...overrides });
// A TransactionOwner port for tests whose requests must never reach an owner (ADR 0022).
export const testOwners = () => ({ route() { throw new Error("Unexpected transaction owner lookup"); } });
export const testProvider =(connect = () => { throw new Error("Unexpected connection"); }) => ({
  streamedReadCap: true, check: (binding) => binding.scope === "test" && binding.databaseId === "test-db",
  connect,
});
