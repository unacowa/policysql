import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { readBodyText as readWithLimit } from "../src/http/body.ts";
import { readBodyText } from "../src/request-body.ts";

// The transport checks that need JavaScript's view of the text, and core's strict body check
// (ADR 0027 pull request 7, #60, #66). The strict check runs in WASM: one parser for syntax,
// escapes, duplicate keys, depth, the value count, and the exact UTF-8 size.
initSync({ module: readFileSync(new URL("../pkg/policysql_wasm_bg.wasm", import.meta.url)) });
const example = (name) => readFileSync(new URL(`../../../examples/database-routing/${name}`, import.meta.url), "utf8");

const MAX_BODY_BYTES = 1_048_576;
const MAX_VALUES = 1_024;
const runtime = PolicySqlRuntime.newWithPhysicalSchema(
  example("catalog.yaml"), example("policy.yaml"), "schema_body_1", "policy_body_1",
  JSON.stringify({ max_rows: 100, max_result_bytes: 64_000, timeout_ms: 1_000, max_statements: 8, max_json_values: MAX_VALUES }),
  example("physical-schema.json"),
);
const check = (text) => JSON.parse(runtime.check_body_json(text));
const begin = (text) => JSON.parse(runtime.begin_body_json(text));
const errorOf = (result) => result.error;

const request = (body, headers = { "content-type": "application/json" }) => new Request("https://worker.test", {
  method: "POST",
  headers,
  body,
});
const code = (expected) => (caught) => caught.code === expected;
const readBodyTextWithDefault = (body, maxBytes = MAX_BODY_BYTES) => readWithLimit(body, maxBytes);

// Transport checks: required, raw lone surrogates (Rust cannot receive them), the cheap
// UTF-16 size test, and one leading byte order mark.
test("raw lone surrogates have no UTF-8 form and are rejected before the WASM boundary", async () => {
  const utf8 = (caught) => caught.code === "POLICYSQL_INVALID_REQUEST" && caught.message === "Request body is not valid UTF-8.";
  await assert.rejects(readBodyText('{"a":"\ud800"}', { maxRequestBytes: MAX_BODY_BYTES }), utf8);
  await assert.rejects(readBodyText('{"a":"\udc00x"}', { maxRequestBytes: MAX_BODY_BYTES }), utf8);
  assert.equal(await readBodyText('{"a":"😀"}', { maxRequestBytes: MAX_BODY_BYTES }), '{"a":"😀"}');
  await assert.rejects(readBodyText(undefined, { maxRequestBytes: MAX_BODY_BYTES }), code("POLICYSQL_INVALID_REQUEST"));
});

test("a deferred body is read only when the operation reaches it, with the limit to enforce, and its error is the operation's", async () => {
  let reads = 0;
  const handed = [];
  assert.equal(await readBodyText(async (maxBytes) => { reads++; handed.push(maxBytes); return "{}"; }, { maxRequestBytes: MAX_BODY_BYTES }), "{}");
  assert.equal(reads, 1);
  assert.deepEqual(handed, [MAX_BODY_BYTES], "the reader gets maxRequestBytes");
  await assert.rejects(readBodyText(async () => { throw Object.assign(new Error("x"), { code: "POLICYSQL_REQUEST_TOO_LARGE" }); },
    { maxRequestBytes: MAX_BODY_BYTES }), code("POLICYSQL_REQUEST_TOO_LARGE"));
});

test("one leading byte order mark is removed, a second is not, and the mark counts toward the limit", async () => {
  assert.equal(await readBodyText("﻿{}", { maxRequestBytes: MAX_BODY_BYTES }), "{}");
  assert.equal(await readBodyText("﻿﻿{}", { maxRequestBytes: MAX_BODY_BYTES }), "﻿{}");
  assert.equal(errorOf(check(await readBodyText("﻿﻿{}", { maxRequestBytes: MAX_BODY_BYTES }))).code,
    "POLICYSQL_INVALID_REQUEST");
  // A body whose stripped text fits but whose wire form is 3 bytes over is 413.
  const json = `"${"x".repeat(MAX_BODY_BYTES - 4)}"`;
  assert.equal(new TextEncoder().encode(`﻿${json}`).byteLength, MAX_BODY_BYTES + 1);
  await assert.rejects(readBodyText(`﻿${json}`, { maxRequestBytes: MAX_BODY_BYTES }), code("POLICYSQL_REQUEST_TOO_LARGE"));
  assert.equal(await readBodyText(json, { maxRequestBytes: MAX_BODY_BYTES }), json);
});

// Core's strict check: the one parse of the body's JSON, in order of the rules.
test("strict JSON syntax and duplicate keys are invalid requests", async () => {
  for (const text of ["", "[1,", '{"a":}', "1 2", "01", "1e400"]) {
    assert.equal(errorOf(check(text)).code, "POLICYSQL_INVALID_REQUEST", text);
    assert.equal(errorOf(check(text)).message, "Request body is not valid JSON.", text);
  }
  for (const text of ['{"params":{"id":1,"id":2}}', '{"params":{"id":1,"\\u0069d":2}}', '{"a":1,"a":2}']) {
    assert.equal(errorOf(check(text)).code, "POLICYSQL_INVALID_REQUEST", text);
    assert.equal(errorOf(check(text)).message, "Request body is not valid JSON.", text);
  }
  assert.deepEqual(check('{"a":[1,true,null,{"b":"x"}]}'), { ok: true });
  // The same name in different objects is not a duplicate.
  assert.deepEqual(check('[{"a":1},{"a":2}]'), { ok: true });
});

test("an escaped lone surrogate is rejected as the raw one is; an escaped pair is accepted (ADR 0025)", async () => {
  const utf8 = (result) => errorOf(result).code === "POLICYSQL_INVALID_REQUEST" &&
    errorOf(result).message === "Request body is not valid UTF-8.";
  for (const text of [
    '{"a":"\\ud800"}', '{"a":"\\udc00"}', '{"a":"\\uDBFF"}', '{"a":"x\\ud800y"}', '{"a":"\\udc00\\ud800"}',
    '{"a":"\\ud800\\u0041"}', '{"\\ud800":1}', '{"a":[{"b":"\\udfff"}]}', '"\\ud800"',
  ]) {
    assert.equal(text.includes("\ud800") || text.includes("\udc00"), false, "no raw surrogate in the text");
    assert.ok(utf8(check(text)), text);
  }
  for (const text of ['{"a":"\\ud83d\\ude00"}', '{"a":"\\\\ud800"}', '"😀"']) {
    assert.deepEqual(check(text), { ok: true }, text);
  }
});

test("nesting is accepted at exactly 64 levels and one more is JSON_TOO_DEEP", () => {
  const nested = (depth) => "[".repeat(depth) + "]".repeat(depth);
  const object = (depth) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  for (const text of [nested(64), object(64)]) assert.deepEqual(check(text), { ok: true });
  for (const text of [nested(65), object(65)]) {
    const error = errorOf(check(text));
    assert.equal(error.code, "POLICYSQL_JSON_TOO_DEEP", "the cause is named, not malformed JSON");
    assert.equal(error.message, "Request body nests too deeply.");
  }
});

test("the body limit is the exact UTF-8 byte length, not UTF-16 units", async () => {
  const fits = `"${"x".repeat(MAX_BODY_BYTES - 2)}"`;
  assert.deepEqual(check(fits), { ok: true });
  assert.equal(errorOf(check(`${fits} `)).code, "POLICYSQL_REQUEST_TOO_LARGE");
  // Under the limit in UTF-16 units, over it in UTF-8 bytes; the transport's cheap length test
  // passes it and core rejects it.
  const wide = `"${"é".repeat((MAX_BODY_BYTES - 2) / 2)}"`;
  assert.ok(wide.length < MAX_BODY_BYTES);
  assert.deepEqual(check(wide), { ok: true });
  const over = `"${"é".repeat((MAX_BODY_BYTES - 2) / 2)}é"`;
  assert.ok(over.length < MAX_BODY_BYTES);
  assert.equal(errorOf(check(over)).code, "POLICYSQL_REQUEST_TOO_LARGE");
  assert.equal(errorOf(check(over)).message, "Request body exceeds the size limit.");
  // The transport's UTF-16 test cannot decide it; the text still reaches core, which rejects.
  assert.equal(await readBodyText(over, { maxRequestBytes: MAX_BODY_BYTES }), over);
});

// What counts: every JSON value (containers, strings, numbers, literals) and every object
// member name. `[1,2]` is 3, `{"a":1}` is 3.
test("maxJsonValues counts values and member names, exactly at the limit and one over", () => {
  const accepts = (text, maxValues = MAX_VALUES) => maxValues === MAX_VALUES
    ? check(text).ok === true
    : errorOf(check(text)).code !== "POLICYSQL_REQUEST_TOO_LARGE";
  assert.equal(accepts("1"), true);
  assert.equal(accepts("[]"), true);
  const flat = (values) => `[${Array(values - 1).fill(1).join(",")}]`;
  assert.equal(accepts(flat(MAX_VALUES)), true, "1024 values");
  assert.equal(accepts(flat(MAX_VALUES + 1)), false, "1025 values");
  // One object of n members: 1 + 2n values.
  const members = (n) => `{${Array.from({ length: n }, (_, index) => `"k${index}":1`).join(",")}}`;
  assert.equal(accepts(members((MAX_VALUES - 1) / 2)), true);
  assert.equal(accepts(members((MAX_VALUES + 1) / 2)), false);
  const error = errorOf(check(flat(MAX_VALUES + 1)));
  assert.equal(error.code, "POLICYSQL_REQUEST_TOO_LARGE");
  assert.equal(error.message, "Request body has too many JSON values.");
});

test("the value count stops the check before any tree exists, and invalid JSON stays invalid", () => {
  // 100,000 values: over the limit by a wide margin. The visitor stops at the first value over.
  const body = `[${Array(100_000).fill(1).join(",")}]`;
  assert.equal(errorOf(check(body)).code, "POLICYSQL_REQUEST_TOO_LARGE");
  const nested = (depth) => "[".repeat(depth) + "]".repeat(depth);
  assert.equal(errorOf(check(`[${Array(2_000).fill(nested(56)).join(",")}]`)).code, "POLICYSQL_REQUEST_TOO_LARGE");
  assert.equal(errorOf(check("[1,")).code, "POLICYSQL_INVALID_REQUEST");
});

test("begin_body_json checks the strict rules and the two-field shape, and keeps a present null distinct", () => {
  assert.deepEqual(begin('{"mode":"read"}'), { ok: true, mode: "read" });
  assert.deepEqual(begin('{"mode":"write","expected":{"schemaVersion":1,"policyVersion":2}}'),
    { ok: true, mode: "write", expected: { schemaVersion: 1, policyVersion: 2 } });
  const invalid = (text, message = "The request is invalid.", errorCode = "POLICYSQL_INVALID_REQUEST") => {
    const result = begin(text);
    assert.equal(errorOf(result).code, errorCode, text);
    assert.equal(errorOf(result).message, message, text);
  };
  invalid('{"mode":"drop"}');
  invalid('{"mode":"read","other":1}');
  invalid('{"expected":{"schemaVersion":1,"policyVersion":2}}');
  invalid('{"mode":"read","expected":null}');
  invalid('{"mode":"read","expected":{}}');
  invalid('{"mode":"read","expected":{"schemaVersion":1}}');
  invalid('{"mode":"read","expected":{"schemaVersion":1,"policyVersion":2,"extra":3}}');
  // The strict rules come first and keep their own cause.
  invalid('{"mode":"read","mode":"write"}', "Request body is not valid JSON.");
  const deep = `{"mode":"read","expected":${"[".repeat(65)}${"]".repeat(65)}}`;
  invalid(deep, "Request body nests too deeply.", "POLICYSQL_JSON_TOO_DEEP");
});

// HTTP framing: the adapter decodes bytes strictly and bounds the stream.
test("HTTP body framing: media type, declared and streamed size, strict UTF-8", async () => {
  await assert.rejects(readBodyTextWithDefault(request("{}", { "content-type": "text/plain" })), code("POLICYSQL_UNSUPPORTED_MEDIA_TYPE"));
  await assert.rejects(readBodyTextWithDefault(request("{}", { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) })),
    code("POLICYSQL_REQUEST_TOO_LARGE"));
  await assert.rejects(readBodyTextWithDefault(request("x".repeat(MAX_BODY_BYTES + 1))), code("POLICYSQL_REQUEST_TOO_LARGE"));
  await assert.rejects(readBodyTextWithDefault(request(new Uint8Array([0x7b, 0xff, 0x7d]))), (caught) =>
    caught.code === "POLICYSQL_INVALID_REQUEST" && caught.message === "Request body is not valid UTF-8.");
  assert.equal(await readBodyTextWithDefault(request('{"a":"é"}', { "content-type": "Application/JSON; charset=utf-8" })), '{"a":"é"}');
});

test("maxRequestBytes: exactly the limit is accepted and one over is 413, ASCII and multi-byte", async () => {
  for (const maxRequestBytes of [65_536, 1_048_576, 2_097_152]) {
    const exact = `"${"x".repeat(maxRequestBytes - 2)}"`;
    assert.equal((await readBodyText(exact, { maxRequestBytes })).length, maxRequestBytes);
    await assert.rejects(readBodyText(`"${"x".repeat(maxRequestBytes - 1)}"`, { maxRequestBytes }), code("POLICYSQL_REQUEST_TOO_LARGE"));
    assert.equal((await readWithLimit(request(exact), maxRequestBytes)).length, maxRequestBytes);
    await assert.rejects(readWithLimit(request(`${exact} `), maxRequestBytes), code("POLICYSQL_REQUEST_TOO_LARGE"));
    await assert.rejects(readWithLimit(request("{}", { "content-type": "application/json", "content-length": String(maxRequestBytes + 1) }), maxRequestBytes),
      code("POLICYSQL_REQUEST_TOO_LARGE"));
  }
  await assert.rejects(readWithLimit(request("{}"), 0), TypeError);
  await assert.rejects(readWithLimit(request("{}"), Infinity), TypeError);
});
