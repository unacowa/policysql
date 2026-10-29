import test from "node:test";
import assert from "node:assert/strict";
import { RedirectRejectedError, fetchNoFollow } from "../src/redirects.ts";
import { redirectResponses } from "./helpers/redirects.mjs";

// Regression (#36): the single outbound exit forces "manual" (workerd rejects the
// "error" mode) and rejects redirects before any caller can read them.
test("fetchNoFollow forces manual redirects even when a caller tries to override them", async () => {
  const seen = [];
  const fake = async (url, init) => { seen.push(init.redirect); return new Response("ok"); };
  await fetchNoFollow("https://db.test/", { method: "POST" }, fake);
  await fetchNoFollow("https://db.test/", { method: "POST", redirect: "follow" }, fake);
  await fetchNoFollow("https://db.test/", { method: "POST", redirect: "error" }, fake);
  assert.deepEqual(seen, ["manual", "manual", "manual"]);
});

test("fetchNoFollow rejects 3xx and opaqueredirect responses after discarding them unread", async () => {
  for (const { label, response, state } of redirectResponses()) {
    let calls = 0;
    await assert.rejects(
      fetchNoFollow("https://db.test/", { method: "POST" }, async () => { calls += 1; return response; }),
      RedirectRejectedError,
      label,
    );
    assert.equal(calls, 1, `${label}: not followed`);
    assert.equal(state.read, false, `${label}: not read`);
    assert.equal(state.cancelled, true, `${label}: released`);
  }
});

test("fetchNoFollow returns non-redirect responses and propagates fetch errors unchanged", async () => {
  for (const status of [200, 204, 299, 400, 401, 500, 503]) {
    const response = new Response(status === 204 ? null : "body", { status });
    assert.equal(await fetchNoFollow("https://db.test/", {}, async () => response), response, String(status));
  }
  const timeout = new DOMException("timed out", "TimeoutError");
  await assert.rejects(fetchNoFollow("https://db.test/", {}, async () => { throw timeout; }), (error) => error === timeout);
});
