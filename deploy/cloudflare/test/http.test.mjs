import test from "node:test";
import assert from "node:assert/strict";
import { MAX_BODY_BYTES, parseBodyText } from "../src/request-body.ts";
import { readBodyText } from "../src/http/body.ts";

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

test("the body limit counts UTF-8 bytes, not UTF-16 units", async () => {
  const fits = `{"a":"${"x".repeat(MAX_BODY_BYTES - 8)}"}`;
  assert.equal((await parseBodyText(fits)).text.length, MAX_BODY_BYTES);
  // Under the limit in UTF-16 units, over it in UTF-8 bytes.
  const wide = `{"a":"${"é".repeat(MAX_BODY_BYTES / 2)}"}`;
  assert.ok(wide.length < MAX_BODY_BYTES);
  await assert.rejects(parseBodyText(wide), code("POLICYSQL_REQUEST_TOO_LARGE"));
});

test("a deferred body is read only when the operation reaches it, and its error is the operation's", async () => {
  let reads = 0;
  assert.equal((await parseBodyText(async () => { reads++; return "{}"; })).text, "{}");
  assert.equal(reads, 1);
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
