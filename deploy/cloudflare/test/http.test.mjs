import test from "node:test";
import assert from "node:assert/strict";
import { readJsonBody } from "../src/http.ts";

const request = (body) => new Request("https://worker.test", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

test("rejects duplicate keys including escaped equivalent keys", async () => {
  await assert.rejects(
    readJsonBody(request('{"params":{"id":1,"id":2}}')),
    (error) => error.code === "POLICYSQL_INVALID_REQUEST",
  );
  await assert.rejects(
    readJsonBody(request('{"params":{"id":1,"\\u0069d":2}}')),
    (error) => error.code === "POLICYSQL_INVALID_REQUEST",
  );
});

test("accepts nested arrays and objects without duplicate keys", async () => {
  const result = await readJsonBody(request('{"a":[1,true,null,{"b":"x"}]}'));
  assert.equal(result.value.a[3].b, "x");
});
