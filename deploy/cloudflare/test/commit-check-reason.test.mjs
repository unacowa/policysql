// #145 pull request E: a commit check's rejection (409 `POLICYSQL_COMMIT_CHECK_REJECTED`) carries
// `detail.reason`, one of five fixed values the machine chooses from the branch that rejected:
// `denied` (a well-formed `allowed: false`), `unavailable` (no usable answer), `limit` (the
// callback queries read more than the check allows), `unconfigured` (the check has no endpoint)
// and `callback` (a callback query failed). The validator's own text never reaches a response or
// a log. Everything runs on both TransactionOwner adapters, for a keyed and an unkeyed atomic
// execute and for an interactive commit, against a real SQLite behind the real HTTP transport.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { COMMIT_CHECK_REASONS } from "../src/error-detail.ts";

const EXECUTE = "/v1/transactions:execute";
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const KEY = "commit-check-reason-key-01";

/** The three ways a commit reaches its checks. Each returns the rejected response. */
const PATHS = {
  "a keyed atomic execute": (h, id) => h.request("a", EXECUTE, { statements: [insert(id)] }, KEY),
  "an unkeyed atomic execute": (h, id) => h.request("a", EXECUTE, { statements: [insert(id)] }, null),
  "an interactive commit": async (h, id) => {
    const start = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const base = `/v1/transactions/${start.body.transactionId}`;
    assert.equal((await h.request("a", `${base}/statements`, { sequence: 1, ...insert(id) }, null)).status, 200);
    return h.request("a", `${base}/commit`, { sequence: 2 }, null);
  },
};

const logged = (t) => {
  const lines = [];
  t.mock.method(console, "log", (line) => { lines.push(String(line)); });
  return lines;
};
const events = (lines, name) => lines.flatMap((line) => { try { const record = JSON.parse(line); return record.event === name ? [record] : []; } catch { return []; } });
const idempotencyRows = (h) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n;
const decision = (body) => () => Response.json(body);

/** One rejection: its status, code, `detail`, path, and that nothing was committed. */
const expectRejected = (h, response, reason, label, id) => {
  assert.equal(response.status, 409, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED", label);
  assert.equal(response.body.error.message, "A commit check rejected the transaction.");
  assert.equal(response.body.error.path, null, label);
  assert.deepEqual(response.body.error.detail, { reason }, label);
  assert.ok(COMMIT_CHECK_REASONS.includes(response.body.error.detail.reason));
  assert.equal(h.rows("a").some((row) => row.id === id), false, `${label}: nothing was committed`);
};

for (const ownerAdapter of OWNER_ADAPTERS) {
  for (const [pathName, run] of Object.entries(PATHS)) {
    const keyed = pathName.startsWith("a keyed");
    const setup = async (t, options = {}) => {
      const lines = logged(t);
      const h = await harness(t, { ownerAdapter, ...options });
      return Object.assign(h, { lines });
    };
    const prefix = `${ownerAdapter}: ${pathName}`;

    test(`${prefix}: a deny is \`denied\`, and nothing is committed`, async (t) => {
      const h = await setup(t);
      h.setValidator(async () => false);
      const response = await run(h, "denied_row");
      expectRejected(h, response, "denied", "deny", "denied_row");
      if (keyed) assert.equal(idempotencyRows(h), 0);
      assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
    });

    for (const [name, reply] of [
      ["a 503 answer", () => new Response("down", { status: 503 })],
      ["a 503 answer that carries a well-formed deny", () => Response.json({ version: "1", allowed: false }, { status: 503 })],
      ["a body that is not JSON", () => new Response("not json", { status: 200 })],
      ["a decision whose `allowed` is not a boolean", decision({ version: "1", allowed: "no" })],
      ["a decision without `allowed`", decision({ version: "1" })],
      ["an unknown version", decision({ version: "2", allowed: true })],
      ["a deny with an unknown key named like a reason", decision({ version: "1", allowed: false, reason: "limit" })],
      ["a deny that nests a reason", decision({ version: "1", allowed: false, detail: { reason: "limit" } })],
    ]) {
      test(`${prefix}: ${name} is \`unavailable\``, async (t) => {
        const h = await setup(t);
        h.replaceValidatorResponse(reply);
        const response = await run(h, "unavailable_row");
        expectRejected(h, response, "unavailable", name, "unavailable_row");
        if (keyed) assert.equal(idempotencyRows(h), 0);
      });
    }

    test(`${prefix}: a callback query that is not SQL is \`callback\``, async (t) => {
      const h = await setup(t);
      h.setValidator(async (hook) => {
        const response = await h.app.fetchCallback(new Request(hook.query.url, {
          method: "POST", headers: { authorization: `Bearer ${hook.query.token}`, "content-type": "application/json" },
          body: JSON.stringify({ sequence: 1, sql: "NOT SQL", params: {} }),
        }));
        await response.text(); // a validator reads the reply to its query
        return response.ok;
      });
      const response = await run(h, "callback_row");
      expectRejected(h, response, "callback", "bad callback", "callback_row");
    });

    test(`${prefix}: callback queries that read more rows than the check allows are \`limit\``, async (t) => {
      const h = await setup(t, { runtimeLimits: { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8, maxCallbackRows: 1 } });
      h.setValidator(async (hook) => {
        const response = await h.app.fetchCallback(new Request(hook.query.url, {
          method: "POST", headers: { authorization: `Bearer ${hook.query.token}`, "content-type": "application/json" },
          body: JSON.stringify({ sequence: 1, ...read }),
        }));
        await response.text(); // a validator reads the reply to its query
        return response.ok;
      });
      const response = await run(h, "limit_row");
      expectRejected(h, response, "limit", "callback limit", "limit_row");
    });

    test(`${prefix}: a check without an endpoint is \`unconfigured\`, calls no validator, and is logged`, async (t) => {
      const h = await setup(t, { customizeConfig: (config) => ({ ...config, commitChecks: { another_check: config.commitChecks.consistency } }) });
      let calls = 0;
      h.setValidator(async () => { calls += 1; return true; });
      const response = await run(h, "unconfigured_row");
      expectRejected(h, response, "unconfigured", "unconfigured", "unconfigured_row");
      assert.equal(calls, 0);
      assert.equal(events(h.lines, "commit_check_unconfigured").length, 1);
    });

    // The validator's own text is untrusted: whatever `error.code` says, the reason is `denied` and
    // none of it appears in the response or in any log line of the request.
    test(`${prefix}: what a validator puts in \`error.code\` changes nothing and appears nowhere`, async (t) => {
      const h = await setup(t);
      const secret = `VALIDATOR_SECRET_${Math.random().toString(36).slice(2)}`;
      for (const code of [secret, "limit", "unavailable", "<script>alert(1)</script>", '{"reason":"limit"}', "line one\nline two\u0000\u001b[31m", "x".repeat(10_000)]) {
        h.lines.length = 0;
        h.replaceValidatorResponse(decision({ version: "1", allowed: false, error: { code } }));
        const response = await run(h, `leak_row_${code.length}`);
        expectRejected(h, response, "denied", code.slice(0, 20), `leak_row_${code.length}`);
        const text = `${JSON.stringify(response.body)}\n${h.lines.join("\n")}`;
        for (const fragment of [secret, "<script>", "line one", "x".repeat(200)]) {
          if (code.includes(fragment)) assert.equal(text.includes(fragment), false, `"${fragment.slice(0, 20)}" must not appear`);
        }
      }
    });
  }

  // Differential: the same validator behaviour gives the same reason on every path.
  test(`${ownerAdapter}: atomic and interactive commits give the same reason for the same validator behaviour`, async (t) => {
    const reasons = {};
    for (const [name, reply] of [
      ["deny", decision({ version: "1", allowed: false })],
      ["timeout-ish 503", () => new Response("x", { status: 503 })],
    ]) {
      reasons[name] = new Set();
      for (const [pathName, run] of Object.entries(PATHS)) {
        const h = await harness(t, { ownerAdapter });
        h.replaceValidatorResponse(reply);
        const response = await run(h, `diff_row_${name.length}`);
        reasons[name].add(response.body.error.detail.reason);
        assert.equal(response.status, 409, pathName);
      }
    }
    assert.deepEqual(Object.fromEntries(Object.entries(reasons).map(([name, set]) => [name, [...set]])), { deny: ["denied"], "timeout-ish 503": ["unavailable"] });
  });
}
