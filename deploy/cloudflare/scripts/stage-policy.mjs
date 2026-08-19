import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const deploymentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyRoot = path.join(deploymentRoot, "config");
const rootPath = path.join(policyRoot, "policy.yaml");
const outputPath = path.join(policyRoot, "policy.compiled.yaml");
const root = parse(fs.readFileSync(rootPath, "utf8"), { uniqueKeys: true });

if (root?.version !== 1 || !Array.isArray(root.includes) || root.includes.length === 0) {
  throw new Error("policy root must contain version: 1 and a non-empty includes list");
}

const resources = {};
for (const include of root.includes) {
  if (typeof include !== "string" || path.isAbsolute(include) || include.includes("\\")) {
    throw new Error(`invalid policy include: ${String(include)}`);
  }
  const normalized = path.posix.normalize(include);
  if (normalized === ".." || normalized.startsWith("../") || /[*?{}$]/.test(include)) {
    throw new Error(`invalid policy include: ${include}`);
  }
  const resolved = path.resolve(policyRoot, normalized);
  const relative = path.relative(policyRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`policy include escapes root: ${include}`);
  }
  const document = parse(fs.readFileSync(resolved, "utf8"), { uniqueKeys: true });
  if (!document?.resource || !document.roles || Object.keys(document).some((key) => !["resource", "roles"].includes(key))) {
    throw new Error(`invalid resource policy: ${include}`);
  }
  if (Object.hasOwn(resources, document.resource)) {
    throw new Error(`duplicate resource policy: ${document.resource}`);
  }
  resources[document.resource] = { roles: document.roles };
}

const compiled = {
  version: 1,
  resources,
  ...(root.commit_checks ? { commit_checks: root.commit_checks } : {}),
};
fs.writeFileSync(outputPath, stringify(compiled), { encoding: "utf8", mode: 0o600 });
