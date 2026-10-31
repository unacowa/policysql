// Streamed, byte-counted Turso response bound (#53, ADR 0027 "Streamed enforcement"). The
// Turso reply is read as a byte stream with a running byte count and cancelled at the first
// chunk over its bound; UTF-8 is decoded strictly. A statement reply is bounded by the read cap the
// caller passes (core's compiled raw bound, ADR 0027 pull request 6; 2 MiB in these tests), a control reply (BEGIN, COMMIT,
// ROLLBACK, close) at the fixed 65,536 bytes (ADR 0027 pull request 3). A statement reply over
// its bound is 413 POLICYSQL_LIMIT_EXCEEDED, a control reply over its bound 503
// POLICYSQL_DATABASE_UNAVAILABLE (never a limit, and never a rejection of a COMMIT: ADR 0016,
// ADR 0007).
import test from "node:test";
import assert from "node:assert/strict";
import { TursoHttpTransport } from "../src/turso-http.ts";
import { CommitNotSentError } from "../src/errors.ts";
import { BodyReadError, BodyTooLargeError, readBoundedText } from "../src/bounded-body.ts";
import { MAX_BYTES_PER_VALUE } from "./helpers/routing.mjs";

const MAX_RESPONSE_BYTES = 2_097_152;
const CONTROL_BYTES = 65_536;
// The bound of each kind of reply.
const BOUND = { statement: MAX_RESPONSE_BYTES, begin: CONTROL_BYTES, commit: CONTROL_BYTES };
const runtimeLimit = { maxBytesPerValue: MAX_BYTES_PER_VALUE };
const encoder = new TextEncoder();
const VALUE = "日本語テキスト🙂";

const result = (columns, rows) => ({
  type: "ok",
  response: {
    type: "execute",
    result: {
      cols: columns.map((name) => ({ name, decltype: "TEXT" })),
      rows: rows.map((row) => row.map((value) => ({ type: "text", value }))),
      affected_row_count: 0, rows_read: rows.length, rows_written: 0, query_duration_ms: 1,
    },
  },
});
const CLOSE = { type: "ok", response: { type: "close" } };

/**
 * A pull stream over `chunk(i)` (a Uint8Array, or null for the end) that records what the
 * reader pulled and whether it cancelled. `highWaterMark: 0` pulls only on demand, so
 * `state.bytes` is what the reader actually took off the wire.
 */
const tracked = (chunk, { delayMs = 0 } = {}) => {
  const state = { pulls: 0, bytes: 0, cancelled: false };
  let index = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const next = chunk(index++);
      if (next === null) { controller.close(); return; }
      state.pulls++;
      state.bytes += next.byteLength;
      controller.enqueue(next);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, stream };
};
/** `bytes` in chunks of `size` (the last may be shorter). */
const chunked = (bytes, size) => (index) => (index * size < bytes.byteLength ? bytes.subarray(index * size, (index + 1) * size) : null);
/** A body of `size`-byte chunks of ASCII spaces, `total` bytes long (the #53 reproduction). */
const spaces = (size, total = Infinity) => (index) => (index * size < total ? new Uint8Array(size).fill(32) : null);
/** `json` as UTF-8, padded with spaces (valid trailing JSON whitespace) to exactly `bytes`. */
const padded = (json, bytes) => {
  const encoded = encoder.encode(JSON.stringify(json));
  assert.ok(encoded.byteLength <= bytes);
  const out = new Uint8Array(bytes).fill(32);
  out.set(encoded);
  return out;
};
const statementReply = (bytes) => padded({ baton: "b", results: [result(["name"], [[VALUE]])] }, bytes);
const beginReply = (bytes) => padded({ baton: "b", results: [result([], [])] }, bytes);
const closeReply = (bytes) => padded({ baton: null, results: [result([], []), CLOSE] }, bytes);
const replyFor = { statement: statementReply, begin: beginReply, commit: closeReply };

/**
 * A transport whose reply to the request kind `target` ("begin", "statement", "commit") is
 * `respond()`; the other requests get small valid replies.
 */
const transportFor = (target, respond) => new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "bounded", async (_url, init) => {
  const { requests } = JSON.parse(init.body);
  const sql = requests[0].stmt?.sql ?? "";
  const kind = sql.startsWith("BEGIN") ? "begin" : sql === "COMMIT" || sql === "ROLLBACK" ? "commit" : "statement";
  if (kind === target) return respond(init);
  if (kind === "begin") return Response.json({ baton: "b", results: [result([], [])] });
  if (kind === "statement") return Response.json({ baton: "b", results: [result(["name"], [["ok"]])] });
  return Response.json({ baton: null, results: [result([], []), CLOSE] });
});
const runBegin = (transport, timeoutMs = 1000) => transport.begin("read", timeoutMs, undefined, runtimeLimit);
const runStatement = async (transport, timeoutMs = 1000) => {
  const transaction = await transport.begin("read", timeoutMs, undefined, runtimeLimit);
  return (await transaction.execute([{ sql: "SELECT name FROM projects" }], { maxResponseBytes: MAX_RESPONSE_BYTES }))[0];
};
const runCommit = async (transport, timeoutMs = 1000) => {
  const transaction = await transport.begin("write", timeoutMs, undefined, runtimeLimit);
  await transaction.commit();
  return transaction;
};
const runners = { statement: runStatement, begin: runBegin, commit: runCommit };
// Today's classification of a reply over the bound (unchanged by #53).
const OVERSIZED = {
  statement: "POLICYSQL_LIMIT_EXCEEDED",
  begin: "POLICYSQL_DATABASE_UNAVAILABLE",
  commit: "POLICYSQL_DATABASE_UNAVAILABLE",
};
const MESSAGES = {
  POLICYSQL_DATABASE_UNAVAILABLE: "The database is temporarily unavailable.",
  POLICYSQL_LIMIT_EXCEEDED: "The request or result exceeded a configured limit.",
  POLICYSQL_DATABASE_TIMEOUT: "The database operation timed out.",
};
/** The error has `code` and its fixed public message: no response content, no detail. */
const safe = (code) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.message, MESSAGES[code]);
  return true;
};

test("#53: a reply of exactly its bound of UTF-8 is accepted, whatever the chunking", async () => {
  for (const target of ["statement", "begin", "commit"]) {
    for (const size of [1 << 20, 65_536, 4_099]) {
      const { state, stream } = tracked(chunked(replyFor[target](BOUND[target]), size));
      const output = await runners[target](transportFor(target, () => new Response(stream)));
      if (target === "statement") assert.deepEqual(output.rows, [[VALUE]], `size=${size}`);
      if (target === "commit") assert.equal(output.open, false);
      assert.equal(state.bytes, BOUND[target], `${target} size=${size}`);
      assert.equal(state.cancelled, false);
    }
  }
});

test("#53: multi-byte UTF-8 split across chunks at every byte is decoded exactly", async () => {
  const bytes = statementReply(MAX_RESPONSE_BYTES);
  // One-byte chunks over the head of the reply (every split point inside the 3- and 4-byte
  // characters), then the rest in one chunk.
  const head = 512;
  const pieces = [...bytes.subarray(0, head)].map((byte) => Uint8Array.of(byte)).concat([bytes.subarray(head)]);
  const { state, stream } = tracked((index) => pieces[index] ?? null);
  const output = await runStatement(transportFor("statement", () => new Response(stream)));
  assert.deepEqual(output.rows, [[VALUE]]);
  assert.equal(state.bytes, MAX_RESPONSE_BYTES);
});

test("#53: one byte over the bound is rejected with its code and the stream is cancelled", async () => {
  for (const target of ["statement", "begin", "commit"]) {
    for (const size of [65_536, 4_099, BOUND[target] + 1]) {
      const over = tracked(chunked(replyFor[target](BOUND[target] + 1), size));
      await assert.rejects(runners[target](transportFor(target, () => new Response(over.stream))), (error) => {
        // A COMMIT whose reply is over its bound is never a rejection: it may have committed.
        assert.equal(error instanceof CommitNotSentError, false);
        return safe(OVERSIZED[target])(error);
      }, `${target} size=${size}`);
      assert.equal(over.state.cancelled, true, `${target} size=${size}: the stream is cancelled`);
    }
  }
});

// Regression (#53): with no Content-Length or an understated one, the whole 3 MiB body was
// read before the check, and the stream was never cancelled.
test("#53: a large body with a missing or lying Content-Length is cut at the bound, not read to the end", async () => {
  const step = 65_536;
  const total = 3 * 1_048_576;
  for (const target of ["statement", "begin", "commit"]) {
    for (const headers of [{}, { "content-length": "1" }, { "content-length": "0" }, { "content-length": "nonsense" }]) {
      const body = tracked(spaces(step, total));
      await assert.rejects(runners[target](transportFor(target, () => new Response(body.stream, { headers }))), safe(OVERSIZED[target]), `${target} ${JSON.stringify(headers)}`);
      assert.equal(body.state.cancelled, true, `${target}: cancelled`);
      assert.ok(body.state.bytes > BOUND[target] && body.state.bytes <= BOUND[target] + step,
        `${target}: pulled ${body.state.bytes} of ${total} bytes`);
    }
  }
  // The issue's reproduction, verbatim in shape: pipeline() of a close request.
  for (const header of [undefined, "1"]) {
    const body = tracked(spaces(step, total));
    const transport = new TursoHttpTransport({ url: "https://synthetic.invalid", authToken: "synthetic-not-secret" }, "synthetic",
      async () => new Response(body.stream, { headers: header ? { "content-length": header } : {} }));
    await assert.rejects(transport.pipeline([{ type: "close" }]), safe("POLICYSQL_DATABASE_UNAVAILABLE"));
    assert.ok(body.state.bytes < total);
    assert.equal(body.state.cancelled, true);
  }
});

test("#53: the bound counts UTF-8 bytes, not UTF-16 code units", async () => {
  // 1,048,576 three-byte characters: about 1 MiB of UTF-16 length, over 3 MiB of bytes. The
  // previous `text.length` check accepted this reply.
  const json = JSON.stringify({ baton: "b", results: [result(["name"], [["語".repeat(1_048_576)]])] });
  const bytes = encoder.encode(json);
  assert.ok(json.length < MAX_RESPONSE_BYTES && bytes.byteLength > MAX_RESPONSE_BYTES);
  const { state, stream } = tracked(chunked(bytes, 65_536));
  await assert.rejects(runStatement(transportFor("statement", () => new Response(stream))), safe("POLICYSQL_LIMIT_EXCEEDED"));
  assert.equal(state.cancelled, true);
  assert.ok(state.bytes <= MAX_RESPONSE_BYTES + 65_536);
});

test("#53: a declared Content-Length over the bound is rejected unread; a smaller one changes nothing", async () => {
  for (const target of ["statement", "begin", "commit"]) {
    const small = tracked(chunked(replyFor[target](1_024), 100));
    await assert.rejects(runners[target](transportFor(target, () => new Response(small.stream, {
      headers: { "content-length": String(BOUND[target] + 1) },
    }))), safe(OVERSIZED[target]), target);
    // A statement reply's first chunk is read for its leading baton (#96); the others are unread.
    if (target === "statement") assert.ok(small.state.bytes <= 100, `${target}: at most the first chunk read`);
    else assert.equal(small.state.bytes, 0, `${target}: nothing read`);
    assert.equal(small.state.cancelled, true, `${target}: released`);
  }
  // A declared length at the bound, below or above the real size, or absent: the received
  // bytes decide.
  for (const length of [String(MAX_RESPONSE_BYTES), "1", "0", "4096", null]) {
    const { state, stream } = tracked(chunked(statementReply(2_048), 100));
    const headers = length === null ? {} : { "content-length": length };
    assert.deepEqual((await runStatement(transportFor("statement", () => new Response(stream, { headers })))).rows, [[VALUE]], `content-length=${length}`);
    assert.equal(state.bytes, 2_048);
  }
});

test("#53: malformed UTF-8 is a transport failure (503), never a replacement character or a limit", async () => {
  const valid = encoder.encode(JSON.stringify({ baton: "b", results: [result(["name"], [["AB"]])] }));
  const at = new TextDecoder().decode(valid).indexOf("AB");
  const replacing = (...bytes) => {
    const out = new Uint8Array(valid.byteLength - 2 + bytes.length);
    out.set(valid.subarray(0, at));
    out.set(bytes, at);
    out.set(valid.subarray(at + 2), at + bytes.length);
    return out;
  };
  const invalid = {
    "lone continuation byte": replacing(0x80, 0x41),
    "invalid byte": replacing(0xff, 0x41),
    "overlong encoding": replacing(0xc0, 0xaf),
    "encoded surrogate": replacing(0xed, 0xa0, 0x80),
    "beyond U+10FFFF": replacing(0xf4, 0x90, 0x80, 0x80),
    "truncated sequence inside the text": replacing(0xe8, 0xaa),
  };
  for (const target of ["statement", "commit"]) {
    for (const [label, bytes] of Object.entries(invalid)) {
      for (const size of [bytes.byteLength, 1]) {
        const { stream } = tracked(chunked(bytes, size));
        await assert.rejects(runners[target](transportFor(target, () => new Response(stream))), safe("POLICYSQL_DATABASE_UNAVAILABLE"), `${target} ${label} size=${size}`);
      }
    }
    // A body that ends inside a multi-byte character fails at the final decode.
    const truncated = encoder.encode(`${JSON.stringify(JSON.parse(new TextDecoder().decode(replyFor[target](1_024))))} 語`).subarray(0, -1);
    await assert.rejects(runners[target](transportFor(target, () => new Response(truncated))), safe("POLICYSQL_DATABASE_UNAVAILABLE"), `${target} ends mid-character`);
  }
  // Malformed bytes early in a long body stop the read at that chunk.
  const big = new Uint8Array(MAX_RESPONSE_BYTES).fill(32);
  big[10] = 0xff;
  const { state, stream } = tracked(chunked(big, 65_536));
  await assert.rejects(runStatement(transportFor("statement", () => new Response(stream))), safe("POLICYSQL_DATABASE_UNAVAILABLE"));
  assert.equal(state.cancelled, true);
  assert.equal(state.bytes, 65_536, "the read stops at the malformed chunk");
});

test("#53: a leading byte order mark is removed, as Response.text() did", async () => {
  const body = new Uint8Array([0xef, 0xbb, 0xbf, ...statementReply(512)]);
  const { stream } = tracked(chunked(body, 2));
  assert.deepEqual((await runStatement(transportFor("statement", () => new Response(stream)))).rows, [[VALUE]]);
});

test("#53: a slow chunked body is read to the end within the timeout", async () => {
  const slow = tracked(chunked(statementReply(4_096), 512), { delayMs: 5 });
  assert.deepEqual((await runStatement(transportFor("statement", () => new Response(slow.stream)))).rows, [[VALUE]]);
  assert.equal(slow.state.bytes, 4_096);
  assert.equal(slow.state.pulls, 8);
});

test("#53: a body that stalls is cut at the request timeout and released; a COMMIT is a timeout, not a rejection", async () => {
  for (const target of ["statement", "begin", "commit"]) {
    const state = { pulls: 0, cancelled: false };
    const stream = new ReadableStream({
      pull(controller) {
        state.pulls++;
        if (state.pulls === 1) { controller.enqueue(encoder.encode('{"baton":"b",')); return undefined; }
        return new Promise(() => {});
      },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    const started = Date.now();
    // The fetch implementation ignores the signal: the transport itself bounds the read.
    await assert.rejects(runners[target](transportFor(target, () => new Response(stream)), 50), safe("POLICYSQL_DATABASE_TIMEOUT"), target);
    assert.ok(Date.now() - started < 1_000, `${target}: bounded by the timeout`);
    assert.equal(state.cancelled, true, `${target}: the stalled body is released`);
  }
});

test("#53: a body stream that fails is a transport failure with a fixed message", async () => {
  for (const target of ["statement", "begin", "commit"]) {
    const failing = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('{"baton":')); },
      pull(controller) { controller.error(new Error("connection reset: secret-detail")); },
    });
    await assert.rejects(runners[target](transportFor(target, () => new Response(failing))), safe("POLICYSQL_DATABASE_UNAVAILABLE"), target);
  }
  // An empty body is not a Hrana reply.
  await assert.rejects(runStatement(transportFor("statement", () => new Response(null))), safe("POLICYSQL_DATABASE_UNAVAILABLE"));
});

test("#53: a non-success reply is released unread whatever its size", async () => {
  const { state, stream } = tracked(spaces(65_536));
  await assert.rejects(runStatement(transportFor("statement", () => new Response(stream, { status: 500 }))), safe("POLICYSQL_DATABASE_UNAVAILABLE"));
  assert.equal(state.bytes, 0);
  assert.equal(state.cancelled, true);
});

// The reader itself, on a stream the Response constructor does not normalize.
test("readBoundedText: bound, non-byte chunks, aborts and argument checks", async () => {
  const of = (chunks, headers = {}) => ({
    headers: new Headers(headers),
    body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }),
  });
  assert.equal(await readBoundedText(of([encoder.encode("ab"), encoder.encode("c")]), 3), "abc");
  assert.equal(await readBoundedText({ headers: new Headers(), body: null }, 0), "");
  assert.equal(await readBoundedText(of([]), 0), "");
  await assert.rejects(readBoundedText(of([encoder.encode("abcd")]), 3), BodyTooLargeError);
  await assert.rejects(readBoundedText(of([encoder.encode("a")], { "content-length": "4" }), 3), BodyTooLargeError);
  let cancelled = false;
  const strings = { headers: new Headers(), body: new ReadableStream({ pull(controller) { controller.enqueue("{}"); }, cancel() { cancelled = true; } }) };
  await assert.rejects(readBoundedText(strings, 10), BodyReadError);
  assert.equal(cancelled, true, "a non-byte chunk releases the stream");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(readBoundedText(of([encoder.encode("a")]), 3, aborted.signal), { name: "AbortError" });
  for (const bound of [-1, 1.5, NaN, Infinity, "3"]) {
    await assert.rejects(readBoundedText(of([]), bound), TypeError, String(bound));
  }
});

// Regression (PR #86 review): releasing a body never waits for the source's cancel. A hostile
// stream whose cancel() never settles must not hold pipeline() past its error or its timeout.
test("#53: a body whose cancel never settles does not hold the transport", async () => {
  /** A stream whose `cancel()` never settles; `body(controller, pull)` drives its chunks. */
  const stubborn = (body) => {
    const state = { cancelCalls: 0, pulls: 0 };
    const stream = new ReadableStream({
      pull(controller) { state.pulls++; return body(controller, state.pulls); },
      cancel() { state.cancelCalls++; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    return { state, stream };
  };
  /** Settles within `ms`, or fails the test instead of hanging it. */
  const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: still pending after ${ms} ms`)), ms);
    timer.unref?.();
  })]);
  const cases = [
    ["over the bound", (controller) => { controller.enqueue(new Uint8Array(65_536).fill(32)); }, {}, 200, "POLICYSQL_LIMIT_EXCEEDED", 1000],
    ["declared over the bound", (controller) => { controller.enqueue(new Uint8Array(1)); }, { "content-length": String(MAX_RESPONSE_BYTES + 1) }, 200, "POLICYSQL_LIMIT_EXCEEDED", 1000],
    ["malformed UTF-8", (controller) => { controller.enqueue(Uint8Array.of(0xff)); }, {}, 200, "POLICYSQL_DATABASE_UNAVAILABLE", 1000],
    ["non-success status", (controller) => { controller.enqueue(new Uint8Array(1)); }, {}, 500, "POLICYSQL_DATABASE_UNAVAILABLE", 1000],
    ["stalled until the timeout", (controller, pull) => {
      if (pull === 1) { controller.enqueue(encoder.encode('{"baton":')); return undefined; }
      return new Promise(() => {});
    }, {}, 200, "POLICYSQL_DATABASE_TIMEOUT", 50],
  ];
  for (const [label, body, headers, status, code, timeoutMs] of cases) {
    const { state, stream } = stubborn(body);
    const run = runStatement(transportFor("statement", () => new Response(stream, { status, headers })), timeoutMs);
    await assert.rejects(within(run, 1_500, label), safe(code), label);
    assert.equal(state.cancelCalls, 1, `${label}: the body is released once`);
  }
  // The reader alone: an error with a stubborn cancel returns at once.
  const { stream } = stubborn((controller) => { controller.enqueue(new Uint8Array(8)); });
  await assert.rejects(within(readBoundedText({ headers: new Headers(), body: stream }, 4), 500, "reader"), BodyTooLargeError);
});
