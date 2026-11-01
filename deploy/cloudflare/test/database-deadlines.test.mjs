import assert from "node:assert/strict";
import test from "node:test";
import { checkDatabaseBinding, databaseTransportFactory } from "../src/database.ts";
import { testBinding } from "./helpers/database.mjs";
import { EngineError } from "../src/errors.ts";

for (const stage of ["check", "connect"]) {
  test(`pending provider ${stage} uses the remaining transaction budget`, async (t) => {
    const waits = [];
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, wait, ...args) => {
      waits.push(wait);
      return schedule(callback, wait, ...args);
    });
    let calls = 0;
    let finish;
    let begins = 0;
    const provider = {
      streamedReadCap: true, check: () => true,
      connect: () => ({ begin: async () => { begins++; } }),
      [stage]: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
    };
    const transport = databaseTransportFactory(provider, testBinding(), 1_024, Date.now() + 80);
    await assert.rejects(transport("deadline"), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
    assert.equal(calls, 1);
    assert.ok(waits.length > 0 && waits.every((wait) => wait > 0 && wait <= 80));
    // Resolving a timed-out provider must not resume acquisition or open a transaction.
    finish(stage === "check" ? true : { begin: async () => { begins++; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(begins, 0);
  });
}

test("an expired parent deadline rejects before invoking the provider", async () => {
  const provider = { streamedReadCap: true, check() { assert.fail("provider must not run"); }, connect() { assert.fail("provider must not run"); } };
  const acquire = databaseTransportFactory(provider, testBinding(), 1_024, Date.now() - 1);
  await assert.rejects(acquire("expired", Date.now() + 1000), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
});

test("provider-thrown deadline errors cannot expose provider error text", async () => {
  const provider = {
    streamedReadCap: true, check() { throw new EngineError("POLICYSQL_DATABASE_TIMEOUT", "private-credential-detail"); },
    connect() { assert.fail("must not connect"); },
  };
  await assert.rejects(checkDatabaseBinding(provider, testBinding(), "test-snapshot", Date.now() + 1000), (error) => {
    assert.equal(error.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    assert.equal(error.message.includes("private-credential-detail"), false);
    return true;
  });
});
