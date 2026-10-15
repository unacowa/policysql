export const testBinding = (snapshot = "test-snapshot") => ({
  version: 1, scope: "test", databaseId: "test-db", generation: "1", snapshot,
});
export const testProvider = (connect = () => { throw new Error("Unexpected connection"); }) => ({
  check: (binding) => binding.scope === "test" && binding.databaseId === "test-db",
  connect,
});
