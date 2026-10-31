// The reference wrapper stays consistent with ADR 0027's CPU formula by test:
//
//   cpu_ms >= S * F * (C0 + a_b * (R + B) + a_v * (V_req + V_res))
//
// evaluated at the limits the wrapper configures (wrapper/limits.ts, as the runtime reports them)
// and compared with `limits.cpu_ms` in wrangler.jsonc. The library itself never refuses a limit
// for CPU reasons (ADR 0027, "The library does not refuse a combination"); this is the wrapper's
// own check, and a wrapper with another F, platform or limits adapts its own copy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { runtimeLimits, runtimeLimitsJson } from "../src/limits.ts";
import { RUNTIME_LIMITS } from "../wrapper/limits.ts";
import { HARDWARE_FACTOR, SAFETY_MARGIN, inputsAtLimits, predictedReferenceMs, requiredCpuMs } from "../scripts/lib/cpu-model.mjs";
import { parseJsonc } from "../scripts/lib/jsonc.mjs";

initSync({ module: readFileSync(new URL("../pkg/policysql_wasm_bg.wasm", import.meta.url)) });
const example = (name) => readFileSync(new URL(`../../../examples/database-routing/${name}`, import.meta.url), "utf8");
const config = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
/** The platform's ceiling for `limits.cpu_ms` on Workers Paid. */
const PLATFORM_MAX_CPU_MS = 300_000;

/** The limits the runtime enforces for `limits` (it fills fixed constants such as `maxRequestBytes`). */
const effectiveLimits = (limits) => {
  const runtime = PolicySqlRuntime.newWithPhysicalSchema(
    example("catalog.yaml"), example("policy.yaml"), "schema_cpu_1", "policy_cpu_1",
    runtimeLimitsJson(limits), example("physical-schema.json"),
  );
  try { return runtimeLimits(runtime); } finally { runtime.free(); }
};

/** The check this file stands for: what `cpu_ms` the formula needs, and whether `cpuMs` is enough. */
const checkCpuBudget = (cpuMs, limits, options) => {
  const needed = requiredCpuMs(inputsAtLimits(effectiveLimits(limits)), options);
  return { needed, ok: cpuMs >= needed };
};

test("wrangler.jsonc limits.cpu_ms satisfies the ADR 0027 formula at the wrapper's limits", () => {
  const cpuMs = config.limits?.cpu_ms;
  assert.ok(Number.isInteger(cpuMs) && cpuMs > 0 && cpuMs <= PLATFORM_MAX_CPU_MS, "limits.cpu_ms is a positive integer within the platform's range");
  const { needed, ok } = checkCpuBudget(cpuMs, RUNTIME_LIMITS);
  assert.ok(ok, `limits.cpu_ms ${cpuMs} is below ${needed.toFixed(0)} ms: S=${SAFETY_MARGIN} x F=${HARDWARE_FACTOR} x the reference time at the wrapper's limits`);
});

test("the formula at the reference wrapper's limits is the ADR's worked number", () => {
  const inputs = inputsAtLimits(effectiveLimits(RUNTIME_LIMITS));
  // ADR 0027: R = 1 MiB, B = 1.13 MiB (the lookup bound), V = 65,536 each side.
  assert.equal(inputs.rMiB, 1);
  assert.ok(Math.abs(inputs.bMiB - 1_183_744 / 1_048_576) < 1e-9);
  assert.equal(inputs.vReq, 65_536);
  assert.equal(inputs.vRes, 65_536);
  assert.ok(Math.abs(predictedReferenceMs(inputs) - 345.7) < 0.2, "about 345 ms on the reference machine");
  assert.equal(HARDWARE_FACTOR, 2, "F is the maintainers' 2.0 until they decide otherwise (ADR 0027)");
  assert.ok(Math.abs(requiredCpuMs(inputs) - 864.3) < 0.5, "about 860 ms with F = 2.0 and S = 1.25");
  assert.ok(Math.abs(requiredCpuMs(inputs) - 1.25 * HARDWARE_FACTOR * predictedReferenceMs(inputs)) < 1e-9);
  // The reference wrapper rounds that up; it does not sit far above (a limit far above the need
  // only widens the window in which a stuck request burns CPU).
  assert.ok(config.limits.cpu_ms >= requiredCpuMs(inputs));
  assert.ok(config.limits.cpu_ms <= 2 * requiredCpuMs(inputs), "cpu_ms is rounded up from the formula, not arbitrary");
});

test("the check fails for limits the formula says need more CPU than configured", () => {
  // The previous reference value fails: this is the check #56 asked for.
  assert.equal(checkCpuBudget(50, RUNTIME_LIMITS).ok, false);
  // A larger result bound raises B: the same cpu_ms stops being enough.
  const larger = { ...RUNTIME_LIMITS, maxResultBytes: 400_000 };
  const base = checkCpuBudget(config.limits.cpu_ms, RUNTIME_LIMITS);
  const raised = checkCpuBudget(config.limits.cpu_ms, larger);
  assert.ok(raised.needed > base.needed, "B grows with maxResultBytes");
  // A slower platform (larger F) raises the need proportionally.
  assert.ok(Math.abs(checkCpuBudget(1, RUNTIME_LIMITS, { f: 4 }).needed - 2 * checkCpuBudget(1, RUNTIME_LIMITS, { f: 2 }).needed) < 1e-6);
});

test("the library accepts limits whatever they cost in CPU", () => {
  // ADR 0027: CPU is deployment knowledge, so construction never refuses on it. Limits far above
  // anything the reference wrapper could run in 1,000 ms still construct.
  const heavy = { maxRows: 1_000_000, maxResultBytes: 500_000_000, timeoutMs: 60_000, maxStatements: 1_000 };
  const runtime = PolicySqlRuntime.newWithPhysicalSchema(
    example("catalog.yaml"), example("policy.yaml"), "schema_cpu_2", "policy_cpu_2",
    runtimeLimitsJson(heavy), example("physical-schema.json"),
  );
  try { assert.equal(runtimeLimits(runtime).maxResultBytes, 500_000_000); } finally { runtime.free(); }
});
