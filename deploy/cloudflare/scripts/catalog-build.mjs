import { readFile, writeFile } from "node:fs/promises";
import { connect } from "@tursodatabase/serverless";
import { parse } from "yaml";

const identifier = /^[a-z][a-z0-9_]*$/;

const assertManifest = (manifest) => {
  if (!manifest || manifest.version !== 1 || !manifest.resources || Array.isArray(manifest.resources)) {
    throw new Error("Catalog manifest is invalid");
  }
  for (const [resourceName, resource] of Object.entries(manifest.resources)) {
    if (!identifier.test(resourceName) || !identifier.test(resource?.source?.table)) {
      throw new Error("Catalog resource mapping is invalid");
    }
    if (!resource.columns || Array.isArray(resource.columns) || Object.keys(resource.columns).length === 0) {
      throw new Error("Catalog resource columns are invalid");
    }
    if (!Object.keys(resource.columns).every((name) => identifier.test(name))) {
      throw new Error("Catalog column name is invalid");
    }
  }
};

export const buildPhysicalSchema = async (connection, catalogYaml) => {
  const manifest = parse(catalogYaml);
  assertManifest(manifest);
  const tables = {};
  const physicalTables = new Map();
  for (const resource of Object.values(manifest.resources)) {
    const tableName = resource.source.table;
    let physical = physicalTables.get(tableName);
    if (!physical) {
      const rows = await connection.all(`PRAGMA table_xinfo("${tableName}")`);
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("Catalog source table does not exist");
      }
      physical = new Map(rows.map((row) => [row.name, row]));
      physicalTables.set(tableName, physical);
    }
    const columns = tables[tableName]?.columns ?? {};
    for (const name of Object.keys(resource.columns)) {
      const row = physical.get(name);
      if (!row || typeof row.type !== "string" || Number(row.hidden) !== 0) {
        throw new Error("Catalog column does not match the physical schema");
      }
      columns[name] = {
        declaredType: row.type,
        nullable: !(Number(row.notnull) === 1 || Number(row.pk) > 0),
      };
    }
    tables[tableName] = { columns };
  }
  return { tables };
};

const main = async () => {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
  const catalogPath = new URL("../config/catalog.yaml", import.meta.url);
  const outputPath = new URL("../config/schema-introspection.json", import.meta.url);
  const connection = connect({ url, authToken, defaultQueryTimeout: 5_000 });
  try {
    const schema = await buildPhysicalSchema(connection, await readFile(catalogPath, "utf8"));
    await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`);
  } finally {
    await connection.close();
  }
};

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  await main();
}
