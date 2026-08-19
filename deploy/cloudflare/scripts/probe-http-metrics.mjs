const required = (name) => {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
};
const organization = required("TURSO_ORG");
const apiToken = required("TURSO_API_TOKEN");
const platform = async (path, init = {}) => {
  const response = await fetch(`https://api.turso.tech${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Turso API ${response.status}`);
  return body;
};
const database = await platform(`/v1/organizations/${organization}/databases/policysql-dev`);
const descriptor = database.database ?? database;
const hostname = descriptor.Hostname ?? descriptor.hostname;
const token = await platform(
  `/v1/organizations/${organization}/databases/policysql-dev/auth/tokens?expiration=5m&authorization=read-only`,
  { method: "POST", body: "{}" },
);
const response = await fetch(`https://${hostname}/v2/pipeline`, {
  method: "POST",
  headers: { authorization: `Bearer ${token.jwt}`, "content-type": "application/json" },
  body: JSON.stringify({
    requests: [
      { type: "execute", stmt: { sql: "SELECT id FROM projects WHERE tenant_id = :tenant", named_args: [{ name: "tenant", value: { type: "text", value: "tenant_a" } }] } },
      { type: "close" },
    ],
  }),
});
const body = await response.json();
if (!response.ok || body.results?.[0]?.type !== "ok") throw new Error("SQL over HTTP probe failed");
const result = body.results[0].response.result;
process.stdout.write(`${JSON.stringify({
  status: response.status,
  keys: Object.keys(result).sort(),
  rowsRead: result.rows_read,
  rowsWritten: result.rows_written,
  queryDurationMs: result.query_duration_ms,
}, null, 2)}\n`);
