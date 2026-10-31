import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harness } from "./helpers/routing.mjs";
// The default `maxRequestBytes` (ADR 0027), which these fixtures stay under.
const MAX_BODY_BYTES = 1_048_576;

// Regression fixture (#55 re-review, AGENTS.md): a statement that COMPILES and carries ~1 MB
// of numbers in a JSON-typed parameter (`projects.metadata`, as in the deployed catalog). The
// owner hashes it with core after compile, so core's number canonicalization must stay fast.
// PolicySQL limits JSON parameters only by the body limits (`maxRequestBytes`, `maxJsonValues`). The responses are those of main before ADR 0024 pull request 2.
const read = (name) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");
const fixture = {
  catalog: read("bytes/catalog.yaml"), policy: read("bytes/policy.yaml"),
  schema: read("bytes/schema.sql"), physicalSchema: read("bytes/physical-schema.json"),
  seed() {},
};
const SQL = "INSERT INTO projects(id,name,state,metadata) VALUES(:id,:name,:state,:metadata)";
const SHAPES = {
  "17-digit decimals": (index) => Number(`${90071992547409 + index * 7}.${String(index % 1000).padStart(3, "0")}`),
  "short decimals": (index) => Number(`${index % 100}.${index % 10}`),
  "small integers": (index) => index % 1000,
};
// Core's time (best of 5 after a warm-up) is held to an absolute bound far below a slow
// number path's.
const ABSOLUTE_BOUND_MS = 250;
const fastest = async (runs, work) => {
  await work();
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    await work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
};

const statementBody = (sequence, make) => {
  const metadata = [];
  const command = { sequence, sql: SQL, params: { id: "wide", name: "AAEC/w==", state: "AA==", metadata } };
  let length = JSON.stringify(command).length;
  // At most 60,000 values: the engine refuses a body past `maxJsonValues` (65,536, ADR 0027).
  for (let index = 0; length < 1_000_000 && index < 60_000; index++) {
    const value = make(index);
    metadata.push(value);
    length += JSON.stringify(value).length + 1;
  }
  return command;
};

for (const [name, make] of Object.entries(SHAPES)) {
  test(`regression: a compiling JSON parameter of up to 60,000 ${name} is hashed fast and answered as before`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { fixture, hooks: false });
    const command = statementBody(1, make);
    const text = JSON.stringify(command);
    assert.ok(text.length > 200_000 && text.length < MAX_BODY_BYTES, `${text.length}`);

    // A deterministic digest and the time bound, on the runtime the owner uses.
    const input = JSON.stringify({ op: "command", kind: "statement", command });
    const digest = JSON.parse(h.runtime.identity_json(input)).digest;
    assert.match(digest, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.parse(h.runtime.identity_json(JSON.stringify({ op: "command", command, kind: "statement" }))).digest, digest);
    const coreMs = await fastest(5, () => h.runtime.identity_json(JSON.stringify({ op: "command", kind: "statement", command })));
    assert.ok(coreMs < ABSOLUTE_BOUND_MS, `${name}: core took ${coreMs.toFixed(1)} ms`);

    // The owner path: the statement compiles and executes, its exact retry replays, and the
    // transaction commits, as on main.
    const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    assert.equal(begun.status, 201, JSON.stringify(begun.body));
    const id = begun.body.transactionId;
    const first = await h.request("a", `/v1/transactions/${id}/statements`, command, null);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual({ ...first.body, meta: undefined }, {
      transactionId: id, status: "active", nextSequence: 2,
      result: { ...first.body.result, sequence: 1, rowCount: 0, affectedRows: 1 },
      meta: undefined,
    });
    const retried = await h.request("a", `/v1/transactions/${id}/statements`, command, null);
    assert.deepEqual(retried, first, "the exact retry replays the recorded response");
    const committed = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null);
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.status, "committed");
    // The row is stored (SQLite's own JSON text formatting of the numbers is not at issue).
    const stored = h.databases.get("a").database.prepare("SELECT json_array_length(metadata) AS n FROM projects WHERE id = 'wide'").get();
    assert.equal(stored.n, command.params.metadata.length);
  });
}
