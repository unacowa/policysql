import { Kysely } from "kysely";
import { PolicySqlClient } from "@unacowa/policysql/client";
import { PolicySqlDialect, policyOptions } from "@unacowa/policysql/kysely";

// Supply an application-configured Transport. Role and paired version preconditions are optional.
export const createExampleClient = ({ autoIdempotencyKey = false, ...clientOptions }) => new Kysely({
  dialect: new PolicySqlDialect({ client: new PolicySqlClient(clientOptions), autoIdempotencyKey }),
});

// Keep the key and payload together when retrying the same atomic business operation.
export const prepareProjectRename = (db, { id, name, idempotencyKey = crypto.randomUUID() }) => {
  const operation = db.updateTable("projects").set({ name }).where("id", "=", id)
    .returning(["id", "name"])
    .withPlugin(policyOptions({ idempotencyKey, expect: { affectedRows: 1 } }));
  return { idempotencyKey, send: () => operation.execute() };
};

// Standard Kysely interactive transaction. No idempotency key or user DB table is needed.
export const renameExistingProject = (db, { id, name }) => db.transaction().execute(async (trx) => {
  const project = await trx.selectFrom("projects").select(["id", "name"])
    .where("id", "=", id).executeTakeFirstOrThrow();
  await trx.updateTable("projects").set({ name }).where("id", "=", project.id)
    .withPlugin(policyOptions({ expect: { affectedRows: 1 } })).execute();
  return project;
});
