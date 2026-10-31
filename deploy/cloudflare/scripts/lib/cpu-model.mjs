// The CPU model of ADR 0027 ("CPU and memory budgets"), as pure functions.
//
//   cpu_ms >= S * F * (C0 + a_b * (R + B) + a_v * (V_req + V_res))
//
// `R` and `B` are in MiB, `V_req` and `V_res` are JSON value counts. The coefficients are in
// reference-machine units (i7-7700K 4.2 GHz, Node, the release WASM); `F` converts them to
// Workers CPU time. Used by scripts/measure-cpu.mjs (fit of the model against measurements),
// by the release smoke (observed F), and by test/cpu-budget.test.mjs (the reference wrapper's
// `cpu_ms` against its limits). The library itself never reads this: it does not refuse a limit
// for CPU reasons (ADR 0027, "The library does not refuse a combination").

export const MIB = 1_048_576;

/** Coefficients on the reference machine, ADR 0027 (worst measured shape per term, current code). */
export const COEFFICIENTS = Object.freeze({
  /** Fixed cost of one request, ms. */
  c0Ms: 5,
  /** Cost per MiB of request bytes and of raw result bytes not attributable to values, ms. */
  bMsPerMiB: 80,
  /** Cost per JSON value (request or raw result), microseconds. */
  vUsPerValue: 1.3,
});

/** `S`: tolerates occasional overruns; sustained ones are terminated by the platform. */
export const SAFETY_MARGIN = 1.25;

/**
 * `F`: Workers CPU time / reference-machine time. The maintainers' value is 2.0 (ADR 0027,
 * "Maintainer decisions" 2); this constant changes by a maintainer decision made from the release
 * smoke's record (acceptance.cpu in release.json). The first measurement (2026-10-31, the dev
 * deployment, 7 runs) found no single value: the same 1 MB request cost 1.2 to 3.2 times its
 * warm Node time for the heavy shapes (nested arrays, short decimals; median about 1.6) and 1.9
 * to 7.7 times for the shortest (22 ms of reference time, where a few ms of per-request platform
 * work such as JWT verification weigh most). The first request of a shape in a fresh deployment
 * is the costly one (JIT and WASM tier-up not yet warm: nested arrays 401 to 631 ms, later
 * samples 248 to 489 ms). That first measurement compared those cold requests with a warm Node
 * time (up to 3.2); the smoke now compares cold to cold and warm to warm, where the ratio is
 * about 1.6 to 1.9, and the maintainers keep 2.0 (ADR 0027, Maintainer decisions 10), to be
 * re-measured after the request-budget (3) and coefficient (7) pull requests.
 */
export const HARDWARE_FACTOR = 2.0;

/** The idempotency lookup bound: `2 * 589,824 + 4,096` (ADR 0027), the floor of `B`. */
export const LOOKUP_BOUND_BYTES = 1_183_744;

/**
 * `maxJsonValues` default (ADR 0027). The runtime does not enforce or report it before the
 * request-budget pull request (ADR 0027 pull request 3), so the model reads this constant.
 */
export const DEFAULT_MAX_JSON_VALUES = 65_536;

/** `maxRequestBytes` today: a fixed protocol constant the runtime advertises (1 MiB). */
export const DEFAULT_MAX_REQUEST_BYTES = MIB;

/**
 * The model's `B`: raw result bytes not attributable to values, in bytes (ADR 0027): the larger
 * of `2 * maxResultBytes + 512 * maxStatements + 1,048,576` and the lookup bound.
 */
export const resultBoundBytes = ({ maxResultBytes, maxStatements }) =>
  Math.max(2 * maxResultBytes + 512 * maxStatements + MIB, LOOKUP_BOUND_BYTES);

/**
 * The model inputs at a deployment's limits. `limits` is the wrapper's `RuntimeLimits` (what the
 * runtime enforces); `maxRequestBytes` and `maxJsonValues` are read from it when the runtime
 * reports them and default to the constants above before then.
 */
export const inputsAtLimits = (limits) => ({
  rMiB: (limits.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES) / MIB,
  bMiB: resultBoundBytes(limits) / MIB,
  vReq: limits.maxJsonValues ?? DEFAULT_MAX_JSON_VALUES,
  vRes: limits.maxJsonValues ?? DEFAULT_MAX_JSON_VALUES,
});

/** Reference-machine CPU, ms, predicted for `{ rMiB, bMiB, vReq, vRes }`. */
export const predictedReferenceMs = ({ rMiB = 0, bMiB = 0, vReq = 0, vRes = 0 }, coefficients = COEFFICIENTS) =>
  coefficients.c0Ms + coefficients.bMsPerMiB * (rMiB + bMiB) + (coefficients.vUsPerValue / 1000) * (vReq + vRes);

/** The smallest `cpu_ms` the formula allows: `S * F * predictedReferenceMs`. */
export const requiredCpuMs = (inputs, { f = HARDWARE_FACTOR, s = SAFETY_MARGIN, coefficients = COEFFICIENTS } = {}) =>
  s * f * predictedReferenceMs(inputs, coefficients);

/**
 * Compares one measurement to the model. `exceedsModel` is true when the measured reference
 * time is above `S` times the prediction: the model then under-predicts this shape and the
 * coefficients (or a term for it) need to change.
 */
export const fitScenario = ({ name, group, measuredMs, inputs, notes }, { s = SAFETY_MARGIN, coefficients = COEFFICIENTS } = {}) => {
  const predictedMs = predictedReferenceMs(inputs, coefficients);
  inputs = { rMiB: 0, bMiB: 0, vReq: 0, vRes: 0, ...inputs };
  return {
    name, group, inputs, measuredMs, predictedMs,
    // < 1: the model is conservative for this shape. 1 / S is the line at which the margin is gone.
    measuredOverPredicted: predictedMs > 0 ? measuredMs / predictedMs : null,
    exceedsModel: measuredMs > s * predictedMs,
    ...(notes ? { notes } : {}),
  };
};

/** Aggregates `fitScenario` rows: how many exceed the model, and the worst measured/predicted ratio. */
export const summarizeFit = (rows) => {
  const exceeding = rows.filter((row) => row.exceedsModel);
  const worst = rows.reduce((best, row) => (best === null || row.measuredOverPredicted > best.measuredOverPredicted ? row : best), null);
  return {
    scenarios: rows.length,
    exceedingModel: exceeding.map((row) => row.name),
    worst: worst && { name: worst.name, measuredOverPredicted: worst.measuredOverPredicted },
    modelHolds: exceeding.length === 0,
  };
};

const pad = (text, width, right) => (right ? String(text).padStart(width) : String(text).padEnd(width));

/** A fixed-width table of fit rows (the human-readable half of the report). */
export const formatFitTable = (rows) => {
  const columns = [
    ["scenario", (row) => row.name, false],
    ["R MiB", (row) => row.inputs.rMiB.toFixed(3), true],
    ["B MiB", (row) => row.inputs.bMiB.toFixed(3), true],
    ["V req", (row) => row.inputs.vReq, true],
    ["V res", (row) => row.inputs.vRes, true],
    ["measured ms", (row) => row.measuredMs.toFixed(1), true],
    ["model ms", (row) => row.predictedMs.toFixed(1), true],
    ["meas/model", (row) => (row.measuredOverPredicted === null ? "-" : row.measuredOverPredicted.toFixed(2)), true],
    ["flag", (row) => (row.exceedsModel ? "EXCEEDS 1.25x" : "ok"), false],
  ];
  const cells = rows.map((row) => columns.map(([, get]) => String(get(row))));
  const widths = columns.map(([title], index) => Math.max(title.length, ...cells.map((line) => line[index].length)));
  const line = (values) => values.map((value, index) => pad(value, widths[index], columns[index][2])).join("  ");
  return [line(columns.map(([title]) => title)), line(widths.map((width) => "-".repeat(width))), ...cells.map(line)].join("\n");
};

/**
 * The observed hardware factor of one request: Workers CPU (every invocation of the request,
 * the Worker and the Durable Object, summed) over the reference-machine time of the same shape.
 * Workers reports whole milliseconds, so a reference time under `minReferenceMs` is too small
 * for the ratio to mean anything and yields `null`.
 */
export const observedFactor = ({ workersCpuMs, referenceMs }, { minReferenceMs = 20 } = {}) =>
  Number.isFinite(workersCpuMs) && Number.isFinite(referenceMs) && referenceMs >= minReferenceMs ? workersCpuMs / referenceMs : null;

/**
 * Below this reference time a shape is not used for `F`: Workers reports whole milliseconds and
 * adds a few ms of per-request platform work (JWT verification, routing) the Node harness does not
 * run, so the ratio of a short request measures that overhead, not `F`. Such requests are
 * reported separately.
 */
export const FACTOR_REFERENCE_FLOOR_MS = 50;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * `F` for the release report from per-request factors (`null` entries are ignored): the maximum
 * is what the formula must cover, the median shows the typical ratio. `null` when none is usable.
 */
export const summarizeFactor = (factors) => {
  const usable = factors.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return null;
  return { max: Math.max(...usable), median: median(usable), min: Math.min(...usable), samples: usable.length };
};
