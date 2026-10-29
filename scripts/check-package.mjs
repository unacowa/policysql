import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
const included = new Set(packed.files.map(file => file.path));
const required = [
  ...Object.values(manifest.exports).flatMap(value => typeof value === "string" ? [value] : Object.values(value)),
  ...Object.values(manifest.bin),
  "deploy/cloudflare/pkg/policysql_wasm.js",
  "deploy/cloudflare/pkg/policysql_wasm_bg.wasm",
  "deploy/cloudflare/src/binary.ts",
  "deploy/cloudflare/src/driver-values.ts",
];
for (const path of required) {
  if (!included.has(path.replace(/^\.\//, ""))) throw new Error(`Missing package file: ${path}`);
}
console.log(`Package includes all ${required.length} required entrypoints and runtime artifacts.`);
