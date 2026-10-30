// Release-smoke sections for the development-only resources (#42). Each section returns
// `{ failures, report }`: `failures` names every failed expectation (empty when the section
// passed), `report` is the sanitized evidence written to release.json. Neither ever contains a
// token or a secret.
import { randomBytes } from "node:crypto";

const json = { "content-type": "application/json" };
let sequence = 0;
const unique = (prefix) => `${prefix}_${String(Date.now()).padStart(15, "0")}_${String(sequence += 1).padStart(4, "0")}`;

const client = ({ call, baseUrl, headers, expected }) => {
  const post = async (path, body, key) => {
    const started = Date.now();
    const response = await call(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...headers, ...json, ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: response.status, body: parsed, elapsedMs: Date.now() - started };
  };
  return {
    execute: (statements, key = unique("smoke-key")) => post("/v1/transactions:execute", { expected, statements }, key),
    explain: (statements) => post("/v1/transactions:explain", { expected, statements }),
    begin: (mode) => post("/v1/transactions", { mode, expected }, unique("smoke-begin")),
    statement: (id, body) => post(`/v1/transactions/${id}/statements`, body),
    commit: (id, body) => post(`/v1/transactions/${id}/commit`, body),
  };
};

const errorCode = (outcome) => outcome.body?.error?.code ?? null;
const summary = (outcome) => ({ status: outcome.status, code: errorCode(outcome), elapsedMs: outcome.elapsedMs });

const INSERT_PROBE = "INSERT INTO smoke_checks (id, verdict) VALUES (:id, :verdict) RETURNING id, verdict";

/**
 * Commit checks through the dev validator Worker (dev-validator/): allow and deny on Atomic
 * Execute, allow and timeout on an interactive commit. Each allow needs the validator's
 * callback query to see the uncommitted probe row; a denied or timed-out commit must leave no
 * row behind.
 */
export const commitCheckSmoke = async (context) => {
  const api = client(context);
  const failures = [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const ids = { atomicAllow: unique("ccp"), atomicDeny: unique("ccp"), interactiveAllow: unique("ccp"), interactiveTimeout: unique("ccp") };

  const atomicAllow = await api.execute([{ sql: INSERT_PROBE, params: { id: ids.atomicAllow, verdict: "allow" }, expect: { affectedRows: 1 } }]);
  expect(atomicAllow.status === 200, "atomic allow commits");
  const atomicDeny = await api.execute([{ sql: INSERT_PROBE, params: { id: ids.atomicDeny, verdict: "deny" }, expect: { affectedRows: 1 } }]);
  expect(atomicDeny.status === 409 && errorCode(atomicDeny) === "POLICYSQL_COMMIT_CHECK_REJECTED", "atomic deny is rejected");

  const interactive = async (verdict, id) => {
    const begin = await api.begin("write");
    const transactionId = begin.body?.transactionId;
    const statement = begin.status === 201
      ? await api.statement(transactionId, { sequence: 1, sql: INSERT_PROBE, params: { id, verdict } })
      : { status: 0, body: null, elapsedMs: 0 };
    const commit = statement.status === 200
      ? await api.commit(transactionId, { sequence: 2 })
      : { status: 0, body: null, elapsedMs: 0 };
    return { begin, statement, commit };
  };
  const interactiveAllow = await interactive("allow", ids.interactiveAllow);
  expect(interactiveAllow.commit.status === 200 && interactiveAllow.commit.body?.status === "committed", "interactive allow commits");
  const interactiveTimeout = await interactive("timeout", ids.interactiveTimeout);
  expect(interactiveTimeout.statement.status === 200, "interactive timeout probe statement runs");
  expect(interactiveTimeout.commit.status === 409 && errorCode(interactiveTimeout.commit) === "POLICYSQL_COMMIT_CHECK_REJECTED",
    "interactive commit is rejected when the validator misses the hook deadline");
  // The validator holds its answer for 3 s; the hook deadline is at most 1.5 s.
  expect(interactiveTimeout.commit.elapsedMs >= 1_000, "the timed-out commit waited for the hook deadline");

  const verification = await api.execute([{
    sql: "SELECT id, verdict FROM smoke_checks WHERE id IN (:a, :b, :c, :d) ORDER BY id",
    params: { a: ids.atomicAllow, b: ids.atomicDeny, c: ids.interactiveAllow, d: ids.interactiveTimeout },
  }]);
  const committed = verification.body?.results?.[0]?.rows?.map((row) => `${row.id}:${row.verdict}`) ?? null;
  expect(verification.status === 200
    && JSON.stringify(committed) === JSON.stringify([`${ids.atomicAllow}:allow`, `${ids.interactiveAllow}:allow`]),
  "only the allowed probes committed; denied and timed-out commits left no row");

  return {
    failures,
    report: {
      atomicAllow: { ...summary(atomicAllow), commitChecks: atomicAllow.body?.meta?.commitChecks ?? null },
      atomicDeny: summary(atomicDeny),
      interactiveAllow: { begin: interactiveAllow.begin.status, statement: interactiveAllow.statement.status, commit: summary(interactiveAllow.commit) },
      interactiveTimeout: { begin: interactiveTimeout.begin.status, statement: interactiveTimeout.statement.status, commit: summary(interactiveTimeout.commit) },
      committedProbes: committed?.length ?? null,
      deniedRowsLeft: committed === null ? null : committed.filter((entry) => !entry.endsWith(":allow")).length,
    },
  };
};

const INSERT_VALUE = "INSERT INTO smoke_values (id, label, note, payload) VALUES (:id, :label, :note, :payload) RETURNING id, label, note, payload";

/**
 * Bytes (ADR 0016) and NULL assignment (ADR 0017) on the deployed Worker and Turso:
 * round trips of padded, empty and multi-kilobyte BLOBs (returned exactly as canonical
 * padded base64, whatever padding the Hrana response used), a read value submitted back
 * unchanged, the per-value limit (413), a non-canonical input (400), NULL into nullable
 * columns, and NULL rejected in a non-nullable assignment and in a comparison.
 */
export const bytesNullSmoke = async (context, { maxBytesPerValue }) => {
  const api = client(context);
  const failures = [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const ids = { small: unique("sv"), empty: unique("sv"), medium: unique("sv"), copy: unique("sv"), oversized: unique("sv") };
  const small = "AAEC/w=="; // 4 bytes: needs padding.
  const medium = randomBytes(3_001).toString("base64"); // 3001 bytes: "==" padding.

  const written = await api.execute([
    { sql: INSERT_VALUE, params: { id: ids.small, label: "small", note: "kept", payload: small }, expect: { affectedRows: 1 } },
    { sql: INSERT_VALUE, params: { id: ids.empty, label: "empty", note: "kept", payload: "" }, expect: { affectedRows: 1 } },
    { sql: INSERT_VALUE, params: { id: ids.medium, label: "medium", note: "kept", payload: medium }, expect: { affectedRows: 1 } },
  ]);
  const returned = written.body?.results?.map((result) => result.rows?.[0]?.payload) ?? [];
  expect(written.status === 200 && JSON.stringify(returned) === JSON.stringify([small, "", medium]), "RETURNING gives back the written bytes");
  const descriptor = written.body?.results?.[0]?.meta?.result?.columns?.find((column) => column.name === "payload") ?? null;
  expect(descriptor?.type === "bytes" && descriptor?.format === "base64" && descriptor?.nullable === true, "payload is a nullable base64 bytes column");

  const read = await api.execute([{
    sql: "SELECT id, payload FROM smoke_values WHERE id IN (:a, :b, :c) ORDER BY id",
    params: { a: ids.small, b: ids.empty, c: ids.medium },
  }]);
  const readBack = read.body?.results?.[0]?.rows?.map((row) => row.payload) ?? [];
  expect(read.status === 200 && JSON.stringify(readBack) === JSON.stringify([small, "", medium]), "SELECT reads back the same canonical bytes");

  const copied = await api.execute([{ sql: INSERT_VALUE, params: { id: ids.copy, label: "copy", note: "kept", payload: readBack[2] ?? "" }, expect: { affectedRows: 1 } }]);
  expect(copied.status === 200 && copied.body?.results?.[0]?.rows?.[0]?.payload === medium, "a SELECT result is accepted unchanged as a bytes parameter");

  const oversized = await api.execute([{
    sql: INSERT_VALUE,
    params: { id: ids.oversized, label: "oversized", note: null, payload: randomBytes(maxBytesPerValue + 1).toString("base64") },
  }]);
  expect(oversized.status === 413 && errorCode(oversized) === "POLICYSQL_LIMIT_EXCEEDED", "a value over maxBytesPerValue is 413");
  const unpadded = await api.execute([{ sql: INSERT_VALUE, params: { id: unique("sv"), label: "unpadded", note: null, payload: "AAEC/w" } }]);
  expect(unpadded.status === 400 && errorCode(unpadded) === "POLICYSQL_INVALID_PARAMETER", "an unpadded public bytes input is rejected");

  const UPDATE_NULLABLE = "UPDATE smoke_values SET note = :note, payload = :payload WHERE id = :id RETURNING id, label, note, payload";
  const nulled = await api.execute([
    { sql: UPDATE_NULLABLE, params: { id: ids.small, note: null, payload: null }, expect: { affectedRows: 1 } },
    { sql: "SELECT id FROM smoke_values WHERE id = :id AND note IS NULL AND payload IS NULL", params: { id: ids.small }, expect: { rowCount: 1 } },
  ]);
  const nulledRow = nulled.body?.results?.[0]?.rows?.[0] ?? null;
  expect(nulled.status === 200 && nulledRow?.note === null && nulledRow?.payload === null && nulledRow?.label === "small",
    "JSON null stores SQL NULL in nullable columns");
  const labelNull = await api.execute([{ sql: "UPDATE smoke_values SET label = :label WHERE id = :id RETURNING id", params: { id: ids.small, label: null } }]);
  expect(labelNull.status === 400 && errorCode(labelNull) === "POLICYSQL_INVALID_PARAMETER", "NULL into a non-nullable column is rejected");
  const compareNull = await api.execute([{ sql: "SELECT id FROM smoke_values WHERE note = :note", params: { note: null } }]);
  expect(compareNull.status === 400 && errorCode(compareNull) === "POLICYSQL_INVALID_PARAMETER", "NULL in a comparison is rejected");
  const explained = await api.explain([{
    sql: "UPDATE smoke_values SET label = :label, note = :note, payload = :payload WHERE id = :id RETURNING id", params: {},
  }]);
  const nullable = Object.fromEntries((explained.body?.statements?.[0]?.parameters ?? []).map((parameter) => [parameter.name, parameter.nullable]));
  expect(explained.status === 200 && nullable.label === false && nullable.note === true && nullable.payload === true && nullable.id === false,
    "Explain reports the NULL proof per parameter");

  const cleanup = await api.execute([
    { sql: "DELETE FROM smoke_values WHERE id IN (:a, :b, :c, :d) RETURNING id", params: { a: ids.small, b: ids.empty, c: ids.medium, d: ids.copy }, expect: { affectedRows: 4 } },
    { sql: "SELECT id FROM smoke_values WHERE id = :id", params: { id: ids.oversized }, expect: { rowCount: 0 } },
  ]);
  expect(cleanup.status === 200, "cleanup removed the probes and the oversized write left no row");

  return {
    failures,
    report: {
      roundTrip: { status: written.status, sizes: [4, 0, 3_001], returnedExactly: JSON.stringify(returned) === JSON.stringify([small, "", medium]) },
      readBack: { status: read.status, exact: JSON.stringify(readBack) === JSON.stringify([small, "", medium]) },
      resubmitted: summary(copied),
      oversized: { ...summary(oversized), decodedBytes: maxBytesPerValue + 1 },
      unpaddedInput: summary(unpadded),
      nullAssignment: summary(nulled),
      nonNullableNull: summary(labelNull),
      comparisonNull: summary(compareNull),
      explainNullable: nullable,
      cleanup: summary(cleanup),
    },
  };
};
