// The constraint-violation release-smoke section (#145, ADR 0030) against real SQLite behind the
// simulated Turso server. It is a smoke, not library code, but a wrong expectation here fails a
// release, so the section runs with its expectations checked: it passes with the library's
// transport, covers every message prefix and kind the library classifies, and names the probes of
// a transport that classifies nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { CONSTRAINT_PROBES, CONSTRAINT_TABLES, constraintSmoke } from "../scripts/smoke-constraint.mjs";
import { CONSTRAINT_KINDS, CONSTRAINT_PREFIXES, SqlConstraintError } from "../src/database-constraint.ts";
import { CommitNotSentError } from "../src/errors.ts";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

const classify = (error) => (error instanceof SqlConstraintError ? { constraint: error.constraint, statement: error.statement } : null);
const isCommitNotSent = (error) => error instanceof CommitNotSentError;

const NAMES = ["check", "foreign_key_delete", "foreign_key_insert", "not_null", "primary_key", "trigger_abort", "unique"];

test("the probes cover every verified prefix and every kind", () => {
  const covered = new Set(CONSTRAINT_PROBES.map((probe) => probe.expected));
  for (const entry of CONSTRAINT_PREFIXES.filter((candidate) => candidate.smokeVerified)) {
    assert.ok(covered.has(entry.constraint), `a probe produces ${entry.prefix}`);
  }
  for (const kind of CONSTRAINT_KINDS) assert.ok(covered.has(kind), `a probe expects ${kind}`);
  assert.deepEqual(CONSTRAINT_PROBES.map((probe) => probe.name).sort(), NAMES);
});

for (const ownerAdapter of OWNER_ADAPTERS) {
  test(`${ownerAdapter}: the section passes with the library's transport and reports each probe`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter });
    h.databases.get("a").database.exec(CONSTRAINT_TABLES.join(";"));
    const transport = h.database.connect(h.binding("a"), "smoke");
    const { failures, report } = await constraintSmoke({ transport, classify, isCommitNotSent });
    assert.deepEqual(failures, []);
    assert.deepEqual(Object.keys(report.probes).sort(), NAMES);
    for (const probe of CONSTRAINT_PROBES) {
      assert.deepEqual(report.probes[probe.name], { constraint: probe.expected, statement: 1, rollback: "ok", rowsAfter: 0 }, probe.name);
    }
    assert.deepEqual(report.deferred, { classified: false, commitNotSent: false, rowsAfter: 0 });
    // Nothing secret or textual in what a release prints.
    const text = JSON.stringify(report);
    for (const fragment of ["SELECT", "constraint failed", "smoke guard"]) assert.equal(text.includes(fragment), false, fragment);
  });

  test(`${ownerAdapter}: a transport that classifies nothing names every probe as a failure`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter });
    h.databases.get("a").database.exec(CONSTRAINT_TABLES.join(";"));
    const transport = h.database.connect(h.binding("a"), "smoke");
    const { failures } = await constraintSmoke({ transport, classify: () => null, isCommitNotSent });
    for (const name of NAMES) assert.ok(failures.some((failure) => failure.startsWith(`${name}: the refusal is classified`)), `${name}: ${JSON.stringify(failures)}`);
    for (const failure of failures) assert.equal(/INSERT|SELECT|UNIQUE|DELETE/u.test(failure), false, failure);
  });
}
