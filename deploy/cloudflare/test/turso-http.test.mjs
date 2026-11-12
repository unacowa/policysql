import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TursoHttpTransport } from "../src/turso-http.ts";
import { CommitNotSentError } from "../src/errors.ts";
import { MAX_BYTES_PER_VALUE } from "./helpers/routing.mjs";
import { redirectResponses } from "./helpers/redirects.mjs";
import { batchReply, okResults, requestSqls, runBatch } from "./helpers/hrana.mjs";
import { DatabaseStatementError, SqlComplexityError } from "../src/database-complexity.ts";
import { SqlConstraintError } from "../src/database-constraint.ts";

// The read cap core passes with each execute (ADR 0027); these tests choose their own.
const READ_CAP = 2_097_152;

const result = (columns, rows, usage = {}) => ({
  type: "ok",
  response: {
    type: "execute",
    result: {
      cols: columns.map((name) => ({ name, decltype: "TEXT" })),
      rows: rows.map((row) => row.map((value) => ({ type: "text", value }))),
      affected_row_count: 0,
      rows_read: usage.rowsRead ?? rows.length,
      rows_written: usage.rowsWritten ?? 0,
      query_duration_ms: usage.queryDurationMs ?? 1,
    },
  },
});
/** The `database_stream_recovery` records in captured console.log lines. */
const recoveryOutcomes = (lines) => lines.flatMap((line) => {
  try {
    const record = JSON.parse(line);
    return record?.event === "database_stream_recovery" ? [record] : [];
  } catch { return []; }
});
const closeReply = () => ({ type: "ok", response: { type: "close" } });

const blobCases = JSON.parse(readFileSync(new URL("../../../tests/fixtures/hrana-blob-response.json", import.meta.url), "utf8"));
// PolicySQL's transport wrapper always passes the runtime limit as begin options.
const runtimeLimit = { maxBytesPerValue: MAX_BYTES_PER_VALUE };
const readBlob = async (base64, options = runtimeLimit) => {
  const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "blob-response", async (_url, init) => {
    const { requests } = JSON.parse(init.body);
    return Response.json({ baton: "blob-baton", results: requests.map(request => {
      if (request.type === "execute") return result([], []);
      const response = result(["state"], [[null]]);
      response.response.result.cols[0].decltype = "BLOB";
      response.response.result.rows = [[{ type: "blob", base64 }]];
      return batchReply([response]);
    }) });
  });
  const transaction = await transport.begin("read", 1000, undefined, options);
  return (await transaction.execute([{ sql: "SELECT state FROM projects" }], { maxResponseBytes: READ_CAP }))[0].rows[0][0];
};

test("decodes padded and unpadded Hrana BLOB responses without changing their bytes", async () => {
  for (const { base64, bytes } of blobCases.valid) {
    const output = await readBlob(base64);
    assert.ok(output instanceof Uint8Array);
    assert.deepEqual([...output], bytes, JSON.stringify(base64));
  }
});

test("rejects malformed typed Hrana BLOB responses", async () => {
  for (const base64 of [...blobCases.invalid, ...blobCases.wrongTypes]) {
    await assert.rejects(readBlob(base64), { code: "POLICYSQL_DATABASE_UNAVAILABLE" }, JSON.stringify(base64));
  }
});

test("bounds padded and unpadded Hrana BLOB responses before decoding", async t => {
  const decode = t.mock.method(globalThis, "atob");
  for (const length of [MAX_BYTES_PER_VALUE - 2, MAX_BYTES_PER_VALUE - 1, MAX_BYTES_PER_VALUE]) {
    const bytes = Buffer.alloc(length, 255);
    const padded = bytes.toString("base64");
    for (const base64 of new Set([padded, padded.replace(/=+$/, "")])) {
      assert.deepEqual(Buffer.from(await readBlob(base64)), bytes);
    }
  }
  const calls = decode.mock.callCount();
  for (const length of [MAX_BYTES_PER_VALUE + 1, MAX_BYTES_PER_VALUE + 2, MAX_BYTES_PER_VALUE + 3]) {
    const padded = Buffer.alloc(length).toString("base64");
    for (const base64 of new Set([padded, padded.replace(/=+$/, "")])) {
      // Regression (PR #19 review): a stored oversized BLOB is a permanent limit
      // condition, never a retryable 503, and matches the serverless-driver path.
      await assert.rejects(readBlob(base64), { code: "POLICYSQL_LIMIT_EXCEEDED" });
      assert.equal(decode.mock.callCount(), calls, "oversized values are rejected before decode allocation");
    }
  }
  // Long but malformed responses stay transport encoding failures, not limit errors.
  const oversized = Buffer.alloc(MAX_BYTES_PER_VALUE + 3).toString("base64");
  for (const base64 of [`${oversized.slice(0, -1)}!`, `-${oversized.slice(1)}`, `${oversized}A`]) {
    await assert.rejects(readBlob(base64), { code: "POLICYSQL_DATABASE_UNAVAILABLE" });
    assert.equal(decode.mock.callCount(), calls);
  }
});

// Regression (#22): the transport has no copy of the per-value limit. It bounds
// BLOBs with the limit PolicySQL injects from the runtime.
test("bounds Hrana BLOB responses with the injected runtime limit, not a host constant", async () => {
  for (const limit of [3, 16, MAX_BYTES_PER_VALUE * 2]) {
    const fits = Buffer.alloc(limit, 9);
    for (const base64 of new Set([fits.toString("base64"), fits.toString("base64").replace(/=+$/, "")])) {
      assert.deepEqual(Buffer.from(await readBlob(base64, { maxBytesPerValue: limit })), fits, `limit=${limit}`);
    }
    const over = Buffer.alloc(limit + 1).toString("base64");
    await assert.rejects(readBlob(over, { maxBytesPerValue: limit }), { code: "POLICYSQL_LIMIT_EXCEEDED" }, `limit=${limit}`);
    await assert.rejects(readBlob(`${over.slice(0, -1)}!`, { maxBytesPerValue: limit }), { code: "POLICYSQL_DATABASE_UNAVAILABLE" });
  }
});

// Regression (PR #24 review): a direct caller that omits options must not get an
// unbounded transport. An omitted, infinite or malformed limit fails closed with a
// TypeError before BEGIN or any other request is sent.
test("begin without a valid per-value limit is rejected before any request", async t => {
  const fetchImpl = t.mock.fn(async () => assert.fail("a missing or malformed limit must fail before any request"));
  const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "bad-limit", fetchImpl);
  await assert.rejects(transport.begin("read", 1000), TypeError, "options omitted");
  await assert.rejects(transport.begin("write", 1000, Date.now() + 1000), TypeError, "options omitted with deadline");
  for (const options of [undefined, null, {}, { maxBytesPerValue: undefined }, { maxBytesPerValue: 0 },
    { maxBytesPerValue: -1 }, { maxBytesPerValue: 1.5 }, { maxBytesPerValue: NaN }, { maxBytesPerValue: "262144" },
    { maxBytesPerValue: Infinity }, { maxBytesPerValue: 2 ** 53 }]) {
    await assert.rejects(transport.begin("read", 1000, undefined, options), TypeError, String(JSON.stringify(options)));
  }
  assert.equal(fetchImpl.mock.callCount(), 0);
});

// Regression (PR #23 review): a BLOB large enough to push the Hrana response past
// the transport bound is the same permanent limit condition as a per-value overflow
// (413), not a retryable 503. Control responses and HTTP failures stay 503.
test("classifies oversized Hrana statement responses as result limit errors", async () => {
  const huge = Buffer.alloc(2 * 1024 * 1024).toString("base64");
  const run = async ({ declare = false, failBegin = false, status = 200 } = {}) => {
    const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "oversized", async (_url, init) => {
      const { requests } = JSON.parse(init.body);
      const begin = requests[0].type === "execute";
      if (begin && !failBegin) return Response.json({ baton: "b", results: [result([], [])] });
      const response = result(["state"], [[null]]);
      response.response.result.rows = [[{ type: "blob", base64: huge }]];
      const text = JSON.stringify({ baton: "b", results: [batchReply([response])] });
      return new Response(declare ? "{}" : text, {
        status,
        headers: declare ? { "content-length": String(text.length) } : {},
      });
    });
    const transaction = await transport.begin("read", 1000, undefined, runtimeLimit);
    return transaction.execute([{ sql: "SELECT state FROM projects" }], { maxResponseBytes: READ_CAP });
  };
  for (const declare of [false, true]) {
    await assert.rejects(run({ declare }), { code: "POLICYSQL_LIMIT_EXCEEDED" }, `declare=${declare}`);
    await assert.rejects(run({ declare, failBegin: true }), { code: "POLICYSQL_DATABASE_UNAVAILABLE" });
  }
  await assert.rejects(run({ status: 500 }), { code: "POLICYSQL_DATABASE_UNAVAILABLE" });
});

test("decodes exact usage metrics while preserving transaction ownership", async () => {
  const requests = [];
  const fetchImpl = async function (_url, init) {
    assert.equal(this, undefined, "host fetch must not be invoked as a transport method");
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requestSqls(body.requests)[0].startsWith("BEGIN")) {
      return new Response(JSON.stringify({ baton: "baton_1", results: [result([], [])] }));
    }
    if (requestSqls(body.requests)[0] === "COMMIT") {
      return new Response(JSON.stringify({
        baton: null,
        results: [result([], []), { type: "ok", response: { type: "close" } }],
      }));
    }
    return new Response(JSON.stringify({
      baton: "baton_2",
      results: [batchReply([result(["id"], [["p1"]], { rowsRead: 12, queryDurationMs: 2.5 })])],
    }));
  };
  const transport = new TursoHttpTransport(
    { url: "https://db.test", authToken: "secret" },
    "req_1",
    fetchImpl,
  );
  const transaction = await transport.begin("read", 1000, undefined, runtimeLimit);
  const output = await transaction.execute([{ sql: "SELECT id FROM projects", args: {} }], { maxResponseBytes: READ_CAP });
  await transaction.commit();
  assert.equal(output[0].usage.rowsRead, 12);
  assert.equal(requests[1].baton, "baton_1");
  assert.equal(requests[2].baton, "baton_2");
});

// A BEGIN reply can name the stream's next baton even when its result is unusable. BEGIN has no
// transaction object yet, so without the rollback the server transaction (and its write lock)
// would wait for stream expiry (#97 review).
test("rejects missing per-query billing metrics and rolls back the BEGIN through its baton", async (t) => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.map(String).join(" ")));
  const requests = [];
  const transport = new TursoHttpTransport(
    { url: "https://db.test", authToken: "secret" },
    "req_1",
    async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ baton: body.baton, sql: requestSqls(body.requests)[0] });
      if (requestSqls(body.requests)[0].startsWith("BEGIN")) {
        return Response.json({
          baton: "begin_baton",
          results: [{
            type: "ok",
            response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0 } },
          }],
        });
      }
      return Response.json({ baton: null, results: [result([], []), closeReply()] });
    },
  );
  await assert.rejects(transport.begin("read", 1000, undefined, runtimeLimit), (error) => error.code === "POLICYSQL_DATABASE_UNAVAILABLE");
  assert.deepEqual(requests, [
    { baton: undefined, sql: "BEGIN DEFERRED" },
    { baton: "begin_baton", sql: "ROLLBACK" },
  ]);
  assert.deepEqual(recoveryOutcomes(lines).map(({ outcome }) => outcome), ["rolled_back"]);
});

// The control bound rejects a declared-over-bound BEGIN, but the transport asks for its leading
// bytes first: the baton they name is the only way to roll back a BEGIN the server may already
// have run (#97 review).
test("rolls back a BEGIN reply over the declared control bound through the baton in its prefix", async (t) => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.map(String).join(" ")));
  const requests = [];
  const huge = JSON.stringify({ baton: "prefix_baton", padding: " ".repeat(70_000) });
  const transport = new TursoHttpTransport(
    { url: "https://db.test", authToken: "secret" },
    "req_1",
    async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ baton: body.baton, sql: requestSqls(body.requests)[0] });
      if (requestSqls(body.requests)[0].startsWith("BEGIN")) {
        return new Response(huge, { headers: { "content-length": String(new TextEncoder().encode(huge).byteLength) } });
      }
      return Response.json({ baton: null, results: [result([], []), closeReply()] });
    },
  );
  await assert.rejects(transport.begin("read", 1000, undefined, runtimeLimit), (error) => error.code === "POLICYSQL_DATABASE_UNAVAILABLE");
  assert.deepEqual(requests, [
    { baton: undefined, sql: "BEGIN DEFERRED" },
    { baton: "prefix_baton", sql: "ROLLBACK" },
  ]);
  assert.deepEqual(recoveryOutcomes(lines).map(({ outcome }) => outcome), ["rolled_back"]);
});

// A reply that stalls after its first bytes carries the baton too; begin must recover it from
// the timeout's leading bytes, not only from a parsed body (#97 review).
test("rolls back a BEGIN reply that stalls after its baton", async (t) => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.map(String).join(" ")));
  const requests = [];
  const transport = new TursoHttpTransport(
    { url: "https://db.test", authToken: "secret" },
    "req_1",
    async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ baton: body.baton, sql: requestSqls(body.requests)[0] });
      if (requestSqls(body.requests)[0].startsWith("BEGIN")) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"baton":"lead_baton","base_url":null,"results":['));
          },
          pull() { return new Promise(() => {}); },
        }));
      }
      return Response.json({ baton: null, results: [result([], []), closeReply()] });
    },
  );
  await assert.rejects(transport.begin("read", 20, undefined, runtimeLimit), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
  assert.deepEqual(requests, [
    { baton: undefined, sql: "BEGIN DEFERRED" },
    { baton: "lead_baton", sql: "ROLLBACK" },
  ]);
  assert.deepEqual(recoveryOutcomes(lines).map(({ outcome }) => outcome), ["rolled_back"]);
});

// The residual no code can recover: no headers, no baton, nothing to continue. BEGIN must not
// invent a recovery request (there is no stream to name), and the failure is unchanged (#97).
test("a BEGIN whose headers never arrive has no baton and makes no recovery attempt", async () => {
  const requests = [];
  const transport = new TursoHttpTransport(
    { url: "https://db.test", authToken: "secret" },
    "req_1",
    async (_url, init) => {
      requests.push(JSON.parse(init.body));
      throw new DOMException("The operation was aborted.", "TimeoutError");
    },
  );
  await assert.rejects(transport.begin("write", 50, undefined, runtimeLimit), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
  assert.equal(requests.length, 1, "no ROLLBACK is sent without a baton");
});

test("HTTP operations share an absolute deadline while rollback retains its cleanup budget", async (t) => {
  let now = 10_000;
  const budgets = [];
  const requests = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(AbortSignal, "timeout", (timeout) => {
    budgets.push(timeout);
    return new AbortController().signal;
  });
  const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "secret" }, "deadline", async (_url, init) => {
    const { requests: commands } = JSON.parse(init.body);
    requests.push(requestSqls(commands)[0]);
    return Response.json({
      baton: commands.length === 1 ? "baton" : null,
      results: okResults(commands, result([], [])),
    });
  });
  const first = await transport.begin("read", 1000, 10_200, runtimeLimit);
  now += 120;
  await first.execute([{ sql: "SELECT id FROM projects" }], { maxResponseBytes: READ_CAP });
  now += 50;
  await first.commit();
  assert.deepEqual(budgets, [200, 80, 30]);

  const second = await transport.begin("read", 1000, 10_200, runtimeLimit);
  now = 10_200;
  const count = requests.length;
  await assert.rejects(second.execute([{ sql: "SELECT id FROM projects" }], { maxResponseBytes: READ_CAP }), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
  // A COMMIT whose deadline passed is refused before any byte is sent: a typed pre-send failure (#54).
  await assert.rejects(second.commit(), (error) => error instanceof CommitNotSentError && error.cause.code === "POLICYSQL_DATABASE_TIMEOUT");
  assert.equal(requests.length, count, "no SQL or COMMIT after expiry");
  await second.rollback();
  assert.equal(requests.at(-1), "ROLLBACK");
  assert.equal(budgets.at(-1), 1000);
  assert.equal(second.open, false);
});

// Regression (#36): workerd throws on `redirect: "error"`, which turned every Turso
// request on the real Worker into a 503. The transport now asks for "manual" and
// rejects the redirect itself, without following it or reading its body.
test("requests manual redirects and rejects 3xx and opaqueredirect responses unread", async () => {
  const success = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "redirect", async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return Response.json({ baton: "b", results: [result([], [])] });
  });
  await success.begin("read", 1000, undefined, runtimeLimit);

  for (const { label, response, state } of redirectResponses()) {
    const urls = [];
    const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "redirect", async (url, init) => {
      urls.push(String(url));
      assert.equal(init.redirect, "manual");
      return response;
    });
    await assert.rejects(
      transport.begin("read", 1000, undefined, runtimeLimit),
      { code: "POLICYSQL_DATABASE_UNAVAILABLE" },
      label,
    );
    assert.deepEqual(urls, ["https://db.test/v2/pipeline"], `${label}: the redirect is not followed`);
    assert.equal(state.read, false, `${label}: the redirect body is not read`);
    assert.equal(state.cancelled, true, `${label}: the redirect body is released`);
  }
});

// ADR 0024 pull request 7 (#70): an integer beyond 2^53 - 1 that the step machine bound
// reaches the transport as a BigInt and keeps its digits on the wire; anything outside the
// signed 64-bit range fails closed before any request.
test("encodes BigInt arguments as exact Hrana integers within the signed 64-bit range", async () => {
  const sent = [];
  const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "bigint", async (_url, init) => {
    const { requests } = JSON.parse(init.body);
    sent.push(...requests);
    return Response.json({ baton: "baton", results: okResults(requests, result([], [])) });
  });
  const transaction = await transport.begin("write", 1000, undefined, runtimeLimit);
  const args = { big: 9007199254740993n, min: -(2n ** 63n), max: 2n ** 63n - 1n, small: 7 };
  await transaction.execute([{ sql: "INSERT INTO counters (big) VALUES (:big)", args }], { maxResponseBytes: READ_CAP });
  assert.deepEqual(sent.at(-1).batch.steps[0].stmt.named_args, [
    { name: "big", value: { type: "integer", value: "9007199254740993" } },
    { name: "min", value: { type: "integer", value: "-9223372036854775808" } },
    { name: "max", value: { type: "integer", value: "9223372036854775807" } },
    { name: "small", value: { type: "integer", value: "7" } },
  ]);
  const before = sent.length;
  for (const value of [2n ** 63n, -(2n ** 63n) - 1n]) {
    await assert.rejects(transaction.execute([{ sql: "SELECT :v", args: { v: value } }], { maxResponseBytes: READ_CAP }), { code: "POLICYSQL_INTERNAL" });
  }
  assert.equal(sent.length, before, "nothing is sent for an out-of-range integer");
});

// A COMMIT that was handed to the pipeline is never "not sent" later: a second attempt after a
// failed first one, even past the deadline, is an ordinary failure (unknown), not the pre-send error.
test("a second COMMIT after a sent one failed is never CommitNotSentError", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  let commits = 0;
  const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "secret" }, "twice", async (_url, init) => {
    const { requests: commands } = JSON.parse(init.body);
    if (requestSqls(commands)[0] === "COMMIT") { commits++; return new Response("down", { status: 503 }); }
    return Response.json({ baton: "baton", results: okResults(commands, result([], [])) });
  });
  const transaction = await transport.begin("write", 1000, 10_200, runtimeLimit);
  await assert.rejects(transaction.commit(), (error) => !(error instanceof CommitNotSentError));
  now = 10_300;
  await assert.rejects(transaction.commit(), (error) => !(error instanceof CommitNotSentError));
  assert.equal(commits, 1, "no second COMMIT request");
});

// ---------------------------------------------------------------------------------------------
// #144: an envelope's statements go out as one conditional Hrana batch, and a reply is read as
// "the statements before the first error ran, that one failed, nothing after it ran".

const COMPLEXITY = { code: "SQLITE_UNKNOWN", message: "SQLite error: too many columns in result set" };
const CONSTRAINT = { code: "SQLITE_CONSTRAINT", message: "SQLite error: UNIQUE constraint failed: projects.id" };
const okStep = (name = "n") => result([name], [["1"]]).response.result;
const stepsReply = (stepResults, stepErrors) => ({
  type: "ok", response: { type: "batch", result: { step_results: stepResults, step_errors: stepErrors, replication_index: null } },
});

/** A transport whose statement requests are all answered by `answer(request)`; it records every body. */
const batchTransport = (answer, sent = []) => {
  let serial = 0;
  return new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "batch", async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const sql = requestSqls(body.requests)[0] ?? "";
    if (sql.startsWith("BEGIN")) return Response.json({ baton: "b0", results: [result([], [])] });
    if (sql === "ROLLBACK" || sql === "COMMIT") return Response.json({ baton: null, results: [result([], []), closeReply()] });
    serial += 1;
    return Response.json({ baton: `b${serial}`, results: [answer(body.requests[0])] });
  });
};
const threeStatements = [{ sql: "INSERT a" }, { sql: "INSERT b" }, { sql: "INSERT c" }];

test("P1: three statements are one batch whose steps each depend on the step before", async () => {
  const sent = [];
  const transport = batchTransport((request) => batchReply(request.batch.steps.map(() => result(["n"], [["1"]]))), sent);
  const transaction = await transport.begin("write", 1000, undefined, runtimeLimit);
  const statements = [
    { sql: "INSERT a", args: { x: "t", n: 1 } },
    { sql: "INSERT b", args: {} },
    { sql: "INSERT c" },
  ];
  const results = await transaction.execute(statements, { maxResponseBytes: READ_CAP });
  assert.equal(results.length, 3);
  const [request, ...extra] = sent[1].requests;
  assert.equal(extra.length, 0, "exactly one request");
  assert.equal(request.type, "batch");
  const { steps } = request.batch;
  assert.equal(steps.length, 3);
  assert.equal(Object.hasOwn(steps[0], "condition"), false);
  assert.deepEqual(steps[1].condition, { type: "ok", step: 0 });
  assert.deepEqual(steps[2].condition, { type: "ok", step: 1 });
  assert.deepEqual(steps.map((step) => step.stmt.sql), ["INSERT a", "INSERT b", "INSERT c"]);
  assert.deepEqual(steps[0].stmt.named_args, [
    { name: "x", value: { type: "text", value: "t" } },
    { name: "n", value: { type: "integer", value: "1" } },
  ]);
  assert.deepEqual(steps[1].stmt.named_args, []);
  assert.equal(sent[0].requests[0].type, "execute", "BEGIN stays a plain execute request");
});

test("P2: a single statement is a one-step batch without a condition", async () => {
  const sent = [];
  const transport = batchTransport((request) => batchReply(request.batch.steps.map(() => result(["n"], [["1"]]))), sent);
  const transaction = await transport.begin("read", 1000, undefined, runtimeLimit);
  await transaction.execute([{ sql: "SELECT 1" }], { maxResponseBytes: READ_CAP });
  assert.equal(sent[1].requests.length, 1);
  assert.equal(sent[1].requests[0].type, "batch");
  assert.equal(sent[1].requests[0].batch.steps.length, 1);
  assert.equal(Object.hasOwn(sent[1].requests[0].batch.steps[0], "condition"), false);
});

test("P3: results come back in statement order and each statement's usage is recorded in order", async () => {
  const transport = batchTransport((request) => batchReply(request.batch.steps.map((_step, index) =>
    result(["n"], [[String(index)]], { rowsRead: 10 + index, rowsWritten: index, queryDurationMs: 2 + index }))));
  const transaction = await transport.begin("write", 1000, undefined, runtimeLimit);
  const results = await transaction.execute([{ sql: "INSERT a" }, { sql: "INSERT b" }], { maxResponseBytes: READ_CAP });
  assert.deepEqual(results.map((item) => item.rows), [[["0"]], [["1"]]]);
  assert.deepEqual(transaction.usage.map((usage) => usage.rowsRead), [0, 10, 11]);
  assert.deepEqual(transaction.usage.map((usage) => usage.rowsWritten), [0, 0, 1]);
});

test("P4: no statements is a zero-step batch and an empty result", async () => {
  const sent = [];
  const transport = batchTransport((request) => batchReply(request.batch.steps.map(() => result([], []))), sent);
  const transaction = await transport.begin("read", 1000, undefined, runtimeLimit);
  assert.deepEqual(await transaction.execute([], { maxResponseBytes: READ_CAP }), []);
  assert.deepEqual(sent[1].requests, [{ type: "batch", batch: { steps: [] } }]);
});

test("runBatch evaluates conditions as Hrana does: only the steps whose predecessor succeeded run", async () => {
  const request = { type: "batch", batch: { steps: [
    { stmt: { sql: "a", named_args: [] } },
    { stmt: { sql: "b", named_args: [] }, condition: { type: "ok", step: 0 } },
    { stmt: { sql: "c", named_args: [] }, condition: { type: "ok", step: 1 } },
  ] } };
  const ran = [];
  const reply = await runBatch(request, ({ sql }) => {
    ran.push(sql);
    return sql === "b" ? { type: "error", error: CONSTRAINT } : result(["n"], [["1"]]);
  });
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(reply.response.result.step_results[2], null);
  assert.deepEqual(reply.response.result.step_errors.map((error) => error === null), [true, false, true]);
});

test("C1-C3: the first error of a batch is classified by its own step", async () => {
  const run = async (stepErrors) => {
    const refused = stepErrors.findIndex((error) => error !== null);
    const transport = batchTransport(() => stepsReply(stepErrors.map((_error, index) => (index < refused ? okStep() : null)), stepErrors));
    const transaction = await transport.begin("write", 1000, undefined, runtimeLimit);
    return transaction.execute(threeStatements.slice(0, stepErrors.length), { maxResponseBytes: READ_CAP }).then(() => null, (error) => error);
  };
  const middle = await run([null, COMPLEXITY, null]);
  assert.ok(middle instanceof SqlComplexityError && middle.statement === 1 && middle.complexityCause === "columns");
  const first = await run([COMPLEXITY, null, null]);
  assert.ok(first instanceof SqlComplexityError && first.statement === 0);
  // A constraint violation of a reply that kept its baton: the transaction is open and nothing after it ran (ADR 0030).
  const constraint = await run([null, CONSTRAINT, null]);
  assert.ok(constraint instanceof SqlConstraintError && constraint.statement === 1 && constraint.constraint === "unique");
  assert.equal(constraint.databaseCode, "SQLITE_CONSTRAINT");
  assert.equal(constraint instanceof DatabaseStatementError, false);
  assert.equal(JSON.stringify(constraint).includes("projects"), false);
  assert.equal(constraint.message.includes("projects") || constraint.message.includes("UNIQUE"), false);
  const odd = await run([null, { code: "sqlite_x", message: "x" }, null]);
  assert.ok(odd instanceof DatabaseStatementError && odd.databaseCode === "UNKNOWN");
});

// Every shape below is something a conforming server never sends. The transport trusts none of
// them: each is a plain 503, never a classified refusal, and a write may have run after the refusal.
const protocolViolations = {
  "a top-level error that is not an object": () => ({ type: "error", error: "too many columns in result set" }),
  "an execute reply to a batch request": () => ({ type: "ok", response: { type: "execute", result: okStep() } }),
  "no response object": () => ({ type: "ok" }),
  "no step_results": () => ({ type: "ok", response: { type: "batch", result: { step_errors: [null, null, null] } } }),
  "no step_errors": () => ({ type: "ok", response: { type: "batch", result: { step_results: [okStep(), okStep(), okStep()] } } }),
  "a result that is not an object": () => ({ type: "ok", response: { type: "batch", result: null } }),
  "step arrays that are too short": () => stepsReply([okStep(), okStep()], [null, null]),
  "step arrays that are too long": () => stepsReply([okStep(), okStep(), okStep(), okStep()], [null, null, null, null]),
  "step_errors shorter than step_results": () => stepsReply([okStep(), okStep(), okStep()], [null, null]),
  "no error and a step that did not run": () => stepsReply([okStep(), null, okStep()], [null, null, null]),
  "a step before the error that did not run": () => stepsReply([null, null, null], [null, COMPLEXITY, null]),
  "a result on the step that errored": () => stepsReply([okStep(), okStep(), null], [null, COMPLEXITY, null]),
  "a step that ran after the error": () => stepsReply([okStep(), null, okStep()], [null, COMPLEXITY, null]),
  "a second error after the first": () => stepsReply([okStep(), null, null], [null, COMPLEXITY, COMPLEXITY]),
  "an error that is a string": () => stepsReply([okStep(), null, null], [null, "too many columns in result set", null]),
  "an error that is a number": () => stepsReply([okStep(), null, null], [null, 7, null]),
  "an error that is an array": () => stepsReply([okStep(), null, null], [null, [COMPLEXITY], null]),
  "a step result that is a string": () => stepsReply([okStep(), "ok", okStep()], [null, null, null]),
  "a step result without rows_read": () => {
    const { rows_read: _omitted, ...incomplete } = okStep();
    return stepsReply([okStep(), incomplete, okStep()], [null, null, null]);
  },
};
// The shapes where a statement after the refusal ran or errored: a write may have committed.
const ranAfterRefusal = ["a step that ran after the error", "a second error after the first"];
// The reply shapes that break the conditional-batch contract once the first error is known: each is
// logged once with its fixed reason (#144).
const loggedViolations = {
  "a step before the error that did not run": "step_before_error_not_run",
  "a result on the step that errored": "error_step_has_result",
  "a step that ran after the error": "step_after_error_ran",
  "a second error after the first": "step_after_error_ran",
  "an error that is a string": "error_not_object",
  "an error that is a number": "error_not_object",
  "an error that is an array": "error_not_object",
};

for (const [name, reply] of Object.entries(protocolViolations)) {
  test(`N1: ${name} is an unclassified 503 and the rollback continues from the reply's baton`, async (t) => {
    const lines = [];
    t.mock.method(console, "log", (...args) => lines.push(args.map(String).join(" ")));
    const batons = [];
    let serial = 0;
    const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "violation", async (_url, init) => {
      const body = JSON.parse(init.body);
      batons.push(body.baton ?? null);
      const [sql] = requestSqls(body.requests);
      if (sql.startsWith("BEGIN")) return Response.json({ baton: "b0", results: [result([], [])] });
      if (sql === "ROLLBACK") return Response.json({ baton: null, results: [result([], []), closeReply()] });
      serial += 1;
      return Response.json({ baton: `next-${serial}`, results: [reply()] });
    });
    const transaction = await transport.begin("write", 1000, undefined, runtimeLimit);
    const failure = await transaction.execute(threeStatements, { maxResponseBytes: READ_CAP }).then(() => null, (error) => error);
    assert.ok(failure, "the call fails");
    assert.equal(failure.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    assert.ok(!(failure instanceof SqlComplexityError), "never a classified refusal");
    assert.ok(!(failure instanceof DatabaseStatementError), "never a classified database error");
    // R1: the stream continues with the baton of the reply that was a violation (#97).
    await transaction.rollback();
    assert.deepEqual(batons, [null, "b0", "next-1"]);
    // S3: a broken contract is logged with a fixed reason and nothing of the reply.
    const violations = lines.flatMap((line) => { try { const record = JSON.parse(line); return record.event === "database_protocol_violation" ? [record] : []; } catch { return []; } });
    if (Object.hasOwn(loggedViolations, name)) {
      assert.deepEqual(violations, [{ event: "database_protocol_violation", requestId: "violation", reason: loggedViolations[name] }]);
    } else {
      assert.deepEqual(violations, [], "no violation event for a shape that is not a broken contract after an error");
    }
    const everything = lines.join("\n");
    for (const text of ["b0", "next-1", "too many columns", "SQLite", "INSERT", "UNIQUE"]) assert.equal(everything.includes(text), false, text);
  });
}

test("B1: a refusal followed by a step that ran is never a definite rejection", async () => {
  for (const name of ranAfterRefusal) {
    const transport = batchTransport(() => protocolViolations[name]());
    const transaction = await transport.begin("write", 1000, undefined, runtimeLimit);
    await assert.rejects(
      transaction.execute(threeStatements, { maxResponseBytes: READ_CAP }),
      (error) => error.code === "POLICYSQL_DATABASE_UNAVAILABLE" && !(error instanceof SqlComplexityError),
      name,
    );
  }
});

test("S2: a batch that fails as a whole keeps its code, is never a complexity refusal, and its message is not read", async () => {
  const run = async (error) => {
    const transport = batchTransport(() => ({ type: "error", error }));
    const transaction = await transport.begin("write", 1000, undefined, runtimeLimit);
    return transaction.execute(threeStatements, { maxResponseBytes: READ_CAP }).then(() => null, (failure) => failure);
  };
  const complexity = await run(COMPLEXITY);
  assert.ok(complexity instanceof DatabaseStatementError && !(complexity instanceof SqlComplexityError));
  assert.equal(complexity.databaseCode, "SQLITE_UNKNOWN");
  assert.equal(complexity.code, "POLICYSQL_DATABASE_UNAVAILABLE");
  const busy = await run({ code: "SQLITE_BUSY", message: "database is locked" });
  assert.equal(busy.databaseCode, "SQLITE_BUSY");
  const unsafe = await run({ code: "sqlite busy: secret", message: "x" });
  assert.ok(unsafe instanceof DatabaseStatementError);
  assert.equal(unsafe.databaseCode, "UNKNOWN");
  const none = await run({ message: "no code" });
  assert.equal(none.databaseCode, "UNKNOWN");
});

// Real Turso ends the stream (`baton: null`) when SQLite closed the transaction itself on the
// error; the reply is still the batch reply (observed by the release smoke, #144). Its refusal keeps
// its code but is never a definite (complexity) refusal, and no request is sent on the ended stream.
test("E1: a batch reply that ends the stream keeps its code, is never classified as complexity, and sends nothing more", async (t) => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.map(String).join(" ")));
  const sent = [];
  const run = async (entry) => {
    sent.length = 0;
    lines.length = 0;
    const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "ended", async (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      const sql = requestSqls(body.requests)[0] ?? "";
      if (sql.startsWith("BEGIN")) return Response.json({ baton: "b0", results: [result([], [])] });
      return Response.json({ baton: null, results: [entry] });
    });
    const transaction = await transport.begin("write", 1000, undefined, runtimeLimit);
    const failure = await transaction.execute(threeStatements, { maxResponseBytes: READ_CAP }).then(() => null, (error) => error);
    return { transaction, failure };
  };
  const events = (name) => lines.flatMap((line) => { try { const record = JSON.parse(line); return record.event === name ? [record] : []; } catch { return []; } });

  const refused = await run(stepsReply([okStep(), null, null], [null, CONSTRAINT, null]));
  assert.ok(refused.failure instanceof DatabaseStatementError && refused.failure.databaseCode === "SQLITE_CONSTRAINT");
  // The stream ended: COMMIT is refused before it is sent, ROLLBACK sends nothing and logs no recovery.
  await assert.rejects(refused.transaction.commit(), CommitNotSentError);
  await refused.transaction.rollback();
  assert.equal(refused.transaction.open, false);
  assert.deepEqual(requestSqls(sent.flatMap((body) => body.requests)).filter((sql) => /^(COMMIT|ROLLBACK|close)$/u.test(sql)), []);
  assert.equal(sent.length, 2, "only BEGIN and the batch were sent");
  assert.deepEqual(events("database_stream_recovery"), []);

  // A complexity message is not a definite refusal here: only its code is kept (a 503).
  const complex = await run(stepsReply([okStep(), null, null], [null, COMPLEXITY, null]));
  assert.ok(complex.failure instanceof DatabaseStatementError && !(complex.failure instanceof SqlComplexityError));
  assert.equal(complex.failure.databaseCode, "SQLITE_UNKNOWN");
  assert.equal(complex.failure.code, "POLICYSQL_DATABASE_UNAVAILABLE");

  // Success without a baton, or a reply that breaks the contract: a plain 503; a success is logged.
  const success = await run(batchReply([result(["n"], [["1"]]), result(["n"], [["1"]]), result(["n"], [["1"]])]));
  assert.equal(success.failure.code, "POLICYSQL_DATABASE_UNAVAILABLE");
  assert.ok(!(success.failure instanceof DatabaseStatementError) && !(success.failure instanceof SqlComplexityError));
  assert.deepEqual(events("database_protocol_violation"), [{ event: "database_protocol_violation", requestId: "ended", reason: "stream_ended_without_error" }]);
  assert.equal(lines.join("\n").includes("too many columns"), false);
  const broken = await run(stepsReply([okStep(), okStep(), null], [null, COMPLEXITY, null]));
  assert.ok(!(broken.failure instanceof DatabaseStatementError) && !(broken.failure instanceof SqlComplexityError));
  assert.deepEqual(events("database_protocol_violation").map((record) => record.reason), ["error_step_has_result"]);
});
