import { createPolicySqlWorker, TursoHttpTransport } from "@unacowa/policysql/cloudflare";
import { createDatabaseRegistry } from "./provider.ts";
import catalog from "./catalog.yaml";
import policy from "./policy.yaml";
import physicalSchema from "./physical-schema.json";

const registry = createDatabaseRegistry([
  { environment: "development", tenant: "tenant_a", databaseId: "db_a", generation: "1",
    url: "https://replace-with-tenant-a.invalid", tokenEnv: "TENANT_A_TOKEN", enabledEnv: "TENANT_A_ENABLED" },
  { environment: "development", tenant: "tenant_b", databaseId: "db_b", generation: "1",
    url: "https://replace-with-tenant-b.invalid", tokenEnv: "TENANT_B_TOKEN", enabledEnv: "TENANT_B_ENABLED" },
], () => worker.getRuntime().snapshot, (credentials, requestId) => new TursoHttpTransport(credentials, requestId));

const worker = createPolicySqlWorker({
  catalog, policy, physicalSchema,
  schemaVersion: "schema_routing_1",
  policyVersion: "policy_routing_1",
  limits: { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 },
  database: registry.provider,
});

// Both isolates use the same wrapper-owned provider. No credentials cross the DO message boundary.
export const TransactionOwner = worker.TransactionOwner;
export default {
  fetch(request, env, context) {
    if (new URL(request.url).pathname.startsWith("/v1/commit-checks/")) {
      return worker.app.fetchCallback(request, env, context);
    }
    // This example wrapper chooses a fixed registered DB. A tenant-aware wrapper can
    // supply an ID from its own authorization/routing service instead of this setting.
    const database = registry.binding(env.APPLICATION_DATABASE_ID, env);
    return worker.app.fetch(request, env, context, database);
  },
};
