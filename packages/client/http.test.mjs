import assert from "node:assert/strict";
import test from "node:test";
import { createHttpTransport } from "./index.js";

const endpoint = "https://gateway.test/base";
const tx = `tx_${"a".repeat(32)}`;

test("HTTP routes one request per call, preserving body, role, key and signal", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const transport = createHttpTransport({ endpoint, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ error: { message: "server response" } }, { status: 503 });
  } });
  for (const [kind, path, method] of [["execute", "transactions:execute", "POST"], ["explain", "transactions:explain", "POST"],
    ["begin", "transactions", "POST"], ["catalog", "catalog", "GET"], ["capabilities", "capabilities", "GET"],
    ["statement", `transactions/${tx}/statements`, "POST"], ["commit", `transactions/${tx}/commit`, "POST"], ["rollback", `transactions/${tx}/rollback`, "POST"]]) {
    const request = { kind, role: "author", ...(method === "POST" ? { body: '{"fixed": true}' } : {}),
      ...(["statement", "commit", "rollback"].includes(kind) ? { transactionId: tx } : {}),
      ...(kind === "execute" ? { idempotencyKey: "fixed-operation-key" } : {}) };
    const response = await transport(request, { signal });
    assert.deepEqual(response, { status: 503, body: { error: { message: "server response" } } });
    const { url, init } = calls.at(-1);
    assert.equal(url.href, `https://gateway.test/v1/${path}`);
    assert.equal(init.method, method);
    assert.equal(init.body, request.body);
    assert.equal(init.signal, signal);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.get("policysql-role"), "author");
    assert.equal(init.headers.get("authorization"), null);
    assert.equal(init.headers.get("idempotency-key"), request.idempotencyKey ?? null);
  }
  assert.equal(calls.length, 8);
});

test("HTTP endpoint and fetch reference are captured at construction", async () => {
  const calls = [];
  const options = { endpoint, fetchImpl: async url => { calls.push(String(url)); return Response.json({}); } };
  const transport = createHttpTransport(options);
  options.endpoint = "https://other.test";
  options.fetchImpl = () => { throw new Error("changed"); };
  await transport({ kind: "catalog" });
  assert.deepEqual(calls, ["https://gateway.test/v1/catalog"]);
  for (const options of [{ endpoint: "http://remote.test" }, { endpoint: "ftp://localhost" }, { endpoint: "https://user:pass@host.test" },
    { endpoint, token: "old" }, { endpoint, fetchImpl: null }]) assert.throws(() => createHttpTransport(options), TypeError);
});

test("default fetch captures the platform receiver; explicit fetch remains usable unchanged", async () => {
  const previous = globalThis.fetch;
  const receivers = [];
  globalThis.fetch = function () { receivers.push(this); return Promise.resolve(Response.json({})); };
  try {
    const defaultTransport = createHttpTransport({ endpoint });
    const explicitTransport = createHttpTransport({ endpoint, fetchImpl: globalThis.fetch });
    await defaultTransport({ kind: "catalog" });
    await explicitTransport({ kind: "catalog" });
    assert.equal(receivers[0], globalThis);
    assert.equal(receivers[1], undefined);
  } finally { globalThis.fetch = previous; }
});

test("HTTP propagates original fetch, body stream and JSON parse exceptions", async () => {
  const original = new Error("network failure");
  const fetchFailure = createHttpTransport({ endpoint, fetchImpl: async () => { throw original; } });
  await assert.rejects(fetchFailure({ kind: "catalog" }), error => error === original);
  const streamFailure = createHttpTransport({ endpoint, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(original); } })) });
  await assert.rejects(streamFailure({ kind: "catalog" }), error => error === original);
  const invalid = createHttpTransport({ endpoint, fetchImpl: async () => new Response("not json") });
  await assert.rejects(invalid({ kind: "catalog" }), SyntaxError);
});

test("HTTP rejects unsupported routing and malformed requests without sending", async () => {
  let count = 0;
  const transport = createHttpTransport({ endpoint, fetchImpl: async () => { count++; return Response.json({}); } });
  for (const request of [{ kind: "unknown" }, { kind: "toString" }, { kind: "catalog", url: "https://other.test" },
    { kind: "begin", body: "{}", idempotencyKey: "fixed-operation-key" },
    { kind: "statement", transactionId: "../bad", body: "{}" }, { kind: "execute", body: {} },
    { kind: "execute", body: "{}", role: "admin\n" }]) await assert.rejects(transport(request), TypeError);
  assert.equal(count, 0);
});

test("HTTP passes large requests and responses without imposing size limits", async () => {
  const payload = { data: "x".repeat(2 * 1024 * 1024) };
  const body = JSON.stringify(payload);
  for (const headers of [{}, { "content-length": String(body.length) }]) {
    const transport = createHttpTransport({ endpoint, fetchImpl: async (_url, init) => {
      assert.equal(init.body, body);
      return new Response(body, { headers });
    } });
    assert.deepEqual(await transport({ kind: "execute", body }), { status: 200, body: payload });
  }
});

test("cancel before send preserves reason and fetch injection can prevent delayed sending", async () => {
  let sends = 0;
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const transport = createHttpTransport({ endpoint, fetchImpl: async (_url, init) => {
    entered.resolve();
    await resume.promise;
    init.signal?.throwIfAborted();
    sends++;
    return Response.json({});
  } });
  const reason = new Error("cancel");
  await assert.rejects(transport({ kind: "catalog" }, { signal: AbortSignal.abort(reason) }), error => error === reason);
  const controller = new AbortController();
  const checked = assert.rejects(transport({ kind: "catalog" }, { signal: controller.signal }), error => error === reason);
  await entered.promise;
  controller.abort(reason);
  resume.resolve();
  await checked;
  assert.equal(sends, 0);
});

test("cancellation during response body reading preserves the stream failure", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const reason = new Error("stop reading");
  const transport = createHttpTransport({ endpoint, fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
    start(stream) {
      signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
      entered.resolve();
    },
  })) });
  const checked = assert.rejects(transport({ kind: "catalog" }, { signal: controller.signal }), error => error === reason);
  await entered.promise;
  controller.abort(reason);
  await checked;
});
