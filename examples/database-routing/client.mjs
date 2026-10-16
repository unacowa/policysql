import { Kysely, DummyDriver, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";
import { PolicySqlClient } from "@unacowa/policysql/client";
import { createPolicyKysely, policyMutation } from "@unacowa/policysql/kysely";

// The current adapter uses Kysely to build queries and PolicySqlClient to execute them.
// The DummyDriver is never used for database execution through this adapter.
export const createExampleClient = ({ autoIdempotencyKey = false, ...clientOptions }) => {
  const kysely = new Kysely({ dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  } });
  return createPolicyKysely({ kysely, client: new PolicySqlClient(clientOptions), autoIdempotencyKey });
};

// Prepare once per business operation. Call send() again with the same key and payload
// if the response is lost. Persist the key and payload if retries must survive a reload.
export const prepareProjectRename = (db, { id, name, idempotencyKey = crypto.randomUUID() }) => {
  const operation = policyMutation(
    db.updateTable("projects").set({ name }).where("id", "=", id).returning(["id", "name"]),
    { idempotencyKey, expect: { affectedRows: 1 } },
  );
  return { idempotencyKey, send: () => operation.executeWithPolicyMeta() };
};
