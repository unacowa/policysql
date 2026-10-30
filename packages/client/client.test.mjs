import assert from "node:assert/strict";
import test from "node:test";
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError, createHttpTransport } from "./index.js";
import { mockGateway, errorBody } from "./test-fixture.mjs";

const select = "SELECT id FROM posts";
const setup = (options = {}, wrap = f => f) => {
  const gateway = mockGateway();
  const http = createHttpTransport({ endpoint: "https://gateway.test", fetchImpl: gateway.fetchImpl });
  return { ...gateway, client: new PolicySqlClient({ transport: wrap(http), ...options }) };
};

test("minimal client sends only the requested operation, with optional fixed role and paired versions", async () => {
  for (const options of [{}, { role: "author", schemaVersion: "s1", policyVersion: "p1" }]) {
    const h = setup(options);
    await h.client.execute(select);
    const tx = await h.client.beginTransaction();
    assert.equal(h.calls.length, 2);
    for (const call of h.calls) {
      assert.equal(call.headers.get("policysql-role"), options.role ?? null);
      assert.deepEqual(call.body.expected, options.role ? { schemaVersion: "s1", policyVersion: "p1" } : undefined);
    }
    await tx.rollback();
  }
});

test("construction requires a function Transport and fixes all configuration at runtime", async () => {
  const requests = [];
  const config = { transport: async request => { requests.push(request); return { status: 200, body: { status: "committed", results: [{ rows: [], meta: {} }], meta: {} } }; }, role: "author", schemaVersion: "s1", policyVersion: "p1" };
  const client = new PolicySqlClient(config);
  Object.assign(config, { transport: () => { throw new Error("replaced"); }, role: "admin", schemaVersion: "s2", policyVersion: "p2" });
  for (const key of ["role", "schemaVersion", "policyVersion", "transport"]) assert.throws(() => { client[key] = "changed"; }, TypeError);
  await client.execute(select);
  assert.equal(requests[0].role, "author");
  assert.equal(Object.isFrozen(requests[0]), true);
  assert.deepEqual(JSON.parse(requests[0].body).expected, { schemaVersion: "s1", policyVersion: "p1" });
  for (const config of [undefined, null, {}, { transport: {} }, { transport: null }, { transport: async () => {}, token: "old" },
    { transport: async () => {}, role: null }, { transport: async () => {}, role: "ADMIN" },
    { transport: async () => {}, schemaVersion: "s1" }, { transport: async () => {}, policyVersion: "p1" },
    { transport: async () => {}, schemaVersion: "", policyVersion: "p1" }]) assert.throws(() => new PolicySqlClient(config), TypeError);
});

test("invalid parameters, keys, expectations and start options fail before Transport", async () => {
  const h = setup();
  for (const params of [null, [], { x: undefined }, { x: NaN }, { x: 1n }, { x: new Date() }]) await assert.rejects(h.client.execute(select, params), TypeError);
  for (const options of [{ idempotencyKey: null }, { idempotencyKey: "short" }, { expect: {} }, { expect: { rowCount: -1 } }, { extra: true }]) await assert.rejects(h.client.execute(select, {}, options), TypeError);
  for (const options of [null, { mode: null }, { mode: "bad" }, { idempotencyKey: "unsupported-start-key" }]) await assert.rejects(h.client.beginTransaction(options), TypeError);
  assert.equal(h.calls.length, 0);
});

test("validated server error preserves its public response and message", async () => {
  const body = errorBody("POLICYSQL_STALE_OPERATION", "Regenerate this operation.");
  const h = setup({}, () => async () => ({ status: 409, body }));
  await assert.rejects(h.client.execute(select), error => {
    assert.ok(error instanceof PolicySqlError);
    assert.equal(error.code, body.error.code);
    assert.equal(error.message, body.error.message);
    assert.equal(error.status, 409);
    assert.deepEqual(error.response, { status: 409, body });
    assert.notEqual(error.response.body, body);
    return true;
  });
});

test("atomic owner conflicts are validated rejections, including commit-check execution", async () => {
  const body = errorBody("POLICYSQL_TRANSACTION_CONFLICT");
  const h = setup({}, () => async () => ({ status: 409, body }));
  await assert.rejects(h.client.execute(select), error => error.status === 409 && error.response.body.error.code === body.error.code);
});

test("Transport throws are never treated as server rejection, and their original causes survive", async () => {
  for (const cause of [new Error("network details"), new PolicySqlError("spoofed", "POLICYSQL_STALE_OPERATION", 409), { reason: "custom" }, undefined]) {
    let count = 0;
    const h = setup({}, () => async () => { count++; throw cause; });
    for (const invoke of [() => h.client.execute(select), () => h.client.beginTransaction()]) {
      await assert.rejects(invoke(), error => error instanceof PolicySqlOutcomeUnknownError && error.cause === cause);
    }
    assert.equal(count, 2);
  }
});

test("unverifiable responses remain unknown without automatic replay", async () => {
  for (const response of [undefined, { status: 500, body: errorBody("POLICYSQL_INTERNAL") },
    { status: 403, body: { error: { code: "POLICYSQL_FORBIDDEN_ACCESS" } } },
    { status: 403, body: errorBody("POLICYSQL_NEW_ERROR") },
    { status: 200, body: { status: "failed", results: [], meta: {} } },
    { status: 200, body: { status: "committed", results: [{ rows: "bad", meta: {} }], meta: {} } }]) {
    let count = 0;
    const h = setup({}, () => async () => { count++; return response; });
    await assert.rejects(h.client.execute(select), { code: "POLICYSQL_OUTCOME_UNKNOWN", phase: "execute" });
    assert.equal(count, 1);
  }
});

test("lost begin response does not retry or allocate a second owner", async () => {
  const h = setup({}, send => async request => { await send(request); throw new Error("lost begin"); });
  await assert.rejects(h.client.beginTransaction(), { code: "POLICYSQL_OUTCOME_UNKNOWN", phase: "begin" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.transactions.size, 1);
});

for (const terminal of ["commit", "rollback"]) test(`explicit statement and ${terminal} confirmation preserves bytes, sequence and role`, async () => {
  const lost = new Set();
  const requests = [];
  const h = setup({ role: "author" }, send => async request => {
    requests.push(request);
    const response = await send(request);
    if (["statement", terminal].includes(request.kind) && !lost.has(request.kind)) { lost.add(request.kind); throw new Error("lost"); }
    return response;
  });
  const tx = await h.client.beginTransaction();
  const params = { id: "original" };
  const pending = tx.execute("SELECT id FROM posts WHERE id = :id", params);
  params.id = "changed";
  await assert.rejects(pending, { phase: "statement", sequence: 1 });
  assert.equal(h.calls.length, 2);
  await assert.rejects(tx.execute(select), { phase: "statement" });
  const recovered = await tx.retryPending();
  assert.equal(recovered.rows.length, 1);
  await assert.rejects(tx[terminal](), { phase: terminal, sequence: 2 });
  assert.equal(h.calls.length, 4);
  await tx[terminal]();
  assert.deepEqual(h.calls.map(c => c.body.sequence), [undefined, 1, 1, 2, 2]);
  assert.equal(requests[1], requests[2]);
  assert.equal(requests[3], requests[4]);
  assert.equal(JSON.parse(requests[1].body).params.id, "original");
  await tx.closed;
});

test("later rejection or cancellation retains unknown commit and its original cause", async () => {
  const original = new Error("lost commit");
  let attempt = 0;
  const h = setup({}, send => async request => {
    if (request.kind !== "commit") return send(request);
    if (++attempt === 1) { await send(request); throw original; }
    return { status: 401, body: errorBody("POLICYSQL_UNAUTHENTICATED") };
  });
  const tx = await h.client.beginTransaction();
  let failure;
  await assert.rejects(tx.commit(), error => { failure = error; return error.cause === original; });
  await assert.rejects(tx.commit(), error => error === failure && error.lastError.code === "POLICYSQL_UNAUTHENTICATED");
  assert.equal(attempt, 2);
  const cancel = new Error("cancel confirmation");
  await assert.rejects(tx.retryPending({ signal: AbortSignal.abort(cancel) }), error => error === failure && error.lastError === cancel);
  assert.equal(failure.cause, original);
  await assert.rejects(tx.rollback(), error => error === failure);
  await tx.dispose();
  assert.equal(h.calls.some(c => c.path.endsWith("rollback")), false);
  assert.equal(tx.status, "unknown");
});

test("pre-call cancellation preserves the standard reason without making a pending command", async () => {
  const h = setup();
  const reason = new Error("cancelled by application");
  const signal = AbortSignal.abort(reason);
  await assert.rejects(h.client.execute(select, {}, { signal }), error => error === reason);
  await assert.rejects(h.client.beginTransaction({ signal }), error => error === reason);
  assert.equal(h.calls.length, 0);
  const tx = await h.client.beginTransaction();
  await assert.rejects(tx.execute(select, {}, { signal }), error => error === reason);
  await assert.rejects(tx.commit({ signal }), error => error === reason);
  await tx.rollback();
  assert.deepEqual(h.calls.map(c => c.body.sequence), [undefined, 1]);
});

test("cancellation during Transport is unknown, with the original AbortSignal reason", async () => {
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  const h = setup({}, () => async (_request, { signal }) => {
    assert.equal(signal, controller.signal);
    entered.resolve();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const reason = new Error("cancel in flight");
  const checked = assert.rejects(h.client.execute(select, {}, { signal: controller.signal }), error => error.phase === "execute" && error.cause === reason);
  await entered.promise;
  controller.abort(reason);
  await checked;
});

test("local clocks and elapsed time do not expire transactions or bound requests", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const h = setup({}, send => async request => {
    const response = await send(request);
    if (request.kind === "begin") response.body.expiresAt = "2000-01-01T00:00:00Z";
    return response;
  });
  const tx = await h.client.beginTransaction();
  t.mock.timers.tick(100_000);
  assert.equal(tx.status, "active");
  await tx.execute(select);
  await tx.commit();
  assert.equal(tx.status, "committed");
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const slow = setup({}, send => async (request, options) => { entered.resolve(); await resume.promise; return send(request, options); });
  let settled = false;
  const operation = slow.client.execute(select).then(result => { settled = true; return result; });
  await entered.promise;
  t.mock.timers.tick(100_000);
  await Promise.resolve();
  assert.equal(settled, false);
  resume.resolve();
  await operation;
});

test("malformed begin, statement and terminal responses never advance the state", async () => {
  for (const kind of ["begin", "statement", "commit", "rollback"]) {
    const h = setup({}, send => async request => {
      const response = await send(request);
      if (request.kind === kind) response.body = { ...response.body, ...(kind === "begin" ? { transactionId: "../bad" } : kind === "statement" ? { nextSequence: 99 } : { status: "failed" }) };
      return response;
    });
    if (kind === "begin") { await assert.rejects(h.client.beginTransaction(), { phase: kind }); assert.equal(h.calls.length, 1); continue; }
    const tx = await h.client.beginTransaction();
    await assert.rejects(kind === "statement" ? tx.execute(select) : tx[kind](), { phase: kind, sequence: 1 });
    assert.equal(tx.nextSequence, 1);
    assert.equal(tx.status, "unknown");
    assert.equal(h.calls.length, 2);
    await tx.dispose();
  }
});

test("terminal queuing preserves submitted statements and rejects later work", async () => {
  const h = setup();
  const tx = await h.client.beginTransaction();
  const first = tx.execute(select);
  const second = tx.execute(select);
  const commit = tx.commit();
  await assert.rejects(tx.execute(select));
  await Promise.all([first, second, commit]);
  assert.deepEqual(h.calls.map(call => call.body.sequence), [undefined, 1, 2, 3]);
});

test("unsent terminal attempts do not prevent continuing after explicit statement confirmation", async () => {
  let lose = true;
  const h = setup({}, send => async request => {
    const response = await send(request);
    if (request.kind === "statement" && lose) { lose = false; throw new Error("lost statement"); }
    return response;
  });
  const tx = await h.client.beginTransaction();
  const statement = tx.execute(select);
  const commit = tx.commit(); // Already queued when the preceding response is lost.
  await assert.rejects(statement, { phase: "statement" });
  await assert.rejects(commit, { phase: "statement" });
  await assert.rejects(tx.rollback(), { phase: "statement" });
  await tx.retryPending();
  await tx.execute(select);
  await tx.rollback();
  assert.deepEqual(h.calls.map(c => c.body.sequence), [undefined, 1, 1, 2, 3]);
});

test("commit waits for an in-flight statement without sending concurrently", async () => {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const h = setup({}, send => async request => {
    if (request.kind === "statement") { entered.resolve(); await resume.promise; }
    return send(request);
  });
  const tx = await h.client.beginTransaction();
  const statement = tx.execute(select);
  await entered.promise;
  const commit = tx.commit();
  assert.equal(h.calls.length, 1);
  resume.resolve();
  await Promise.all([statement, commit]);
  assert.deepEqual(h.calls.map(c => c.body.sequence), [undefined, 1, 2]);
});

test("concurrent dispose rolls back once; an explicit rollback failure is not hidden", async () => {
  const h = setup();
  const tx = await h.client.beginTransaction();
  await Promise.all([tx.dispose(), tx.dispose()]);
  assert.deepEqual(h.calls.map(c => c.body.sequence), [undefined, 1]);
  const broken = setup({}, send => async request => {
    if (request.kind === "rollback") throw new Error("rollback lost");
    return send(request);
  });
  const other = await broken.client.beginTransaction();
  await assert.rejects(other.dispose(), { phase: "rollback", code: "POLICYSQL_OUTCOME_UNKNOWN" });
  assert.equal(other.status, "unknown");
});

test("503 COMMIT_OUTCOME_UNKNOWN on a commit is an unknown outcome; retryPending resends the same commit (#48)", async () => {
  // Also as an earlier Worker that maps the code by its own table would serve it: 500.
  for (const status of [503, 500]) {
    const unknown = errorBody("POLICYSQL_COMMIT_OUTCOME_UNKNOWN", "The commit outcome is unknown.");
    let attempts = 0;
    const requests = [];
    const h = setup({}, send => async request => {
      if (request.kind !== "commit") return send(request);
      requests.push(request);
      // The first two attempts get the unknown outcome; the third finds the recorded reply.
      if (++attempts <= 2) { if (attempts === 1) await send(request); return { status, body: unknown }; }
      return send(request);
    });
    const tx = await h.client.beginTransaction();
    let failure;
    await assert.rejects(tx.commit(), error => {
      failure = error;
      return error instanceof PolicySqlOutcomeUnknownError && error.phase === "commit" && error.sequence === 1 &&
        error.cause.code === "POLICYSQL_COMMIT_OUTCOME_UNKNOWN" && error.cause.status === status;
    });
    assert.equal(tx.status, "unknown", String(status));
    // A contradictory rollback is never sent while the commit is unresolved.
    await assert.rejects(tx.rollback(), error => error === failure);
    await assert.rejects(tx.retryPending(), error => error === failure &&
      error.lastError instanceof PolicySqlOutcomeUnknownError && error.lastError.cause.code === "POLICYSQL_COMMIT_OUTCOME_UNKNOWN");
    assert.equal(tx.status, "unknown");
    assert.equal(await tx.retryPending(), undefined);
    assert.equal(tx.status, "committed");
    assert.equal(attempts, 3);
    assert.ok(requests.every((request) => request === requests[0]), "the same commit bytes every time");
    assert.equal(h.calls.some(c => c.path.endsWith("rollback")), false);
    await tx.closed;
  }
});

test("COMMIT_OUTCOME_UNKNOWN never establishes the rejection of an atomic execute either", async () => {
  const h = setup({}, () => async () => ({ status: 503, body: errorBody("POLICYSQL_COMMIT_OUTCOME_UNKNOWN") }));
  await assert.rejects(h.client.execute("INSERT INTO posts (id) VALUES ('x')"), error => error instanceof PolicySqlOutcomeUnknownError);
});

test("an error for a different operation is not accepted as proof of a commit result", async () => {
  const h = setup({}, send => async request => request.kind === "commit"
    ? { status: 400, body: errorBody("POLICYSQL_INVALID_SQL") }
    : send(request));
  const tx = await h.client.beginTransaction();
  await assert.rejects(tx.commit(), error => error.phase === "commit" && error.cause.response.body.error.code === "POLICYSQL_INVALID_SQL");
  await assert.rejects(tx.rollback(), { phase: "commit" });
  await tx.dispose();
});

test("a frozen unknown error survives failed explicit confirmation", async () => {
  const h = setup({}, send => async request => {
    if (request.kind === "commit") throw new Error("lost");
    return send(request);
  });
  const tx = await h.client.beginTransaction();
  let original;
  await assert.rejects(tx.commit(), error => { original = Object.freeze(error); return true; });
  await assert.rejects(tx.commit(), error => error === original);
  await tx.dispose();
});

test("rejection pairs follow the public status table: 403 PRESET_COLUMN is definite, never-emitted codes are not", async () => {
  const preset = errorBody("POLICYSQL_PRESET_COLUMN");
  const h = setup({}, () => async () => ({ status: 403, body: preset }));
  await assert.rejects(h.client.execute(select), error =>
    !(error instanceof PolicySqlOutcomeUnknownError) && error.code === "POLICYSQL_PRESET_COLUMN" && error.status === 403);
  // The former 400 pairing, and codes no server returns, cannot establish an outcome.
  for (const [status, code] of [[400, "POLICYSQL_PRESET_COLUMN"], [403, "POLICYSQL_ACCESS_DENIED"],
    [403, "POLICYSQL_STATEMENT_REJECTED"], [412, "POLICYSQL_SNAPSHOT_MISMATCH"]]) {
    const body = errorBody(code);
    const u = setup({}, () => async () => ({ status, body }));
    await assert.rejects(u.client.execute(select), error => error instanceof PolicySqlOutcomeUnknownError, code);
  }
});

test("TRANSACTION_LIMIT_EXCEEDED is a permanent 413 rejection of a statement, sent once; the former 429 pairing is unknown (#62)", async () => {
  const body = errorBody("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED");
  for (const [status, definite] of [[413, true], [429, false]]) {
    let statements = 0;
    const h = setup({}, send => async request => {
      if (request.kind !== "statement") return send(request);
      statements++;
      return { status, body };
    });
    const tx = await h.client.beginTransaction();
    await assert.rejects(tx.execute(select), error => definite
      ? !(error instanceof PolicySqlOutcomeUnknownError) && error.code === "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED" && error.status === 413
      : error instanceof PolicySqlOutcomeUnknownError, String(status));
    assert.equal(statements, 1, "never retried");
  }
});

test("TRANSACTION_LIMIT_EXCEEDED establishes a rejection only for an interactive statement (#62)", async () => {
  const body = errorBody("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED");
  const atomic = setup({}, () => async () => ({ status: 413, body }));
  await assert.rejects(atomic.client.execute(select), error => error instanceof PolicySqlOutcomeUnknownError);
  const h = setup({}, send => async request => request.kind === "commit" ? { status: 413, body } : send(request));
  const tx = await h.client.beginTransaction();
  await assert.rejects(tx.commit(), error => error instanceof PolicySqlOutcomeUnknownError && error.phase === "commit");
});
