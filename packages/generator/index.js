import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { object, readResponse, required, validateOptions, validateRole } from "../client/protocol.js";

const identifier = (name) => name.replace(/[^A-Za-z0-9]+(.)/g, (_, next) => next.toUpperCase());
const property = (name) => JSON.stringify(name);
const logicalType = (descriptor) => {
  if (!object(descriptor) || typeof descriptor.name !== "string" || !descriptor.name ||
    typeof descriptor.nullable !== "boolean" || !["string", "number", "boolean", "object", "array"].includes(descriptor.representation)) {
    throw new TypeError("Invalid Explain descriptor");
  }
  const types = Array.isArray(descriptor.type) ? descriptor.type : [descriptor.type];
  if (types.length === 0 || new Set(types).size !== types.length ||
    types.some(type => typeof type !== "string" || !/^[a-z][a-z0-9_]*$/.test(type))) throw new TypeError("Invalid Explain type");
  const mapped = types.map((type) => {
    if (type === "json") return "unknown";
    if (["date", "datetime", "instant", "int64"].includes(type) && descriptor.representation === "string") {
      return `string & { readonly __policysql_${type}: unique symbol }`;
    }
    return { string: "string", number: "number", boolean: "boolean", object: "Record<string, unknown>", array: "unknown[]" }[descriptor.representation];
  });
  return [...new Set([...mapped, ...(descriptor.nullable ? ["null"] : [])])].join(" | ");
};
const descriptors = (items, parameters = false) => {
  if (!Array.isArray(items)) throw new TypeError("Invalid Explain descriptors");
  const names = new Set();
  return items.map(item => {
    const type = logicalType(item);
    const name = parameters ? item.name : item.name.replace(/[A-Z]/g, c => c.toLowerCase());
    if (names.has(name) || (parameters && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))) throw new TypeError("Invalid Explain descriptor name");
    names.add(name);
    return `  ${property(item.name)}: ${type}`;
  }).join("\n");
};
const versions = (value) => ({
  schemaVersion: required(value.schemaVersion, "schemaVersion"),
  policyVersion: required(value.policyVersion, "policyVersion"),
});
const sameVersions = (left, right) => left.schemaVersion === right.schemaVersion && left.policyVersion === right.policyVersion;

export const generate = async (options) => {
  validateOptions(options, ["endpoint", "role", "input", "output", "transport", "signal"]);
  const { endpoint, role, input, output, transport, signal } = options;
  required(endpoint, "endpoint");
  required(input, "input");
  required(output, "output");
  required(role, "role");
  validateRole(role);
  if (typeof transport !== "function") throw new TypeError("transport must be a function");
  // Endpoint is generation metadata supplied by the application, never inspected
  // from a Transport. Authentication and DB selection remain application concerns.
  const request = async (kind, body) => {
    signal?.throwIfAborted();
    const response = readResponse(await transport(Object.freeze({ kind, role, ...(body === undefined ? {} : { body }) }), { signal }));
    if (response.error) throw response.error;
    if (response.status !== 200) throw new TypeError("Invalid generation response status");
    return response.body;
  };
  const [catalog, capabilities] = await Promise.all([request("catalog"), request("capabilities")]);
  const expected = versions(catalog);
  if (!sameVersions(expected, versions(capabilities)) || catalog.role !== role) throw new Error("POLICYSQL_STALE_OPERATION");
  if (!Array.isArray(catalog.resources) || capabilities.sqlDialect !== "sqlite") throw new TypeError("Invalid discovery response");
  const files = (await readdir(input, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".sql")).map(entry => entry.name).sort();
  const generated = [];
  const queries = [];
  const names = new Set();
  for (const file of files) {
    const sql = (await readFile(join(input, file), "utf8")).trim();
    required(sql, "sql");
    const explain = await request("explain", JSON.stringify({ expected, statements: [{ sql, params: {} }] }));
    if (!object(explain.meta) || !sameVersions(expected, versions(explain.meta)) || explain.meta.role !== role) throw new Error("POLICYSQL_STALE_OPERATION");
    if (!Array.isArray(explain.statements) || explain.statements.length !== 1 || !object(explain.statements[0])) throw new TypeError("Invalid Explain response");
    const statement = explain.statements[0];
    const variable = identifier(basename(file, ".sql"));
    const name = variable.charAt(0).toUpperCase() + variable.slice(1);
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(variable) || names.has(name) || ["Object", "Error", "GeneratedPolicyQuery", "arguments", "eval"].includes(variable) ||
      /^(await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield)$/.test(variable)) throw new TypeError("SQL filenames must produce unique TypeScript identifiers");
    names.add(name);
    const params = descriptors(statement.parameters, true);
    const rows = descriptors(statement.result?.columns);
    const queryHash = createHash("sha256").update(sql).digest("hex");
    const metadata = { sql, queryHash, role, ...expected };
    queries.push({ file, ...metadata, parameters: statement.parameters, result: statement.result });
    generated.push(`export interface ${name}Params {\n${params}\n}\n\nexport interface ${name}Row {\n${rows}\n}\n\nexport const ${variable} = Object.freeze<GeneratedPolicyQuery<${name}Params, ${name}Row>>({\n${Object.entries(metadata).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join("\n")}\n  async execute(client, params) {\n    if (client.role !== ${JSON.stringify(role)} || client.schemaVersion !== ${JSON.stringify(expected.schemaVersion)} || client.policyVersion !== ${JSON.stringify(expected.policyVersion)}) throw new Error("POLICYSQL_STALE_OPERATION");\n    return (await client.execute<${name}Row>(${JSON.stringify(sql)}, { ...params })).rows\n  },\n})\n`);
  }
  // No output is replaced until every response and query has been validated.
  signal?.throwIfAborted();
  const target = resolve(output);
  const temporary = `${target}.tmp-${randomUUID()}`;
  const previous = `${target}.previous-${randomUUID()}`;
  await mkdir(dirname(target), { recursive: true });
  let backedUp = false;
  let installed = false;
  try {
    await mkdir(temporary);
    await writeFile(join(temporary, "index.ts"), `// Generated by policysql generate. Do not edit.\nimport type { GeneratedPolicyQuery } from '@unacowa/policysql/client'\n\n${generated.join("\n")}\n`);
    await writeFile(join(temporary, "metadata.json"), JSON.stringify({ endpoint, role, ...expected, catalog, capabilities, queries }, null, 2) + "\n");
    signal?.throwIfAborted();
    try { await rename(target, previous); backedUp = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, target);
    installed = true;
  } catch (error) {
    if (backedUp && !installed) {
      try { await rename(previous, target); }
      catch (restoreError) { throw new AggregateError([error, restoreError], "Generation failed; previous output remains in " + previous); }
    }
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
  // Installation is complete; backup cleanup must not turn it into a failed generation.
  if (backedUp) await rm(previous, { recursive: true, force: true }).catch(() => undefined);
};
