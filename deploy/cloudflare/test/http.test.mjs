import test from "node:test";
import assert from "node:assert/strict";
import { parseBodyText as parseWithLimits } from "../src/request-body.ts";
import { readBodyText as readWithLimit } from "../src/http/body.ts";

// The limits the runtime reports by default (ADR 0027); the engine hands them to both.
const LIMITS = { maxRequestBytes: 1_048_576, maxJsonValues: 65_536 };
const MAX_BODY_BYTES = LIMITS.maxRequestBytes;
const parseBodyText = (body, limits = LIMITS) => parseWithLimits(body, limits);
const readBodyText = (body, maxBytes = MAX_BODY_BYTES) => readWithLimit(body, maxBytes);

const request = (body, headers = { "content-type": "application/json" }) => new Request("https://worker.test", {
  method: "POST",
  headers,
  body,
});
const code = (expected) => (error) => error.code === expected;

// Transport-independent checks: the engine applies them to every transport's text.
test("rejects duplicate keys including escaped equivalent keys", async () => {
  await assert.rejects(parseBodyText('{"params":{"id":1,"id":2}}'), code("POLICYSQL_INVALID_REQUEST"));
  await assert.rejects(parseBodyText('{"params":{"id":1,"\\u0069d":2}}'), code("POLICYSQL_INVALID_REQUEST"));
});

test("accepts nested arrays and objects without duplicate keys", async () => {
  const result = await parseBodyText('{"a":[1,true,null,{"b":"x"}]}');
  assert.equal(result.value.a[3].b, "x");
});

test("a lone surrogate has no UTF-8 form and is rejected; a surrogate pair is accepted", async () => {
  await assert.rejects(parseBodyText('{"a":"\ud800"}'), (error) =>
    error.code === "POLICYSQL_INVALID_REQUEST" && error.message === "Request body is not valid UTF-8.");
  await assert.rejects(parseBodyText('{"a":"\udc00x"}'), code("POLICYSQL_INVALID_REQUEST"));
  assert.equal((await parseBodyText('{"a":"😀"}')).value.a, "\u{1f600}");
});

test("an escaped lone surrogate is rejected as the raw one is; an escaped pair is accepted (ADR 0025)", async () => {
  const utf8 = (error) => error.code === "POLICYSQL_INVALID_REQUEST" && error.message === "Request body is not valid UTF-8.";
  // Six ASCII characters each: valid UTF-8 text, but the string they denote has no UTF-8 form.
  for (const text of [
    '{"a":"\\ud800"}', '{"a":"\\udc00"}', '{"a":"\\uDBFF"}', '{"a":"x\\ud800y"}', '{"a":"\\udc00\\ud800"}',
    '{"a":"\\ud800\\u0041"}', '{"\\ud800":1}', '{"a":[{"b":"\\udfff"}]}', '"\\ud800"',
  ]) {
    assert.equal(text.includes("\ud800") || text.includes("\udc00"), false, "no raw surrogate in the text");
    await assert.rejects(parseBodyText(text), utf8, text);
  }
  // The raw form, for comparison: the same error.
  await assert.rejects(parseBodyText('{"a":"\ud800"}'), utf8);
  await assert.rejects(parseBodyText('{"a":"\udc00"}'), utf8);
  // An escaped pair is one character; an escaped backslash before `u` is not an escape.
  assert.equal((await parseBodyText('{"a":"\\ud83d\\ude00"}')).value.a, "\u{1f600}");
  assert.equal((await parseBodyText('{"a":"\\\\ud800"}')).value.a, "\\ud800");
  assert.equal((await parseBodyText('{"a":"\\u00e9\\u2028"}')).value.a, "\u00e9\u2028");
});

test("the body limit counts UTF-8 bytes, not UTF-16 units", async () => {
  const fits = `{"a":"${"x".repeat(MAX_BODY_BYTES - 8)}"}`;
  assert.equal((await parseBodyText(fits)).text.length, MAX_BODY_BYTES);
  // Under the limit in UTF-16 units, over it in UTF-8 bytes.
  const wide = `{"a":"${"é".repeat(MAX_BODY_BYTES / 2)}"}`;
  assert.ok(wide.length < MAX_BODY_BYTES);
  await assert.rejects(parseBodyText(wide), code("POLICYSQL_REQUEST_TOO_LARGE"));
});

test("a deferred body is read only when the operation reaches it, with the limit to enforce, and its error is the operation's", async () => {
  let reads = 0;
  const handed = [];
  assert.equal((await parseBodyText(async (maxBytes) => { reads++; handed.push(maxBytes); return "{}"; })).text, "{}");
  assert.equal(reads, 1);
  assert.deepEqual(handed, [MAX_BODY_BYTES], "the reader gets maxRequestBytes");
  assert.deepEqual(
    (await parseBodyText(async (maxBytes) => `"${"x".repeat(maxBytes - 2)}"`, { ...LIMITS, maxRequestBytes: 4_096 })).text.length, 4_096);
  await assert.rejects(parseBodyText(async () => { throw Object.assign(new Error("x"), { code: "POLICYSQL_REQUEST_TOO_LARGE" }); }),
    code("POLICYSQL_REQUEST_TOO_LARGE"));
  await assert.rejects(parseBodyText(undefined), code("POLICYSQL_INVALID_REQUEST"));
});

// HTTP framing: the adapter decodes bytes strictly and bounds the stream.
test("HTTP body framing: media type, declared and streamed size, strict UTF-8", async () => {
  await assert.rejects(readBodyText(request("{}", { "content-type": "text/plain" })), code("POLICYSQL_UNSUPPORTED_MEDIA_TYPE"));
  await assert.rejects(readBodyText(request("{}", { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) })),
    code("POLICYSQL_REQUEST_TOO_LARGE"));
  await assert.rejects(readBodyText(request("x".repeat(MAX_BODY_BYTES + 1))), code("POLICYSQL_REQUEST_TOO_LARGE"));
  await assert.rejects(readBodyText(request(new Uint8Array([0x7b, 0xff, 0x7d]))), (error) =>
    error.code === "POLICYSQL_INVALID_REQUEST" && error.message === "Request body is not valid UTF-8.");
  assert.equal(await readBodyText(request('{"a":"é"}', { "content-type": "Application/JSON; charset=utf-8" })), '{"a":"é"}');
});

test("one leading byte order mark is accepted the same way over HTTP and directly, and counts toward the limit", async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const bytes = (text) => new Uint8Array([...bom, ...new TextEncoder().encode(text)]);
  // HTTP keeps the BOM in the text; the engine removes exactly one, for every transport.
  const overHttp = await readBodyText(request(bytes("{}")));
  assert.equal(overHttp, "﻿{}");
  assert.deepEqual((await parseBodyText(overHttp)).value, {});
  assert.equal((await parseBodyText("﻿{}")).text, "{}");
  await assert.rejects(parseBodyText("﻿﻿{}"), code("POLICYSQL_INVALID_REQUEST"));
  await assert.rejects(parseBodyText(await readBodyText(request(new Uint8Array([...bom, ...bytes("{}")])))), code("POLICYSQL_INVALID_REQUEST"));
  // The BOM's 3 bytes count on both sides: limit - 2 bytes of JSON plus a BOM is over.
  const json = `"${"x".repeat(MAX_BODY_BYTES - 4)}"`;
  assert.equal(new TextEncoder().encode(json).byteLength, MAX_BODY_BYTES - 2);
  await assert.rejects(parseBodyText(`﻿${json}`), code("POLICYSQL_REQUEST_TOO_LARGE"));
  await assert.rejects(readBodyText(request(bytes(json))), code("POLICYSQL_REQUEST_TOO_LARGE"));
  assert.equal((await parseBodyText(json)).text, json);
});

// ADR 0027: the limits are the runtime's, so every check follows the configured value.
test("maxRequestBytes: exactly the limit is accepted and one over is 413, at the minimum and the maximum", async () => {
  for (const maxRequestBytes of [65_536, 1_048_576, 2_097_152]) {
    const limits = { maxRequestBytes, maxJsonValues: 1_024 };
    const exact = `"${"x".repeat(maxRequestBytes - 2)}"`;
    assert.equal((await parseBodyText(exact, limits)).text.length, maxRequestBytes);
    await assert.rejects(parseBodyText(`"${"x".repeat(maxRequestBytes - 1)}"`, limits), code("POLICYSQL_REQUEST_TOO_LARGE"));
    // The stream reader enforces the same value, declared and streamed, ASCII and multi-byte.
    assert.equal((await readBodyText(request(exact), maxRequestBytes)).length, maxRequestBytes);
    await assert.rejects(readBodyText(request(`${exact} `), maxRequestBytes), code("POLICYSQL_REQUEST_TOO_LARGE"));
    await assert.rejects(readBodyText(request("{}", { "content-type": "application/json", "content-length": String(maxRequestBytes + 1) }), maxRequestBytes),
      code("POLICYSQL_REQUEST_TOO_LARGE"));
    const wide = `"${"é".repeat((maxRequestBytes - 2) / 2)}"`;
    assert.equal(new TextEncoder().encode(wide).byteLength, maxRequestBytes);
    assert.equal((await readBodyText(request(wide), maxRequestBytes)).length, wide.length);
    await assert.rejects(readBodyText(request(`${wide} `), maxRequestBytes), code("POLICYSQL_REQUEST_TOO_LARGE"));
    await assert.rejects(parseBodyText(`${wide} `, limits), code("POLICYSQL_REQUEST_TOO_LARGE"));
  }
  await assert.rejects(readBodyText(request("{}"), 0), TypeError);
  await assert.rejects(readBodyText(request("{}"), Infinity), TypeError);
});

// What counts: every JSON value (containers, strings, numbers, literals) and every object
// member name. `[1,2]` is 3, `{"a":1}` is 3.
const count = async (text, maxJsonValues) => {
  try { await parseWithLimits(text, { maxRequestBytes: 1_048_576, maxJsonValues }); return true; } catch (error) {
    assert.equal(error.code, "POLICYSQL_REQUEST_TOO_LARGE", text);
    return false;
  }
};

test("maxJsonValues counts values and member names, exactly at the limit and one over", async () => {
  for (const [text, values] of [
    ["1", 1], ["[]", 1], ["{}", 1], ["[1,2]", 3], ['{"a":1}', 3], ['{"a":[1,"x",null,true]}', 7],
    ['[{"a":1},{"b":2}]', 7], ['"s"', 1], ['{"a":{"b":{"c":1}}}', 7],
  ]) {
    assert.equal(await count(text, values), true, `${text} at ${values}`);
    assert.equal(await count(text, values - 1), false, `${text} at ${values - 1}`);
  }
  for (const maxJsonValues of [1_024, 65_536, 131_072]) {
    const flat = (values) => `[${Array(values - 1).fill(1).join(",")}]`;
    assert.equal(await count(flat(maxJsonValues), maxJsonValues), true, `flat at ${maxJsonValues}`);
    assert.equal(await count(flat(maxJsonValues + 1), maxJsonValues), false, `flat over ${maxJsonValues}`);
    // One array, one object of n members: 2 + 2n values, so n = (limit - 2) / 2 is exactly the limit.
    const members = (n) => `[{${Array.from({ length: n }, (_, index) => `"k${index}":1`).join(",")}}]`;
    assert.equal(await count(members((maxJsonValues - 2) / 2), maxJsonValues), true, `members at ${maxJsonValues}`);
    assert.equal(await count(members(maxJsonValues / 2), maxJsonValues), false, `members over ${maxJsonValues}`);
  }
});

test("the value count stops the scan before JSON.parse, so a dense body is never materialized", async (t) => {
  const parse = t.mock.method(JSON, "parse");
  // 100,000 values: over the limit of 1,024 by a wide margin. The scan decodes only strings it
  // meets before it stops (member names and values), never the body as a whole.
  const body = `[${Array(100_000).fill(1).join(",")}]`;
  await assert.rejects(parseWithLimits(body, { maxRequestBytes: 1_048_576, maxJsonValues: 1_024 }), code("POLICYSQL_REQUEST_TOO_LARGE"));
  assert.ok(parse.mock.callCount() <= 1_024 + 1, `the scan parsed ${parse.mock.callCount()} fragments, none of them the body`);
  assert.ok(parse.mock.calls.every((call) => call.arguments[0].length < 16), "no call received the body text");
  // Nested arrays, the shape that costs the most per byte, depth 56 (ADR 0027 measurements).
  parse.mock.resetCalls();
  const nested = (depth) => "[".repeat(depth) + "]".repeat(depth);
  await assert.rejects(parseWithLimits(`[${Array(2_000).fill(nested(56)).join(",")}]`, { maxRequestBytes: 1_048_576, maxJsonValues: 65_536 }),
    code("POLICYSQL_REQUEST_TOO_LARGE"));
  assert.equal(parse.mock.callCount(), 0, "containers need no JSON.parse; the count stopped before the body was parsed");
});

test("a body over maxJsonValues is 413 with a fixed message, not an invalid body", async () => {
  const error = await parseWithLimits(`[1,2,3,4]`, { maxRequestBytes: 1_048_576, maxJsonValues: 3 }).catch((caught) => caught);
  assert.equal(error.code, "POLICYSQL_REQUEST_TOO_LARGE");
  assert.equal(error.message, "Request body has too many JSON values.");
  assert.equal(error.path, null);
  // Invalid JSON stays invalid, whatever the limit.
  await assert.rejects(parseWithLimits("[1,", { maxRequestBytes: 1_048_576, maxJsonValues: 3 }), code("POLICYSQL_INVALID_REQUEST"));
});
