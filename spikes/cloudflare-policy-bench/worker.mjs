import { benchmark, initSync } from "./pkg/policysql_cloudflare_policy_bench.js";
import wasm from "./pkg/policysql_cloudflare_policy_bench_bg.wasm";

let initialized;
const initialize = () => (initialized ??= initSync({ module: wasm }));

export default {
  async fetch(request, env) {
    if (request.headers.get("authorization") !== `Bearer ${env.BENCH_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    initialize();
    const url = new URL(request.url);
    const caseName = url.searchParams.get("case") ?? "simple";
    const iterations = Math.min(1_000, Math.max(1, Number(url.searchParams.get("iterations") ?? 1)));
    const started = performance.now();
    const result = benchmark(caseName, iterations);
    const elapsedMs = performance.now() - started;
    return Response.json({ case: caseName, iterations, elapsedMs, perIterationMs: elapsedMs / iterations, result });
  },
};
