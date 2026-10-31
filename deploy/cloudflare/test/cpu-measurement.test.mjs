// Unit tests for the CPU measurement tooling (ADR 0027 pull request 1, #56): the model and fit
// logic, the report table, the request shapes, the Workers observability reader, and the release
// smoke's CPU step with a faked platform. Nothing here calls the network or measures time.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COEFFICIENTS, MIB, fitScenario, formatFitTable, inputsAtLimits, observedFactor, predictedReferenceMs,
  requiredCpuMs, resultBoundBytes, summarizeFactor, summarizeFit,
} from "../scripts/lib/cpu-model.mjs";
import { REQUEST_SHAPES, SMOKE_SHAPES, countJsonValues } from "../scripts/lib/cpu-shapes.mjs";
import { parseJsonc } from "../scripts/lib/jsonc.mjs";
import { invocationsOf, pollProbeCpu, queryInvocationEvents, rayIdOf, summarizeProbe } from "../scripts/lib/workers-cpu.mjs";
import { cpuSmoke, referenceScenarioId } from "../scripts/smoke-cpu.mjs";

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

// ---------------------------------------------------------------------------------------------
// The model

test("the formula reproduces the ADR 0027 worked examples", () => {
  // Defaults: R = 1, B = 1.13 MiB, V = 65,536 each: about 345 ms, about 860 ms with F = 2, S = 1.25.
  const limits = { maxResultBytes: 64_000, maxStatements: 8, maxRequestBytes: MIB, maxJsonValues: 65_536 };
  assert.equal(resultBoundBytes(limits), 1_183_744, "the lookup bound is the larger of the two");
  const inputs = inputsAtLimits(limits);
  near(predictedReferenceMs(inputs), 345.7, 0.1);
  near(requiredCpuMs(inputs), 864.3, 0.3);
  // 1 MB of 17-digit decimals: 5 + 80 x 1 + 1.3 us x 56,121 = 158 ms (the ADR rounds R to 1 MiB).
  near(predictedReferenceMs({ rMiB: 1, vReq: 56_121 }), 157.96, 0.01);
  // The 1 MB string: 85 ms.
  near(predictedReferenceMs({ rMiB: 1, vReq: 0 }), 85);
  // Hard maxima: R = 2, B = 2.03, V = 131,072 each: about 668 ms.
  near(predictedReferenceMs({ rMiB: 2, bMiB: 2.03, vReq: 131_072, vRes: 131_072 }), 668.4, 0.5);
});

test("B is the lookup bound until maxResultBytes makes the text bound larger", () => {
  assert.equal(resultBoundBytes({ maxResultBytes: 64_000, maxStatements: 8 }), 1_183_744);
  assert.equal(resultBoundBytes({ maxResultBytes: 400_000, maxStatements: 8 }), 2 * 400_000 + 512 * 8 + MIB);
});

test("inputs read maxRequestBytes and maxJsonValues from the limits the runtime reports", () => {
  const base = { maxResultBytes: 64_000, maxStatements: 8, maxRequestBytes: MIB, maxJsonValues: 65_536 };
  assert.deepEqual(inputsAtLimits(base), { rMiB: 1, bMiB: 1_183_744 / MIB, vReq: 65_536, vRes: 65_536 });
  const configured = inputsAtLimits({ ...base, maxRequestBytes: 2 * MIB, maxJsonValues: 1_000 });
  assert.equal(configured.rMiB, 2);
  assert.equal(configured.vReq, 1_000);
  assert.equal(configured.vRes, 1_000);
});

test("requiredCpuMs scales with S and F and uses the coefficients it is given", () => {
  const inputs = { rMiB: 1, bMiB: 1, vReq: 1_000, vRes: 1_000 };
  const base = requiredCpuMs(inputs, { f: 1, s: 1 });
  near(requiredCpuMs(inputs, { f: 2, s: 1.25 }), 2.5 * base);
  near(requiredCpuMs(inputs, { f: 1, s: 1, coefficients: { c0Ms: 0, bMsPerMiB: 10, vUsPerValue: 0 } }), 20);
});

// ---------------------------------------------------------------------------------------------
// The fit

test("fitScenario flags a measurement above S times the prediction, and only then", () => {
  const inputs = { rMiB: 1, bMiB: 0, vReq: 0, vRes: 0 }; // 85 ms
  const at = (measuredMs) => fitScenario({ name: "s", group: "g", measuredMs, inputs });
  near(at(42.5).measuredOverPredicted, 0.5);
  assert.equal(at(85).exceedsModel, false);
  assert.equal(at(1.25 * 85).exceedsModel, false, "exactly 1.25x is still inside the margin");
  assert.equal(at(1.25 * 85 + 0.01).exceedsModel, true);
  assert.equal(at(200).predictedMs, 85);
});

test("fitScenario takes custom coefficients and safety margin", () => {
  const row = fitScenario({ name: "s", group: "g", measuredMs: 30, inputs: { rMiB: 1 } }, { s: 1, coefficients: { c0Ms: 0, bMsPerMiB: 20, vUsPerValue: 0 } });
  assert.equal(row.predictedMs, 20);
  assert.equal(row.exceedsModel, true);
});

test("summarizeFit counts exceeding scenarios and names the worst ratio", () => {
  const rows = [
    fitScenario({ name: "a", group: "g", measuredMs: 10, inputs: { rMiB: 1 } }),
    fitScenario({ name: "b", group: "g", measuredMs: 200, inputs: { rMiB: 1 } }),
    fitScenario({ name: "c", group: "g", measuredMs: 90, inputs: { rMiB: 1 } }),
  ];
  const summary = summarizeFit(rows);
  assert.equal(summary.scenarios, 3);
  assert.deepEqual(summary.exceedingModel, ["b"]);
  assert.equal(summary.modelHolds, false);
  assert.equal(summary.worst.name, "b");
  assert.equal(summarizeFit(rows.slice(0, 1)).modelHolds, true);
  assert.deepEqual(summarizeFit([]), { scenarios: 0, exceedingModel: [], worst: null, modelHolds: true });
});

test("the fit table has one aligned line per scenario and marks the ones above the model", () => {
  const rows = [
    fitScenario({ name: "within", group: "g", measuredMs: 10, inputs: { rMiB: 1, vReq: 100 } }),
    fitScenario({ name: "over the model", group: "g", measuredMs: 500, inputs: { rMiB: 1, vReq: 100 } }),
  ];
  const lines = formatFitTable(rows).split("\n");
  assert.equal(lines.length, 4, "header, rule, two rows");
  assert.match(lines[0], /scenario +R MiB +B MiB +V req +V res +measured ms +model ms +meas\/model +flag/u);
  assert.match(lines[2], /^within +1\.000 +0\.000 +100 +0 +10\.0 +85\.1 +0\.12 +ok/u);
  assert.match(lines[3], /^over the model .*EXCEEDS 1\.25x$/u);
  assert.equal(new Set(lines.map((line) => line.length)).size <= 2, true, "fixed-width columns");
});

// ---------------------------------------------------------------------------------------------
// Observed F

test("observedFactor divides Workers CPU by the reference time, and ignores references too short for whole-ms CPU", () => {
  assert.equal(observedFactor({ workersCpuMs: 440, referenceMs: 220 }), 2);
  assert.equal(observedFactor({ workersCpuMs: 5, referenceMs: 2.5 }), null);
  assert.equal(observedFactor({ workersCpuMs: Number.NaN, referenceMs: 100 }), null);
  assert.equal(observedFactor({ workersCpuMs: 10, referenceMs: 10 }, { minReferenceMs: 5 }), 1);
});

test("summarizeFactor reports the maximum the formula must cover, the median, and the sample count", () => {
  assert.equal(summarizeFactor([null, undefined]), null);
  assert.deepEqual(summarizeFactor([null, 1.5, 3, 2]), { max: 3, median: 2, min: 1.5, samples: 3 });
  assert.deepEqual(summarizeFactor([1, 2]), { max: 2, median: 1.5, min: 1, samples: 2 });
});

// ---------------------------------------------------------------------------------------------
// Shapes

test("request shapes fill about the target and count values the way the ADR does", () => {
  for (const [name, make] of Object.entries(REQUEST_SHAPES)) {
    const value = make(100_000);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    // Dense shapes stop at the value budget before they reach the byte target.
    const dense = ["nested arrays (depth 56)", "one object, unique keys", 'short strings "s1"', "short decimals 37.4", "small integers"].includes(name);
    assert.ok(bytes > (dense ? 40_000 : 95_000) && bytes <= 100_000, `${name}: ${bytes} bytes`);
  }
  assert.equal(countJsonValues(1), 1);
  assert.equal(countJsonValues([1, [2]]), 4, "array, 1, array, 2");
  assert.equal(countJsonValues({ a: 1, b: [2] }), 6, "object, member names a and b, 1, array, 2");
  // 1 MB of nested arrays is the densest shape (ADR: 499,913 values), which the value limit now
  // refuses: the shape stops at the reference wrapper's maxJsonValues (65,536), 64 values short.
  const nested = countJsonValues(REQUEST_SHAPES["nested arrays (depth 56)"](1_000_000));
  assert.ok(nested > 60_000 && nested <= 65_536 - 64, `${nested}`);
  assert.equal(countJsonValues(REQUEST_SHAPES["nested arrays (depth 56)"](1_000_000, 131_008)) > 130_000, true);
  assert.ok(countJsonValues(REQUEST_SHAPES["one object, unique keys"](1_000_000)) <= 65_536 - 64);
  assert.ok(countJsonValues(REQUEST_SHAPES["one long ASCII string"](1_000_000)) <= 3);
  for (const shape of SMOKE_SHAPES) assert.ok(Object.hasOwn(REQUEST_SHAPES, shape), shape);
});

test("parseJsonc reads wrangler.jsonc: comments outside strings only, trailing commas", () => {
  const text = '{\n // line\n "url": "https://a.example/x//y", /* block */ "n": 1,\n "list": [1, 2,],\n}\n';
  assert.deepEqual(parseJsonc(text), { url: "https://a.example/x//y", n: 1, list: [1, 2] });
  const wrangler = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.ok(Number.isInteger(wrangler.limits.cpu_ms));
});

// ---------------------------------------------------------------------------------------------
// Workers observability

const workerEvent = ({ ray, cpu, wall = 50, outcome = "ok" }) => ({
  $workers: { executionModel: "stateless", eventType: "fetch", outcome, cpuTimeMs: cpu, wallTimeMs: wall, event: { request: { headers: { "cf-ray": ray } }, response: { status: 200 } } },
});
const ownerEvent = ({ id, cpu, wall = 40, outcome = "ok" }) => ({
  $workers: { executionModel: "durableObject", eventType: "fetch", outcome, cpuTimeMs: cpu, wallTimeMs: wall, event: { request: { headers: { "x-policysql-request-id": id } } } },
});

test("rayIdOf drops the colo suffix", () => {
  assert.equal(rayIdOf("a52ec567785812bb-NRT"), "a52ec567785812bb");
  assert.equal(rayIdOf(null), null);
});

test("invocationsOf matches the Worker by cf-ray and the Durable Object by request id, and nothing else", () => {
  const events = [
    workerEvent({ ray: "r1", cpu: 20 }), workerEvent({ ray: "r2", cpu: 99 }),
    ownerEvent({ id: "q1", cpu: 180 }), ownerEvent({ id: "q2", cpu: 99 }),
  ];
  const found = invocationsOf(events, { rayId: "r1", requestId: "q1" });
  assert.equal(found.worker.cpuTimeMs, 20);
  assert.deepEqual(found.owners.map((entry) => entry.cpuTimeMs), [180]);
  assert.deepEqual(invocationsOf(events, { rayId: "nope", requestId: null }), { worker: null, owners: [] });
});

test("summarizeProbe sums every invocation and is complete only with the Worker and the owner", () => {
  const probe = { name: "p", usesOwner: true };
  const half = summarizeProbe(probe, { worker: { cpuTimeMs: 20, wallTimeMs: 60, outcome: "ok" }, owners: [] });
  assert.equal(half.complete, false);
  assert.equal(half.cpuMs, null);
  const full = summarizeProbe(probe, { worker: { cpuTimeMs: 20, wallTimeMs: 60, outcome: "ok" }, owners: [{ cpuTimeMs: 180, outcome: "ok" }, { cpuTimeMs: 2, outcome: "ok" }] });
  assert.equal(full.complete, true);
  assert.equal(full.cpuMs, 202);
  assert.equal(full.workerCpuMs, 20);
  assert.equal(full.ownerCpuMs, 182);
  assert.deepEqual(full.outcomes, ["ok"]);
  assert.equal(summarizeProbe({ name: "p", usesOwner: false }, { worker: { cpuTimeMs: 3, outcome: "ok" }, owners: [] }).complete, true);
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiBody = (events) => ({ success: true, result: { events: { events } } });

test("queryInvocationEvents asks for invocation events of one service and never leaks the token in an error", async () => {
  let seen;
  const events = await queryInvocationEvents({
    accountId: "acc", token: "secret-token", service: "svc", from: 1, to: 2,
    fetchImpl: async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return jsonResponse(apiBody([workerEvent({ ray: "r", cpu: 1 })])); },
  });
  assert.equal(events.length, 1);
  assert.equal(seen.url, "https://api.cloudflare.com/client/v4/accounts/acc/workers/observability/telemetry/query");
  assert.equal(seen.body.view, "events");
  assert.deepEqual(seen.body.timeframe, { from: 1, to: 2 });
  assert.ok(seen.body.parameters.filters.some((filter) => filter.key === "$metadata.service" && filter.value === "svc"));
  await assert.rejects(
    queryInvocationEvents({ accountId: "acc", token: "secret-token", service: "svc", from: 1, to: 2, fetchImpl: async () => jsonResponse({ success: false, errors: [{ message: "secret-token" }] }, 403) }),
    (error) => error.message === "Workers observability query failed (HTTP 403)" && !error.message.includes("secret-token"),
  );
});

const fakeClock = () => {
  let time = 1_000_000;
  return { now: () => time, wait: async (ms) => { time += ms; } };
};

test("pollProbeCpu polls until the events are ingested", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await pollProbeCpu({
    accountId: "a", token: "t", service: "s", since: clock.now(), ...clock, intervalMs: 5_000, timeoutMs: 60_000,
    probes: [{ name: "p", rayId: "r1", requestId: "q1", usesOwner: true }],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(apiBody([]));
      if (calls === 2) return jsonResponse(apiBody([workerEvent({ ray: "r1", cpu: 12 })]));
      return jsonResponse(apiBody([workerEvent({ ray: "r1", cpu: 12 }), ownerEvent({ id: "q1", cpu: 190 })]));
    },
  });
  assert.equal(result.status, "read");
  assert.equal(result.polls, 3);
  assert.equal(result.probes[0].cpuMs, 202);
  assert.equal(result.elapsedMs, 10_000);
});

test("pollProbeCpu gives up at its deadline and reports unavailable or partial, never throwing", async () => {
  const clock = fakeClock();
  const probes = [{ name: "a", rayId: "r1", requestId: "q1", usesOwner: true }, { name: "b", rayId: "r2", requestId: "q2", usesOwner: true }];
  const never = await pollProbeCpu({ accountId: "a", token: "t", service: "s", since: clock.now(), ...clock, intervalMs: 10_000, timeoutMs: 30_000, probes, fetchImpl: async () => jsonResponse(apiBody([])) });
  assert.equal(never.status, "unavailable");
  assert.match(never.reason, /not ingested/u);
  assert.equal(never.polls, 4);
  const one = await pollProbeCpu({
    accountId: "a", token: "t", service: "s", since: clock.now(), ...clock, intervalMs: 10_000, timeoutMs: 20_000, probes,
    fetchImpl: async () => jsonResponse(apiBody([workerEvent({ ray: "r1", cpu: 5 }), ownerEvent({ id: "q1", cpu: 5 })])),
  });
  assert.equal(one.status, "partial");
  assert.equal(one.probes[0].complete, true);
  assert.equal(one.probes[1].complete, false);
  const refused = await pollProbeCpu({ accountId: "a", token: "t", service: "s", since: clock.now(), ...clock, intervalMs: 10_000, timeoutMs: 10_000, probes, fetchImpl: async () => jsonResponse({ success: false }, 403) });
  assert.equal(refused.status, "unavailable");
  assert.equal(refused.reason, "Workers observability query failed (HTTP 403)");
  // A refusal (401, 403) will not change by waiting: one poll, no wait.
  let waits = 0;
  const forbidden = await pollProbeCpu({ accountId: "a", token: "t", service: "s", since: clock.now(), now: clock.now, wait: async () => { waits += 1; }, intervalMs: 10_000, timeoutMs: 600_000, probes, fetchImpl: async () => jsonResponse({ success: false }, 401) });
  assert.equal(forbidden.polls, 1);
  assert.equal(waits, 0);
  assert.equal(forbidden.status, "unavailable");
  // A server error is worth another poll.
  let attempts = 0;
  const flaky = await pollProbeCpu({ accountId: "a", token: "t", service: "s", since: clock.now(), ...clock, intervalMs: 10_000, timeoutMs: 600_000, probes: [probes[0]], fetchImpl: async () => { attempts += 1; return attempts < 3 ? jsonResponse({ success: false }, 503) : jsonResponse(apiBody([workerEvent({ ray: "r1", cpu: 5 }), ownerEvent({ id: "q1", cpu: 5 })])); } });
  assert.equal(flaky.status, "read");
  assert.equal(flaky.polls, 3);
  const failing = await pollProbeCpu({ accountId: "a", token: "t", service: "s", since: clock.now(), ...clock, intervalMs: 10_000, timeoutMs: 10_000, probes, fetchImpl: async () => { throw new Error("network down"); } });
  assert.equal(failing.status, "unavailable");
});

// ---------------------------------------------------------------------------------------------
// The release smoke's CPU step, against a faked deployment

const LIMITS = { maxResultBytes: 64_000, maxStatements: 8, maxRequestBytes: MIB, maxJsonValues: 65_536 };

/** A `call` that answers every execute with 200 and a distinct ray and request id. */
const fakeDeployment = ({ status = () => 200 } = {}) => {
  let count = 0;
  const bodies = [];
  const call = async (_url, init) => {
    count += 1;
    bodies.push(JSON.parse(init.body));
    const code = status(count);
    return new Response(JSON.stringify(code === 200 ? { meta: { requestId: `q${count}` }, results: [] } : { error: { code: "X", requestId: `q${count}` } }), {
      status: code, headers: { "cf-ray": `ray${count}-NRT`, "content-type": "application/json" },
    });
  };
  return { call, bodies, get count() { return count; } };
};
const context = (call) => ({ call, baseUrl: "https://w.test", headers: {}, expected: { schemaVersion: "s", policyVersion: "p" } });
// Node reference per shape: warm (after a warm-up) and cold (the first request of a fresh process).
const nodeReferenceMs = {
  "nested arrays (depth 56)": { warmMs: 200, coldMs: 300 },
  "short decimals 37.4": { warmMs: 100, coldMs: 150 },
  "one long ASCII string": { warmMs: 20, coldMs: 40 },
};
/** Observability that has the Worker (ray N) and owner (request q N) event of the first four requests. */
const ingested = (cpu) => async () => jsonResponse(apiBody([1, 2, 3, 4].flatMap((n) => [
  workerEvent({ ray: `ray${n}`, cpu: cpu[n - 1][0], outcome: cpu[n - 1][2] ?? "ok" }), ownerEvent({ id: `q${n}`, cpu: cpu[n - 1][1] }),
])));
const quick = (fetchImpl) => ({ timeoutMs: 20_000, intervalMs: 10_000, fetchImpl, ...fakeClock() });

test("the CPU step records each request's CPU and F, and reports the deployed limit and the formula", async () => {
  const deployment = fakeDeployment();
  const { failures, report } = await cpuSmoke(context(deployment.call), {
    cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [],
    observability: { accountId: "a", token: "t", service: "s" },
    poll: quick(ingested([[2, 3], [30, 380], [20, 180], [3, 17]])),
  });
  assert.deepEqual(failures, []);
  assert.equal(report.cpuLimitMs, 1_000);
  assert.equal(report.observability.status, "read");
  assert.equal(deployment.count, 8, "four probes and four deletes");
  assert.deepEqual(report.requests.map((entry) => entry.name), ["small insert", ...Object.keys(nodeReferenceMs)]);
  assert.deepEqual(report.requests.map((entry) => entry.cpuMs), [5, 410, 200, 20]);
  const factors = report.requests.map((entry) => entry.factor);
  assert.equal(factors[0], null, "the small request has no reference");
  // First requests are compared with Node's cold time: 410/300, 200/150, 20/40.
  assert.deepEqual(factors.slice(1).map((factor) => Number(factor.toFixed(3))), [1.367, 1.333, 0.5]);
  assert.deepEqual(report.requests.map((entry) => entry.referenceKind), [null, "cold", "cold", "cold"]);
  // The long string's warm reference (20 ms) is under the floor: reported apart, not in F.
  assert.deepEqual(report.requests.map((entry) => entry.belowFloor), [false, false, false, true]);
  assert.equal(report.observedF.samples, 2);
  assert.ok(Math.abs(report.observedF.max - 410 / 300) < 1e-9);
  assert.deepEqual(report.belowFloor.map((entry) => entry.name), ["one long ASCII string"]);
  assert.equal(report.nodeReference.floorMs, 50);
  assert.equal(report.nodeReference.shapes["short decimals 37.4"].coldMs, 150);
  assert.ok(Math.abs(report.formula.requiredCpuMsAtLimits - 864.3) < 0.5);
  assert.ok(report.requests.every((entry) => entry.bodyBytes > 0 && entry.httpStatus === 200));
  // The large probes are about 1 MB of JSON in `doc`, the request the ADR is about.
  // The densest shape stops at the value limit (65,536 less the envelope), not at 1 MB.
  assert.ok(report.requests[1].bodyBytes > 100_000 && report.requests[1].bodyBytes < MIB);
  assert.ok(report.requests[1].jsonValues > 60_000 && report.requests[1].jsonValues <= 65_536);
  assert.equal(deployment.bodies[0].statements[0].params.doc.label, "small");
});

test("each large shape is sampled repeatedly and F covers every sample", async () => {
  const deployment = fakeDeployment();
  // Requests 1 (small), then 3 x 3 large ones: rays ray1 .. ray10. CPU per large sample varies.
  const cpu = [7, 400, 410, 630, 170, 180, 150, 45, 50, 55];
  const events = async () => jsonResponse(apiBody(cpu.map((value, index) => workerEvent({ ray: `ray${index + 1}`, cpu: value }))));
  const { failures, report } = await cpuSmoke(context(deployment.call), {
    cpuLimitMs: 1_000, limits: LIMITS, nodeReferenceMs, commitCheckTables: [], observability: { accountId: "a", token: "t", service: "s" }, poll: quick(events),
  });
  assert.deepEqual(failures, []);
  assert.equal(deployment.count, 20, "ten probes and ten deletes");
  assert.deepEqual(report.requests.map((entry) => [entry.name, entry.sample]), [
    ["small insert", 1],
    ...["nested arrays (depth 56)", "short decimals 37.4", "one long ASCII string"].flatMap((name) => [1, 2, 3].map((sample) => [name, sample])),
  ]);
  assert.deepEqual(report.requests.map((entry) => entry.cpuMs), cpu);
  // First samples are Workers CPU over Node's cold time, later ones over its warm time; the long
  // string (warm reference under the 50 ms floor) is reported apart: 6 of the 9 samples count.
  assert.equal(report.observedF.samples, 6);
  assert.ok(Math.abs(report.observedF.max - 3.15) < 1e-9, "630 / 200");
  assert.ok(Math.abs(report.observedF.min - 170 / 150) < 1e-9);
  assert.equal(report.observedFByOrder.first.samples, 2);
  assert.ok(Math.abs(report.observedFByOrder.first.max - 400 / 300) < 1e-9);
  assert.equal(report.observedFByOrder.later.samples, 4);
  assert.ok(Math.abs(report.observedFByOrder.later.max - 3.15) < 1e-9);
  assert.equal(report.belowFloor.length, 3, "the three long-string samples");
});

test("a request that ran only in the Worker is complete without a Durable Object event", async () => {
  const workerOnly = async () => jsonResponse(apiBody([1, 2, 3, 4].map((n) => workerEvent({ ray: `ray${n}`, cpu: [7, 420, 170, 47][n - 1] }))));
  const { failures, report } = await cpuSmoke(context(fakeDeployment().call), {
    cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [],
    observability: { accountId: "a", token: "t", service: "s" },
    poll: quick(workerOnly),
  });
  assert.deepEqual(failures, []);
  assert.equal(report.observability.status, "read");
  assert.equal(report.observability.polls, 1, "no waiting for an owner event that does not exist");
  assert.deepEqual(report.requests.map((entry) => [entry.workerCpuMs, entry.ownerCpuMs, entry.cpuMs]), [[7, null, 7], [420, null, 420], [170, null, 170], [47, null, 47]]);
  assert.deepEqual(report.requests.slice(1).map((entry) => Number(entry.factor.toFixed(2))), [1.4, 1.13, 1.18]);
});

test("the CPU step fails the release when an invocation ended exceededCpu", async () => {
  const { failures } = await cpuSmoke(context(fakeDeployment().call), {
    cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [],
    observability: { accountId: "a", token: "t", service: "s" },
    poll: quick(ingested([[2, 3], [30, 380], [20, 1_000, "exceededCpu"], [3, 17]])),
  });
  assert.equal(failures[0], 'cpu probe "short decimals 37.4" ended exceededCpu');
  assert.equal(failures.length, 2, "and it is above the cpu_ms / S gate too");
});

test("the CPU step fails the release when one invocation used more than cpu_ms", async () => {
  const { failures } = await cpuSmoke(context(fakeDeployment().call), {
    cpuLimitMs: 300, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [],
    observability: { accountId: "a", token: "t", service: "s" },
    poll: quick(ingested([[2, 3], [30, 380], [20, 180], [3, 17]])),
  });
  assert.deepEqual(failures, ['cpu probe "nested arrays (depth 56)" used 380 ms in one invocation, above cpu_ms / 1.25 = 240 ms (cpu_ms 300)']);
});

test("the gate is cpu_ms / S: 800 ms passes and 801 ms fails at cpu_ms 1,000", async () => {
  const run = async (cpu) => (await cpuSmoke(context(fakeDeployment().call), {
    cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [],
    observability: { accountId: "a", token: "t", service: "s" },
    poll: quick(ingested([[2, 3], [30, cpu], [20, 180], [3, 17]])),
  })).failures;
  assert.deepEqual(await run(800), []);
  assert.equal((await run(801)).length, 1);
});

test("whether the probes use the Durable Object comes from the policy's commit checks", async () => {
  const workerOnly = async () => jsonResponse(apiBody([1, 2, 3, 4].map((n) => workerEvent({ ray: `ray${n}`, cpu: 10 }))));
  const options = (tables) => ({
    cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: tables,
    observability: { accountId: "a", token: "t", service: "s" }, poll: quick(workerOnly),
  });
  assert.equal((await cpuSmoke(context(fakeDeployment().call), options(["smoke_checks"]))).report.observability.status, "read");
  // A check on the probe table would run the insert in the owner: its event is waited for, and missing here.
  assert.equal((await cpuSmoke(context(fakeDeployment().call), options(["smoke_values"]))).report.observability.status, "unavailable");
  await assert.rejects(cpuSmoke(context(fakeDeployment().call), { cpuLimitMs: 1_000, limits: LIMITS, nodeReferenceMs }), TypeError);
});

test("the probe rows are deleted even when a send throws", async () => {
  const sent = [];
  let count = 0;
  const call = async (_url, init) => {
    count += 1;
    sent.push(JSON.parse(init.body).statements[0].sql.split(" ")[0]);
    if (count === 3) throw new Error("network down");
    return new Response(JSON.stringify({ meta: { requestId: `q${count}` } }), { status: 200, headers: { "cf-ray": `ray${count}-NRT` } });
  };
  await assert.rejects(cpuSmoke(context(call), { cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [], observability: null }), /network down/u);
  assert.deepEqual(sent, ["INSERT", "INSERT", "INSERT", "DELETE", "DELETE", "DELETE"], "every id generated so far is deleted");
});

test("the Node reference is measured warm and cold per shape and carries the machine", async () => {
  const { measureNodeReference } = await import("../scripts/lib/node-reference.mjs");
  const calls = [];
  const measure = (id, { cold }) => {
    calls.push([id, cold]);
    return { measuredMs: cold ? 300 : 200, report: { machine: { cpu: "Test CPU", node: "v1" } } };
  };
  const reference = measureNodeReference({ shapes: ["a", "b"], scenarioId: (shape) => `s:${shape}`, target: 1000, measure });
  assert.deepEqual(reference.shapes, { a: { warmMs: 200, coldMs: 300 }, b: { warmMs: 200, coldMs: 300 } });
  assert.equal(reference.info.cpu, "Test CPU");
  assert.equal(reference.info.node, "v1");
  assert.deepEqual(calls, [["s:a", false], ["s:a", true], ["s:b", false], ["s:b", true]]);
});

test("the CPU step fails the release when a request is answered with an error", async () => {
  const deployment = fakeDeployment({ status: (count) => (count === 3 ? 503 : 200) });
  const { failures } = await cpuSmoke(context(deployment.call), {
    cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [], observability: null,
  });
  assert.deepEqual(failures, ['cpu probe "short decimals 37.4" answered 503 X']);
});

test("unreadable observability is reported as unavailable and does not fail the release", async () => {
  const unauthorized = await cpuSmoke(context(fakeDeployment().call), {
    cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [],
    observability: { accountId: "a", token: "t", service: "s" },
    poll: quick(async () => jsonResponse({ success: false }, 403)),
  });
  assert.deepEqual(unauthorized.failures, []);
  assert.equal(unauthorized.report.observability.status, "unavailable");
  assert.equal(unauthorized.report.observability.reason, "Workers observability query failed (HTTP 403)");
  assert.equal(unauthorized.report.observedF, null);
  assert.ok(unauthorized.report.requests.every((entry) => entry.cpuMs === null && entry.factor === null));
  const delayed = await cpuSmoke(context(fakeDeployment().call), {
    cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [],
    observability: { accountId: "a", token: "t", service: "s" },
    poll: quick(async () => jsonResponse(apiBody([]))),
  });
  assert.deepEqual(delayed.failures, []);
  assert.equal(delayed.report.observability.status, "unavailable");
  const missing = await cpuSmoke(context(fakeDeployment().call), { cpuLimitMs: 1_000, limits: LIMITS, repeats: 1, nodeReferenceMs, commitCheckTables: [], observability: null });
  assert.deepEqual(missing.failures, []);
  assert.equal(missing.report.observability.status, "unavailable");
});

test("the reference scenario of every smoke shape exists in the Node measurement", async () => {
  const { scenarios } = await import("../scripts/lib/cpu-bench.mjs");
  const ids = new Set(scenarios({ target: 10_000 }).map((scenario) => scenario.id));
  for (const shape of SMOKE_SHAPES) assert.ok(ids.has(referenceScenarioId(shape)), shape);
  assert.equal(ids.size, scenarios({ target: 10_000 }).length, "scenario ids are unique");
});

// ---------------------------------------------------------------------------------------------
// The measurement script itself, on the cheapest scenario

test("measure-cpu runs a scenario against the real WASM and writes a machine-readable report", () => {
  const directory = mkdtempSync(join(tmpdir(), "policysql-measure-"));
  try {
    const out = join(directory, "report.json");
    const script = new URL("../scripts/measure-cpu.mjs", import.meta.url).pathname;
    const run = spawnSync(process.execPath, [script, "--only", "OR chain", "--runs", "1", "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /sql: OR chain, 32 terms/u);
    assert.match(run.stdout, /Fit: 1 scenarios/u);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.kind, "policysql-cpu-measurement");
    assert.equal(report.scenarios.length, 1);
    const [scenario] = report.scenarios;
    assert.equal(scenario.group, "sql-dense");
    assert.equal(scenario.details.status, 200);
    assert.ok(scenario.measuredMs > 0);
    assert.equal(typeof scenario.fit.exceedsModel, "boolean");
    assert.equal(report.model.coefficients.bMsPerMiB, COEFFICIENTS.bMsPerMiB);
    assert.equal(report.model.atReferenceWrapperLimits.configuredCpuMs, 1_000);
    const json = spawnSync(process.execPath, [script, "--only", "OR chain", "--runs", "1", "--json", "--out", out], { encoding: "utf8" });
    assert.equal(JSON.parse(json.stdout).scenarios[0].id, scenario.id, "--json prints the report and nothing else");
    const bad = spawnSync(process.execPath, [script, "--only", "no such scenario", "--out", out], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
