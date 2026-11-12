// The commit-check release-smoke section against a stand-in for the deployed Worker (#145 pull
// request E): it passes when a deny and a missed hook deadline carry their fixed reasons, and it
// names the failure when the reason is dropped or wrong on the way, which is still a 409 and only
// the reason check can see.
import assert from "node:assert/strict";
import test from "node:test";
import { commitCheckSmoke } from "../scripts/smoke-sections.mjs";

const rejection = (reason) => ({ error: { code: "POLICYSQL_COMMIT_CHECK_REJECTED", message: "A commit check rejected the transaction.", path: null, ...(reason === undefined ? {} : { detail: { reason } }), requestId: "r" } });

/** A Worker that decides each probe by its `verdict`, with the reasons of `reasons` (`deny`, `timeout`). */
const standIn = (reasons) => {
  const rows = new Map();
  const transactions = new Map();
  const respond = (status, body) => new Response(JSON.stringify(body), { status });
  return async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    if (path === "/v1/transactions:execute") {
      const [statement] = body.statements;
      if (statement.sql.startsWith("INSERT")) {
        const { id, verdict } = statement.params;
        if (verdict === "deny") return respond(409, rejection(reasons.deny));
        rows.set(id, verdict);
        return respond(200, { status: "committed", results: [{ rows: [{ id, verdict }] }], meta: { commitChecks: "passed" } });
      }
      const wanted = Object.values(statement.params);
      return respond(200, { results: [{ rows: [...rows].filter(([id]) => wanted.includes(id)).sort().map(([id, verdict]) => ({ id, verdict })) }] });
    }
    if (path === "/v1/transactions") {
      const transactionId = `tx_${transactions.size}`;
      transactions.set(transactionId, {});
      return respond(201, { transactionId, status: "active" });
    }
    const [, , , transactionId, kind] = path.split("/");
    if (kind === "statements") { transactions.get(transactionId).insert = body.params; return respond(200, { status: "active" }); }
    const { id, verdict } = transactions.get(transactionId).insert;
    if (verdict === "timeout") { await new Promise((resolve) => setTimeout(resolve, 1_050)); return respond(409, rejection(reasons.timeout)); }
    rows.set(id, verdict);
    return respond(200, { status: "committed", meta: { commitChecks: "passed" } });
  };
};
const run = (reasons) => commitCheckSmoke({ call: standIn(reasons), baseUrl: "https://worker.test", headers: {}, expected: undefined });

test("the section passes when a deny is `denied` and a missed hook deadline is `unavailable`", async () => {
  const { failures, report } = await run({ deny: "denied", timeout: "unavailable" });
  assert.deepEqual(failures, []);
  assert.equal(report.atomicDeny.reason, "denied");
  assert.equal(report.interactiveTimeout.commit.reason, "unavailable");
  assert.equal(JSON.stringify(report).includes("SELECT"), false);
});

test("a rejection that lost its reason, or carries another one, is named as a failure", async () => {
  for (const [reasons, names] of [
    [{ deny: undefined, timeout: "unavailable" }, ["atomic deny carries the reason `denied`"]],
    [{ deny: "denied", timeout: undefined }, ["the timed-out commit carries the reason `unavailable`"]],
    [{ deny: "callback", timeout: "denied" }, ["atomic deny carries the reason `denied`", "the timed-out commit carries the reason `unavailable`"]],
  ]) {
    const { failures } = await run(reasons);
    assert.deepEqual(failures, names, JSON.stringify(reasons));
  }
});
