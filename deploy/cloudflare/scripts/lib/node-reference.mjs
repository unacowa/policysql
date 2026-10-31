// The Node reference times of the smoke's request shapes (ADR 0027 pull request 1): each shape
// through the harness (scripts/measure-cpu.mjs) in a fresh process, twice: warm (best of five
// after a warm-up) and cold (the first request of a fresh process, no warm-up). The release smoke
// compares a deployment's first request with the cold time and later ones with the warm time.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../measure-cpu.mjs", import.meta.url));

/** Runs `measure-cpu.mjs --json` for one scenario id; returns its report. `run` is injectable for tests. */
export const measureScenario = (id, { cold, target, run = spawnSync } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "policysql-reference-"));
  try {
    const child = run(process.execPath, [script, "--only", id, "--json", "--runs", "5", "--target", String(target), "--out", join(directory, "report.json"), ...(cold ? ["--cold"] : [])], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`Node reference for ${JSON.stringify(id)} failed`);
    const report = JSON.parse(child.stdout);
    const scenario = report.scenarios.find((entry) => entry.id === id);
    if (!scenario) throw new Error(`Node reference for ${JSON.stringify(id)} produced no result`);
    return { report, measuredMs: scenario.rawMeasuredMs };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/**
 * `{ shapes: { [shape]: { warmMs, coldMs } }, info: { cpu, node, method } }` for `shapes`;
 * `scenarioId(shape)` names the scenario of a shape.
 */
export const measureNodeReference = ({ shapes, scenarioId, target, measure = measureScenario }) => {
  const result = {};
  let machine = null;
  for (const shape of shapes) {
    const warm = measure(scenarioId(shape), { cold: false, target });
    const cold = measure(scenarioId(shape), { cold: true, target });
    result[shape] = { warmMs: warm.measuredMs, coldMs: cold.measuredMs };
    machine ??= warm.report.machine;
  }
  return {
    shapes: result,
    info: {
      cpu: machine?.cpu ?? null, node: machine?.node ?? null,
      method: "each shape in a fresh process: warmMs = best of 5 after a warm-up, coldMs = the first request with no warm-up; simulated Turso and client response parsing excluded",
    },
  };
};
