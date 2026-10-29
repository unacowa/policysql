import test from "node:test";
import assert from "node:assert/strict";
import { httpConformanceCases, runHttpConformance } from "../src/http/conformance.ts";
import { createHttpAdapter } from "../src/http/adapter.ts";

// The library's HTTP conformance suite (ADR 0023) against the shipped HTTP adapter. A custom
// HTTP mapping runs the same cases through `runHttpConformance`.
for (const conformance of httpConformanceCases) {
  test(`shipped HTTP adapter: ${conformance.name}`, async (t) => {
    t.mock.method(console, "log", () => {});
    await conformance.run((engine) => createHttpAdapter(engine));
  });
}

test("the suite reports a non-conforming mapping instead of passing it", async (t) => {
  t.mock.method(console, "log", () => {});
  // A mapping that renders every error as 400 and forgets the fixed headers.
  const sloppy = (engine) => {
    const real = createHttpAdapter(engine);
    const rewrite = async (response) => {
      if (response.status < 400) return response;
      return new Response(await response.text(), { status: 400, headers: { "content-type": "application/json" } });
    };
    return {
      fetch: async (...args) => rewrite(await real.fetch(...args)),
      fetchCallback: async (...args) => rewrite(await real.fetchCallback(...args)),
    };
  };
  const results = await runHttpConformance(sloppy);
  assert.equal(results.length, httpConformanceCases.length);
  assert.ok(results.filter((result) => !result.ok).length >= 4, JSON.stringify(results.map((result) => [result.name, result.ok])));
  assert.ok((await runHttpConformance((engine) => createHttpAdapter(engine))).every((result) => result.ok));
});
