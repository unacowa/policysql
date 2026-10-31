// Measures the CPU cost of the PolicySQL request path in Node, per scenario, and fits it against
// the ADR 0027 formula (ADR 0027 pull request 1, #56). Uses the real WASM build in `pkg/`
// (`npm run build:wasm` first). See deploy/cloudflare/README.md ("Measuring CPU").
//
//   npm run measure:cpu                       all scenarios, table on stdout, report written
//   npm run measure:cpu -- --only "request:"  scenarios whose id contains the text
//   npm run measure:cpu -- --out report.json --runs 7 --target 1000000
//   npm run measure:cpu -- --scale 0.8        scale measured times to the reference machine
//                                             (this machine is x times as fast as i7-7700K: 1/x)
//   npm run measure:cpu -- --json             report JSON on stdout, nothing else
//   npm run measure:cpu -- --in-process       one process for all scenarios (WASM memory is then
//                                             cumulative; the default runs one process per scenario)
//
// The report's `scenarios[].fit.exceedsModel` is true where the measured time is above 1.25x the
// formula's prediction for that scenario's own R, B and V. Exit status is 0 either way: the report
// is evidence for a maintainer decision, not a gate.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_LIMITS } from "../wrapper/limits.ts";
import {
  COEFFICIENTS, HARDWARE_FACTOR, MIB, SAFETY_MARGIN, fitScenario, formatFitTable, inputsAtLimits, predictedReferenceMs, requiredCpuMs, summarizeFit,
} from "./lib/cpu-model.mjs";
import { parseJsonc } from "./lib/jsonc.mjs";

const here = fileURLToPath(import.meta.url);

const parseArguments = (argv) => {
  const options = { runs: 5, target: 1_000_000, only: null, out: fileURLToPath(new URL("../.deployment/cpu-measurement.json", import.meta.url)), scale: 1, json: false, inProcess: false, child: null };
  const value = (index) => {
    if (index + 1 >= argv.length) throw new Error(`${argv[index]} needs a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--runs": options.runs = Number(value(index)); index += 1; break;
      case "--target": options.target = Number(value(index)); index += 1; break;
      case "--only": options.only = value(index); index += 1; break;
      case "--out": options.out = value(index); index += 1; break;
      case "--scale": options.scale = Number(value(index)); index += 1; break;
      case "--child": options.child = Number(value(index)); index += 1; break;
      case "--json": options.json = true; break;
      case "--in-process": options.inProcess = true; break;
      default: throw new Error(`unknown argument ${argv[index]}`);
    }
  }
  for (const key of ["runs", "target", "scale"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} must be a positive number`);
  }
  return options;
};

const { scenarios: buildScenarios, runScenario } = await import("./lib/cpu-bench.mjs");

const options = parseArguments(process.argv.slice(2));
const all = buildScenarios({ target: options.target });

if (options.child !== null) {
  // Internal: one scenario, one process, one JSON line.
  const result = await runScenario(all[options.child], { runs: options.runs });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

const selected = all.map((scenario, index) => ({ scenario, index })).filter(({ scenario }) => options.only === null || scenario.id.includes(options.only));
if (selected.length === 0) throw new Error(`no scenario matches --only ${JSON.stringify(options.only)}`);

const log = (text) => { if (!options.json) process.stderr.write(`${text}\n`); };
const results = [];
for (const { scenario, index } of selected) {
  log(`measuring ${scenario.id}`);
  if (options.inProcess) {
    results.push(await runScenario(scenario, { runs: options.runs }));
    continue;
  }
  const child = spawnSync(process.execPath, [here, "--child", String(index), "--runs", String(options.runs), "--target", String(options.target)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`scenario ${JSON.stringify(scenario.id)} failed:\n${child.stderr}`);
  results.push(JSON.parse(child.stdout.trim().split("\n").at(-1)));
}

const measured = results.filter((result) => !result.skipped);
const fits = measured.map((result) => ({
  ...fitScenario({ name: result.id, group: result.group, measuredMs: result.measuredMs * options.scale, inputs: result.inputs }),
  rawMeasuredMs: result.measuredMs,
  wasmMemoryMiB: result.wasmMemoryMiB,
  details: result.details,
}));
const summary = summarizeFit(fits);

// ADR 0027 pull request 1: does `a_b` (per MiB of request bytes, SQL text included) cover the
// SQL-dense shapes, or does the formula need its own term for SQL bytes? The per-scenario fit
// answers it shape by shape; this answers it for the formula as used: the cost of the densest
// SQL request, against the reference time the formula allows at the deployment's limits.
const sqlTermFinding = (rows, wrapperInputs) => {
  const dense = rows.filter((row) => row.group === "sql-dense");
  const big = dense.filter((row) => row.details.sqlBytes >= 20_000);
  const perMiB = (row) => (row.measuredMs - COEFFICIENTS.c0Ms) / (row.details.sqlBytes / MIB);
  const worstPerMiB = big.reduce((best, row) => (best === null || perMiB(row) > perMiB(best) ? row : best), null);
  const worstRequest = dense.reduce((best, row) => (best === null || row.measuredMs > best.measuredMs ? row : best), null);
  const referenceAtLimitsMs = predictedReferenceMs(wrapperInputs);
  return {
    aBMsPerMiB: COEFFICIENTS.bMsPerMiB,
    worstMsPerMiBOfSql: worstPerMiB && { scenario: worstPerMiB.name, msPerMiB: perMiB(worstPerMiB), overAb: perMiB(worstPerMiB) / COEFFICIENTS.bMsPerMiB },
    worstSqlRequest: worstRequest && { scenario: worstRequest.name, measuredMs: worstRequest.measuredMs, sqlBytes: worstRequest.details.sqlBytes },
    referenceAtLimitsMs,
    // The formula sums every term at its maximum; one request cannot spend R, B and V at once
    // on SQL, so a SQL-dense request is covered when it costs less than that sum.
    coveredByFormulaAtLimits: worstRequest ? worstRequest.measuredMs <= referenceAtLimitsMs : null,
  };
};

const wrangler = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const wrapperInputs = inputsAtLimits(RUNTIME_LIMITS);
const report = {
  kind: "policysql-cpu-measurement",
  generatedAt: new Date().toISOString(),
  machine: { cpu: cpus()[0]?.model ?? null, node: process.version, scale: options.scale, isolatedProcesses: !options.inProcess },
  method: { runs: options.runs, requestBodyTargetBytes: options.target, statistic: "best of runs after one warm-up, wall ms, simulated Turso and client response parsing excluded" },
  model: {
    formula: "cpu_ms >= S * F * (C0 + a_b * (R + B) + a_v * (V_req + V_res))",
    coefficients: COEFFICIENTS, safetyMargin: SAFETY_MARGIN, hardwareFactorF: HARDWARE_FACTOR,
    atReferenceWrapperLimits: {
      inputs: wrapperInputs,
      referenceMs: predictedReferenceMs(wrapperInputs),
      requiredCpuMs: requiredCpuMs(wrapperInputs),
      configuredCpuMs: wrangler.limits?.cpu_ms ?? null,
    },
  },
  summary,
  sqlTerm: sqlTermFinding(fits, wrapperInputs),
  scenarios: fits.map(({ name, group, inputs, measuredMs, rawMeasuredMs, predictedMs, measuredOverPredicted, exceedsModel, wasmMemoryMiB, details }) => ({
    id: name, group, measuredMs, rawMeasuredMs, details, wasmMemoryMiB, inputs,
    fit: { predictedMs, measuredOverPredicted, exceedsModel },
  })),
  skipped: results.filter((result) => result.skipped).map((result) => ({ id: result.id, reason: result.skipped })),
};

mkdirSync(dirname(options.out), { recursive: true });
writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const order = ["request", "result-json", "result-cells", "sql-dense"];
  for (const group of order) {
    const rows = fits.filter((row) => row.group === group);
    if (rows.length === 0) continue;
    process.stdout.write(`\n[${group}]\n${formatFitTable(rows)}\n`);
  }
  process.stdout.write("\nWASM linear memory after each scenario (own process, so the scenario's high-water mark), MiB:\n");
  for (const row of fits) process.stdout.write(`  ${row.wasmMemoryMiB.toFixed(1).padStart(6)}  ${row.name}\n`);
  if (report.skipped.length > 0) {
    process.stdout.write("\nSkipped:\n");
    for (const entry of report.skipped) process.stdout.write(`  ${entry.id}: ${entry.reason}\n`);
  }
  const limits = report.model.atReferenceWrapperLimits;
  process.stdout.write([
    "",
    `Model: ${report.model.formula}`,
    `  C0 = ${COEFFICIENTS.c0Ms} ms, a_b = ${COEFFICIENTS.bMsPerMiB} ms/MiB, a_v = ${COEFFICIENTS.vUsPerValue} us/value, S = ${SAFETY_MARGIN}, F = ${HARDWARE_FACTOR} (measured by the release smoke, see cpu-model.mjs)`,
    `Fit: ${summary.scenarios} scenarios, ${summary.exceedingModel.length} above ${SAFETY_MARGIN}x the model${summary.exceedingModel.length ? `: ${summary.exceedingModel.join("; ")}` : ""}`,
    ...(summary.worst ? [`  highest measured/model: ${summary.worst.measuredOverPredicted.toFixed(2)} (${summary.worst.name})`] : []),
    ...(report.sqlTerm.worstSqlRequest ? [`SQL bytes: the densest SQL request (${report.sqlTerm.worstSqlRequest.scenario}) costs ${report.sqlTerm.worstSqlRequest.measuredMs.toFixed(1)} ms for ${report.sqlTerm.worstSqlRequest.sqlBytes} SQL bytes; the worst cost per MiB of SQL is ${report.sqlTerm.worstMsPerMiBOfSql?.msPerMiB.toFixed(0)} ms (${report.sqlTerm.worstMsPerMiBOfSql?.scenario}; a_b = ${COEFFICIENTS.bMsPerMiB}); the formula allows ${report.sqlTerm.referenceAtLimitsMs.toFixed(0)} ms at the limits: ${report.sqlTerm.coveredByFormulaAtLimits ? "covered, no separate SQL term needed" : "NOT covered, a separate SQL term is needed"}`] : []),
    `Reference wrapper limits: R ${limits.inputs.rMiB.toFixed(3)} MiB, B ${limits.inputs.bMiB.toFixed(3)} MiB, V ${limits.inputs.vReq}+${limits.inputs.vRes}: ${limits.referenceMs.toFixed(0)} ms on the reference machine, cpu_ms >= ${limits.requiredCpuMs.toFixed(0)}; wrangler.jsonc limits.cpu_ms = ${limits.configuredCpuMs}`,
    `Report: ${options.out}`,
    "",
  ].join("\n"));
}
