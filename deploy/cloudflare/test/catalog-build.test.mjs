import assert from "node:assert/strict";
import test from "node:test";
import { buildPhysicalSchema } from "../scripts/catalog-build.mjs";

const manifest = `
version: 1
resources:
  projects:
    source: { table: physical_projects }
    columns:
      id: {}
      title: {}
`;

test("Catalog builder captures trusted SQLite table_xinfo contracts", async () => {
  const calls = [];
  const connection = {
    async all(sql) {
      calls.push(sql);
      return [
        { name: "id", type: "INTEGER", notnull: 0, pk: 1, hidden: 0 },
        { name: "title", type: "TEXT", notnull: 0, pk: 0, hidden: 0 },
      ];
    },
  };
  assert.deepEqual(await buildPhysicalSchema(connection, manifest), {
    tables: {
      physical_projects: {
        columns: {
          id: { declaredType: "INTEGER", nullable: false },
          title: { declaredType: "TEXT", nullable: true },
        },
      },
    },
  });
  assert.deepEqual(calls, ['PRAGMA table_xinfo("physical_projects")']);
});

test("Catalog builder fails closed for missing and hidden columns", async () => {
  await assert.rejects(
    buildPhysicalSchema({ all: async () => [] }, manifest),
    /source table does not exist/,
  );
  await assert.rejects(
    buildPhysicalSchema({
      all: async () => [{ name: "id", type: "INTEGER", notnull: 1, pk: 0, hidden: 1 }],
    }, manifest),
    /column does not match/,
  );
});
