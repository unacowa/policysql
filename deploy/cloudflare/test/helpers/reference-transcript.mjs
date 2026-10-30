// Checked-in reference transcripts (ADR 0024 pull request 9). The differential harnesses of
// pull requests 4-8 ran the TypeScript decision path (`LegacyTransactionOwnerCore` and the
// previous release's `execute`) next to the step machine and compared what both did. Pull
// request 9 deleted the TypeScript path; what it did in every harness scenario was recorded from
// it before the deletion (commit 956bacf, `POLICYSQL_RECORD_REFERENCE=1`), and the machine is
// compared against the record.
//
// A transcript is one JSON file per test file: for every test (by its full name) the ordered
// list of `[label, value]` observations the reference side produced. `take(label)` returns the
// next one and fails when the label differs, so a scenario that drifts from its recording
// fails instead of comparing against the wrong observation; a test that leaves observations
// unused fails too. The recordings cannot be regenerated: a scenario whose reference changes
// must assert the machine's behavior directly instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** A JSON value as the transcript stores it (`undefined` members dropped, `-0` as `0`). */
export const asRecorded = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value));

export const referenceTranscript = (url) => {
  const stored = JSON.parse(readFileSync(url, "utf8"));
  const cursors = new Map();
  return {
    /** The reference observations of test `t`, in order. */
    of(t) {
      const name = t.fullName;
      const entries = stored[name];
      assert.ok(Array.isArray(entries), `no reference transcript for ${JSON.stringify(name)}`);
      if (!cursors.has(name)) {
        cursors.set(name, 0);
        t.after(() => assert.equal(cursors.get(name), entries.length, `${name}: unused reference observations`));
      }
      return {
        take(label) {
          const index = cursors.get(name);
          cursors.set(name, index + 1);
          assert.ok(index < entries.length, `${name}: the reference transcript ends before ${label}`);
          const [recordedLabel, value] = entries[index];
          assert.equal(recordedLabel, label, `${name}: reference observation ${index}`);
          return structuredClone(value);
        },
      };
    },
  };
};
