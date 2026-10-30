// Checked-in reference transcripts (ADR 0024 pull request 9). The differential harnesses of
// pull requests 4-8 ran the TypeScript decision path (`LegacyTransactionOwnerCore` and the
// previous release's `execute`) next to the step machine and compared what both did. Pull
// request 9 deletes the TypeScript path; what it did in every harness scenario is kept here,
// recorded from it while it still existed, and the machine is compared against the record.
//
// A transcript is one JSON file per harness: for every test (by its full name) the ordered
// list of `[label, value]` observations the reference side produced. `take(label)` returns the
// next one and fails when the label differs, so a scenario that drifts from its recording
// fails instead of comparing against the wrong observation; a test that leaves observations
// unused fails too.
//
// POLICYSQL_RECORD_REFERENCE=1 records instead: `take(label, compute)` runs `compute` against
// the live reference side and stores its value (the mode exists only while that side does).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

/** A JSON value as the transcript stores it (`undefined` members dropped, `-0` as `0`). */
export const asRecorded = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value));

const serialize = (stored) => `{\n${Object.keys(stored).sort().map((name) =>
  `${JSON.stringify(name)}: [\n${stored[name].map((entry) => `  ${JSON.stringify(entry)}`).join(",\n")}\n]`).join(",\n")}\n}\n`;

export const referenceTranscript = (url) => {
  const recording = process.env.POLICYSQL_RECORD_REFERENCE === "1";
  const stored = recording ? {} : JSON.parse(readFileSync(url, "utf8"));
  if (recording) process.on("exit", () => writeFileSync(url, serialize(stored)));
  const cursors = new Map();
  return {
    recording,
    /** The reference observations of test `t`, in order. */
    of(t) {
      const name = t.fullName;
      if (!cursors.has(name)) {
        cursors.set(name, 0);
        if (recording) stored[name] = [];
        else {
          assert.ok(Array.isArray(stored[name]), `no reference transcript for ${JSON.stringify(name)}`);
          t.after(() => assert.equal(cursors.get(name), stored[name].length, `${name}: unused reference observations`));
        }
      }
      const entries = stored[name];
      return {
        async take(label, compute) {
          const index = cursors.get(name);
          cursors.set(name, index + 1);
          if (recording) {
            entries.push([label, asRecorded(await compute())]);
            return structuredClone(entries[index][1]);
          }
          assert.ok(index < entries.length, `${name}: the reference transcript ends before ${label}`);
          const [recordedLabel, value] = entries[index];
          assert.equal(recordedLabel, label, `${name}: reference observation ${index}`);
          return structuredClone(value);
        },
      };
    },
  };
};
