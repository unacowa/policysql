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

test("the suite fails a mapping that reads the body before the engine checks the session and database", async (t) => {
  t.mock.method(console, "log", () => {});
  // The shipped adapter over an engine wrapper that resolves every body before the call.
  const eager = (engine) => createHttpAdapter(Object.fromEntries(Object.entries(engine).map(([name, operation]) => [name,
    async (input, ...rest) => {
      if (typeof input?.bodyText !== "function") return operation(input, ...rest);
      let bodyText;
      try { bodyText = await input.bodyText(); } catch (error) { bodyText = async () => { throw error; }; }
      return operation({ ...input, bodyText }, ...rest);
    }])));
  const results = await runHttpConformance(eager);
  const failed = results.filter((result) => !result.ok);
  assert.ok(failed.length > 0);
  assert.ok(failed.some((result) => /read eagerly/u.test(String(result.error?.message))), JSON.stringify(failed.map((r) => r.name)));
});
