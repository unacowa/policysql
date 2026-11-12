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
import { COMMIT_CHECK_REASONS, EXCEEDED_LIMITS, REQUEST_LIMITS, TRANSACTION_LIMITS } from "../../src/error-detail.ts";

// #145 pull requests E and F added a detail to these codes; the recorded replies predate it. The
// step side's detail is checked against the code's list and then compared without it: a
// differential normalizer keeps only code, message and path, so it calls `checkedDetail` on every
// error it drops the detail of, and the test pins the values it saw. `optional` rows may also
// carry no detail (a bound without a Capabilities key).
const RECORDED_WITHOUT_DETAIL = Object.freeze({
  POLICYSQL_COMMIT_CHECK_REJECTED: Object.freeze({ key: "reason", values: COMMIT_CHECK_REASONS, optional: false }),
  POLICYSQL_LIMIT_EXCEEDED: Object.freeze({ key: "limit", values: EXCEEDED_LIMITS, optional: true }),
  POLICYSQL_REQUEST_TOO_LARGE: Object.freeze({ key: "limit", values: REQUEST_LIMITS, optional: true }),
  POLICYSQL_TRANSACTION_LIMIT_EXCEEDED: Object.freeze({ key: "limit", values: TRANSACTION_LIMITS, optional: true }),
});
/** The details the step side gave, `"<code> <value>"`, for the test to pin at its end (`<code> -` when it carried none). */
export const observedDetails = new Set();
/**
 * Checks the detail of an error (`error` is the reply's `error`) whose code is in the table:
 * exactly `{ <key>: <one of the code's values> }`, or none where the row is optional. Anything
 * else fails the comparison. Returns the value, or null for a code outside the table.
 */
export const checkedDetail = (error) => {
  const row = Object.hasOwn(RECORDED_WITHOUT_DETAIL, error.code) ? RECORDED_WITHOUT_DETAIL[error.code] : undefined;
  if (row === undefined) return null;
  if (error.detail === undefined && row.optional) {
    observedDetails.add(`${error.code} -`);
    return null;
  }
  assert.deepEqual(Object.keys(error.detail ?? {}), [row.key], `${error.code} carries exactly a ${row.key}: ${JSON.stringify(error.detail)}`);
  assert.ok(row.values.includes(error.detail[row.key]), `a known ${row.key}: ${error.detail[row.key]}`);
  observedDetails.add(`${error.code} ${error.detail[row.key]}`);
  return error.detail[row.key];
};

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
