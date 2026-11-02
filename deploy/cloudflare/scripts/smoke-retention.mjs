// Release-smoke section for the idempotency cleanup (ADR 0028). It runs against the real Turso
// database with the deployment's administrative credentials and checks what only the real
// database can show:
//
//   - the table is the canonical shape: `created_at` exists and the table is not WITHOUT ROWID
//     (the batch DELETE selects by rowid, and on such a table it fails);
//   - the batch DELETE deletes by age only: a row older than the window goes, a fresh row stays,
//     in the same run;
//   - the deployment runs its `scheduled` handler on a Cron Trigger (the schedule the
//     Cloudflare API reports for the deployed Worker).
//
// The probe rows use key hashes no client can produce (`smoke_retention_` prefix) and are
// removed at the end, deleted or not.
import {
  IDEMPOTENCY_CLEANUP_MAX_BATCHES, IDEMPOTENCY_COLUMNS_SQL, cleanupIdempotency, transportCleanupRunner,
} from "../wrapper/idempotency-retention.ts";

const PROBE_PREFIX = "smoke_retention_";
// The stale probe names `created_at`; the fresh one omits it, so the database fills it, exactly
// as core's INSERT does.
const INSERT_STALE =
  "INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json, created_at) " +
  "VALUES (:key_hash, :fingerprint, :response_json, :created_at)";
const INSERT_FRESH =
  "INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) " +
  "VALUES (:key_hash, :fingerprint, :response_json)";
const SELECT_PROBE = "SELECT key_hash FROM policysql_idempotency WHERE key_hash = :key_hash";
const DELETE_PROBE = "DELETE FROM policysql_idempotency WHERE key_hash = :key_hash";

/**
 * `connection`: `{ url, token }` of the deployed application database (administrative, full
 * access). The runner takes the library's own `{ url, authToken }` shape, so the token is
 * renamed here rather than in every caller.
 * `retentionSeconds`, `batchSize`: the window and batch the deployed Worker uses.
 * `schedule`: a promise of the Cloudflare API's `schedules` result for the deployed Worker.
 */
export const idempotencyRetentionSmoke = async ({
  connection, retentionSeconds, batchSize, schedule, create = transportCleanupRunner,
}) => {
  const failures = [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const report = {};
  const log = () => {};
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const oldKey = `${PROBE_PREFIX}old_${stamp}`;
  const freshKey = `${PROBE_PREFIX}fresh_${stamp}`;
  const probe = { key_hash: oldKey, fingerprint: "0".repeat(64), response_json: "{}", created_at: "2000-01-01 00:00:00" };
  let inserted = false;
  let run;
  try {
    // The runner is built inside the try: an unusable connection is a failed expectation of this
    // section, classified like any other failure, not an exception that ends the whole release.
    run = create({ url: connection.url, authToken: connection.token }, "release-smoke-retention");

    // 1. The canonical shape, read through the same transport the cleanup uses.
    const columns = await run(IDEMPOTENCY_COLUMNS_SQL, {}, "read");
    const names = columns.rows.map((row) => row[columns.columns.indexOf("name")]);
    report.columns = names;
    expect(names.includes("created_at"), "the idempotency table has created_at");
    const ddl = await run(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'policysql_idempotency'",
      {}, "read",
    );
    const definition = String(ddl.rows[0]?.[ddl.columns.indexOf("sql")] ?? "");
    report.withoutRowid = /WITHOUT\s+ROWID/iu.test(definition);
    expect(definition !== "" && !report.withoutRowid, "the idempotency table is not WITHOUT ROWID");

    // A shape the cleanup cannot work on is reported once, by the shape check above, rather than
    // again as a failed probe: the rest of the section would only restate it in the negative.
    if (report.withoutRowid || !names.includes("created_at")) return { failures, report };

    // 2. One row far outside the window and one fresh row, then one cleanup run.
    await run(INSERT_STALE, probe, "write");
    inserted = true;
    await run(INSERT_FRESH, { key_hash: freshKey, fingerprint: probe.fingerprint, response_json: probe.response_json }, "write");
    const result = await cleanupIdempotency(run, {
      retentionSeconds, batchSize, maxBatches: IDEMPOTENCY_CLEANUP_MAX_BATCHES, log,
    });
    report.cleanup = { outcome: result.outcome, deleted: result.deleted, batches: result.batches };
    expect(result.outcome === "deleted", "the cleanup deleted rows");
    expect(result.deleted >= 1, "the cleanup deleted at least the stale probe row");
    const oldLeft = await run(SELECT_PROBE, { key_hash: oldKey }, "read");
    const freshLeft = await run(SELECT_PROBE, { key_hash: freshKey }, "read");
    report.oldRows = oldLeft.rows.length;
    report.freshRows = freshLeft.rows.length;
    expect(oldLeft.rows.length === 0, "a row older than the window is deleted");
    expect(freshLeft.rows.length === 1, "a row inside the window is kept");

    // 3. The deployed Worker runs the cleanup on a schedule. The Cloudflare API returns
    // `{ schedules: [{ cron, created_on, modified_on }] }`; an array is accepted too, so a change
    // in the envelope is a failure of this expectation rather than a crash.
    const listed = await schedule;
    const entries = Array.isArray(listed) ? listed : Array.isArray(listed?.schedules) ? listed.schedules : [];
    const crons = entries.map((entry) => entry?.cron).filter((cron) => typeof cron === "string" && cron !== "");
    report.crons = crons;
    expect(crons.length > 0, "the deployed Worker has a Cron Trigger");
  } catch (error) {
    // The failure is classified: a database or API error can name tables and columns.
    report.error = error instanceof Error ? error.name : "unknown";
    failures.push("the retention probe ran to completion");
  } finally {
    if (inserted && run) {
      // The probe rows are removed whatever happened; a failure here is not a smoke failure.
      for (const key_hash of [oldKey, freshKey]) {
        await run(DELETE_PROBE, { key_hash }, "write").catch(() => {});
      }
    }
  }
  return { failures, report };
};
