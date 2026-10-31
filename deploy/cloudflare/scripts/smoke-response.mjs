// Release-smoke section for the response budget (ADR 0027 pull request 6). Like the other
// sections it returns `{ failures, report }`; neither contains a token or a secret.
//
// A write whose response would exceed `maxResponseBytes` must be refused before COMMIT, against the
// real database and the deployed Worker: 413 `POLICYSQL_LIMIT_EXCEEDED`, the write rolled back, and
// no idempotency record (the same key is free for another body, and the same request runs again
// instead of replaying). The response is made large by the public column descriptors of wide
// SELECTs that return no rows, so no result limit is near.
import { client, errorCode, summary, unique } from "./smoke-sections.mjs";

const WIDE_COLUMNS = 128;
const ALIAS_BYTES = 80;
const INSERT = "INSERT INTO smoke_values (id, label, note, payload) VALUES (:id, :label, :note, :payload) RETURNING id";
const DELETE = "DELETE FROM smoke_values WHERE id = :id RETURNING id";

// A SELECT of `WIDE_COLUMNS` columns with long distinct aliases and no row: its public result is
// about 150 bytes per column of descriptors.
const wideSelect = (statement) => ({
  sql: `SELECT ${Array.from({ length: WIDE_COLUMNS }, (_, column) => `id AS "${`c${statement}_${column}_`.padEnd(ALIAS_BYTES, "x")}"`).join(", ")} FROM projects WHERE id = :none`,
  params: { none: "no_such_project" },
});

/**
 * @param context the call context of the other sections
 * @param limits `{ maxResultBytes, maxResponseBytes, maxStatements }` as the deployed Capabilities
 *   advertise them
 */
export const responseBudgetSmoke = async (context, { limits }) => {
  const api = client(context);
  const failures = [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const { maxResultBytes, maxResponseBytes, maxStatements } = limits;
  const report = { maxResultBytes, maxResponseBytes };
  expect(Number.isInteger(maxResponseBytes) && maxResponseBytes >= maxResultBytes + 3_072, "Capabilities advertises maxResponseBytes, at least maxResultBytes + 3,072");
  if (failures.length > 0) return { failures, report };

  const probe = unique("rsp");
  const key = unique("smoke-response-key");
  const write = (id) => ({ sql: INSERT, params: { id, label: "response budget", note: null, payload: null } });
  const selects = (count) => Array.from({ length: count }, (_, statement) => wideSelect(statement));
  const present = async (id) => {
    const outcome = await api.execute([{ sql: "SELECT id FROM smoke_values WHERE id = :id", params: { id } }]);
    return outcome.status === 200 ? (outcome.body?.results?.[0]?.rows ?? []).length : -1;
  };

  // A positive control: a few wide statements are within the limit, so the width itself is not
  // refused. The write commits and is cleaned up.
  const controlId = unique("rsp");
  const control = await api.execute([write(controlId), ...selects(2)], unique("smoke-response-control"));
  report.control = { ...summary(control), responseBytes: JSON.stringify(control.body).length };
  expect(control.status === 200, "a response well within maxResponseBytes is served");
  await api.execute([{ sql: DELETE, params: { id: controlId } }]);

  // Enough wide statements that the response (plus the 1,024-byte reserve) exceeds the limit
  // while every row-based limit is far away: at least 4 statements more than the control.
  const wide = Math.min(maxStatements - 1, 12);
  const refused = await api.execute([write(probe), ...selects(wide)], key);
  report.refused = summary(refused);
  expect(refused.status === 413 && errorCode(refused) === "POLICYSQL_LIMIT_EXCEEDED", "a response over maxResponseBytes is 413 POLICYSQL_LIMIT_EXCEEDED");
  expect(JSON.stringify(refused.body ?? {}).length < 2_048, "the refusal carries no part of the response");
  expect(await present(probe) === 0, "the write of a refused response was rolled back");

  // No idempotency record: the same key is free for a different body (a conflict would be 409), and
  // that body commits; the key is then bound to it.
  const other = await api.execute([write(probe)], key);
  report.keyFree = summary(other);
  expect(other.status === 200, "the key of a refused response is free: another body commits under it");
  expect(await present(probe) === 1, "the other body wrote its row");
  // The refused request itself was not replayed from a record and does not conflict now: its key is
  // bound to the other body, so the refused body is a conflict (409), proving the first attempt left
  // nothing and the second is the first record.
  const conflict = await api.execute([write(probe), ...selects(wide)], key);
  report.afterwards = summary(conflict);
  expect(conflict.status === 409 && errorCode(conflict) === "POLICYSQL_IDEMPOTENCY_CONFLICT", "after another body committed under the key, the refused body conflicts: no record was left by the refused attempt");

  // The same refused request with a fresh key runs again from scratch (nothing is remembered).
  const again = await api.execute([write(unique("rsp")), ...selects(wide)], unique("smoke-response-key"));
  expect(again.status === 413 && errorCode(again) === "POLICYSQL_LIMIT_EXCEEDED", "a retry of the refused shape is refused the same way, as a new attempt");

  await api.execute([{ sql: DELETE, params: { id: probe } }]);
  return { failures, report };
};
