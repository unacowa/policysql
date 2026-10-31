// Release-smoke step: real CPU time of the worst request shapes on the deployed Worker (ADR 0027
// pull request 1, #56). Like the sections in smoke-sections.mjs it returns `{ failures, report }`
// and never puts a token or a secret in either.
//
// 1. Sends the ADR's worst request shapes (about 1 MB bodies: nested arrays, short decimals, one
//    long string) and one small request, each as an Atomic Execute INSERT into the dev-only
//    `smoke_values.doc` JSON column, then deletes the rows.
// 2. Reads each request's CPU time from Workers observability (scripts/lib/workers-cpu.mjs),
//    polling with a bounded timeout because Workers Logs arrive late. An unreadable result is
//    reported as `unavailable`: it does not fail the release.
// 3. Fails the release when a request answered with anything but 200 (a platform CPU or memory
//    termination answers 1102 and never reaches the wrapper), when an invocation ended
//    `exceededCpu`, or when an invocation's CPU time is above the configured `cpu_ms`.
// 4. Records F = Workers CPU / Node reference time, per shape, from `nodeReferenceMs` (the same
//    shape through the Node harness, scripts/lib/cpu-bench.mjs).
import { randomBytes } from "node:crypto";
import { HARDWARE_FACTOR, inputsAtLimits, observedFactor, predictedReferenceMs, requiredCpuMs, summarizeFactor } from "./lib/cpu-model.mjs";
import { REQUEST_SHAPES, SMOKE_SHAPES, countJsonValues } from "./lib/cpu-shapes.mjs";
import { pollProbeCpu, rayIdOf } from "./lib/workers-cpu.mjs";

const INSERT_SQL = "INSERT INTO smoke_values (id, label, doc) VALUES (:id, :label, :doc) RETURNING id";
const DELETE_SQL = "DELETE FROM smoke_values WHERE id = :id RETURNING id";
/** The body size the Node measurement uses for its request shapes (cpu-bench.mjs `target`). */
export const SHAPE_TARGET_BYTES = 1_000_000;

/** The Node scenario whose time is the reference for a smoke shape. */
export const referenceScenarioId = (shape) => `request: ${shape} | atomic keyed`;

const unique = () => `cpu_${randomBytes(6).toString("hex")}`;

/**
 * `context`: `{ call, baseUrl, headers, expected }` as for the other sections.
 * `options`: `{ cpuLimitMs, limits, observability: { accountId, token, service } | null,
 *   nodeReferenceMs: { [shape]: ms }, repeats?, poll?: { timeoutMs, intervalMs, fetchImpl, now, wait } }`.
 * Each large shape is sent `repeats` times (default 3): Workers CPU time of the same request varies
 * between runs and within one (shared hardware), so one sample is not an F.
 */
export const cpuSmoke = async ({ call, baseUrl, headers, expected }, { cpuLimitMs, limits, observability, nodeReferenceMs, poll = {}, repeats = 3 }) => {
  const failures = [];
  const expect = (condition, name) => { if (!condition) failures.push(name); };
  const post = async (statements, key) => {
    const body = JSON.stringify({ expected, statements });
    const started = Date.now();
    const response = await call(`${baseUrl}/v1/transactions:execute`, {
      method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": key }, body,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return {
      status: response.status, bodyBytes: Buffer.byteLength(body), elapsedMs: Date.now() - started, parsed,
      rayId: rayIdOf(response.headers.get("cf-ray")), requestId: parsed?.meta?.requestId ?? parsed?.error?.requestId ?? null,
    };
  };

  const requests = [
    { name: "small insert", doc: { label: "small" }, shape: null },
    ...SMOKE_SHAPES.map((shape) => ({ name: shape, doc: REQUEST_SHAPES[shape](SHAPE_TARGET_BYTES), shape })),
  ];
  const sentAt = Date.now();
  const sent = [];
  const ids = [];
  for (const request of requests) {
    for (let sample = 1; sample <= (request.shape === null ? 1 : repeats); sample += 1) {
      const id = unique();
      ids.push(id);
      const outcome = await post([{ sql: INSERT_SQL, params: { id, label: request.name.slice(0, 40), doc: request.doc }, expect: { affectedRows: 1 } }], `cpu-${id}`);
      sent.push({ request, sample, outcome });
      expect(outcome.status === 200, `cpu probe "${request.name}" answered ${outcome.status}${outcome.parsed?.error?.code ? ` ${outcome.parsed.error.code}` : ""}`);
    }
  }
  // Cleanup of the rows the probes wrote (the table is also emptied on every release).
  for (const id of ids) {
    const outcome = await post([{ sql: DELETE_SQL, params: { id } }], `cpu-del-${id}`);
    expect(outcome.status === 200, "cpu probe row deleted");
  }

  let observation = { status: "unavailable", reason: "Workers observability credentials missing", probes: [], polls: 0, elapsedMs: 0 };
  if (observability) {
    observation = await pollProbeCpu({
      ...observability, since: sentAt, timeoutMs: 120_000, intervalMs: 5_000, ...poll,
      // An Atomic Execute that triggers no commit check runs in the Worker invocation itself (no
      // Durable Object; observed in the real environment: a 1 MB probe's whole CPU is the Worker's
      // event). A Durable Object event with the request's id, if one exists, is added to the sum.
      probes: sent.map(({ request, outcome }) => ({ name: request.name, rayId: outcome.rayId, requestId: outcome.requestId, usesOwner: false })),
    });
  }

  const report = sent.map(({ request, sample, outcome }, index) => {
    const observed = observation.probes[index] ?? null;
    const referenceMs = request.shape === null ? null : (nodeReferenceMs?.[request.shape] ?? null);
    const cpuMs = observed?.cpuMs ?? null;
    return {
      name: request.name, sample, httpStatus: outcome.status, bodyBytes: outcome.bodyBytes, jsonValues: countJsonValues(request.doc), elapsedMs: outcome.elapsedMs,
      workerCpuMs: observed?.workerCpuMs ?? null, ownerCpuMs: observed?.ownerCpuMs ?? null, cpuMs,
      wallMs: observed?.wallMs ?? null, outcomes: observed?.outcomes ?? [],
      nodeReferenceMs: referenceMs, factor: cpuMs === null ? null : observedFactor({ workersCpuMs: cpuMs, referenceMs }),
    };
  });

  // Fatal: a platform CPU termination, or an invocation over the configured limit.
  for (const observed of observation.probes) {
    expect(!observed.outcomes.includes("exceededCpu"), `cpu probe "${observed.name}" ended exceededCpu`);
    for (const entry of observed.invocations) {
      expect(!(entry.cpuTimeMs > cpuLimitMs), `cpu probe "${observed.name}" used ${entry.cpuTimeMs} ms in one invocation, above cpu_ms ${cpuLimitMs}`);
    }
  }

  const wrapperInputs = inputsAtLimits(limits);
  return {
    failures,
    report: {
      cpuLimitMs,
      formula: {
        hardwareFactorF: HARDWARE_FACTOR,
        referenceMsAtLimits: predictedReferenceMs(wrapperInputs),
        requiredCpuMsAtLimits: requiredCpuMs(wrapperInputs),
      },
      observability: { status: observation.status, ...(observation.reason ? { reason: observation.reason } : {}), polls: observation.polls, elapsedMs: observation.elapsedMs },
      requests: report,
      // F from the requests whose reference time is long enough for a whole-millisecond CPU time to mean something.
      observedF: summarizeFactor(report.map((entry) => entry.factor)),
      // The first sample of a shape in a fresh deployment runs before the isolate's JIT and the WASM
      // tier-up have warmed (the Node reference is measured after a warm-up); later samples show the
      // warm cost. A limit must cover the first.
      observedFByOrder: {
        first: summarizeFactor(report.filter((entry) => entry.sample === 1).map((entry) => entry.factor)),
        later: summarizeFactor(report.filter((entry) => entry.sample > 1).map((entry) => entry.factor)),
      },
    },
  };
};
