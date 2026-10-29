import test from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.ts";
import { loadRuntime } from "../../../examples/in-process/policysql.ts";
import { testConfig, testOwners } from "./helpers/database.mjs";

// Every client operation runs context -> session -> database -> body (ADR 0023). A caller
// whose database the wrapper's provider rejects never has its body read.
const getRuntime = loadRuntime();
const session = { principal: "order:u", subject: "u", roles: ["member"], defaultRole: "member", access: ["execute", "explain", "catalog"], session: { tenant_id: "t" } };
const binding = () => ({ version: 1, scope: "order", databaseId: "db", generation: "1", snapshot: getRuntime().snapshot });
const TX = `tx_${"a".repeat(32)}`;

test("a rejected database binding is reported before any operation reads its body", async (t) => {
  t.mock.method(console, "log", () => {});
  let checks = 0;
  const engine = createEngine({
    getRuntime,
    database: { check: () => { checks++; return false; }, connect: () => assert.fail("never connects") },
    config: testConfig(),
    transactionOwners: testOwners(),
  });
  const calls = [
    ["execute", {}], ["explain", {}], ["begin", {}],
    ["statement", { transactionId: TX }], ["commit", { transactionId: TX }], ["rollback", { transactionId: TX }],
  ];
  for (const [operation, fields] of calls) {
    let reads = 0;
    const before = checks;
    const result = await engine[operation]({ ...fields, bodyText: async () => { reads++; return "{}"; } }, { database: binding(), session });
    assert.equal(result.ok, false, operation);
    assert.equal(result.error.code, "POLICYSQL_DATABASE_BINDING_REJECTED", operation);
    assert.equal(checks, before + 1, `${operation}: the provider was asked`);
    assert.equal(reads, 0, `${operation}: the body was not read`);
  }
});

test("a rejected session is reported before the database is checked or the body is read", async (t) => {
  t.mock.method(console, "log", () => {});
  let checks = 0;
  const engine = createEngine({
    getRuntime,
    database: { check: () => { checks++; return true; }, connect: () => assert.fail("never connects") },
    config: testConfig(),
    transactionOwners: testOwners(),
  });
  for (const operation of ["execute", "explain", "begin", "statement", "commit", "rollback"]) {
    let reads = 0;
    const result = await engine[operation]({
      ...(["statement", "commit", "rollback"].includes(operation) ? { transactionId: TX } : {}),
      bodyText: async () => { reads++; return "{}"; },
    }, { database: binding(), session: { ...session, access: [] } });
    assert.equal(result.ok, false, operation);
    assert.equal(reads, 0, `${operation}: the body was not read`);
  }
  assert.equal(checks, 0);
});
