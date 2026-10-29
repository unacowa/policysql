import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TursoHttpTransport } from "../src/turso-http.ts";
import { MAX_BYTES_PER_VALUE } from "../src/binary.ts";

const result = (columns, rows, usage = {}) => ({
  type: "ok",
  response: {
    type: "execute",
    result: {
      cols: columns.map((name) => ({ name, decltype: "TEXT" })),
      rows: rows.map((row) => row.map((value) => ({ type: "text", value }))),
      affected_row_count: 0,
      rows_read: usage.rowsRead ?? rows.length,
      rows_written: usage.rowsWritten ?? 0,
      query_duration_ms: usage.queryDurationMs ?? 1,
    },
  },
});

const blobCases = JSON.parse(readFileSync(new URL("../../../tests/fixtures/hrana-blob-response.json", import.meta.url), "utf8"));
const readBlob = async base64 => {
  const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "fixture" }, "blob-response", async (_url, init) => {
    const { requests } = JSON.parse(init.body);
    return Response.json({ baton: "blob-baton", results: requests.map(request => {
      if (request.stmt.sql.startsWith("BEGIN")) return result([], []);
      const response = result(["state"], [[null]]);
      response.response.result.cols[0].decltype = "BLOB";
      response.response.result.rows = [[{ type: "blob", base64 }]];
      return response;
    }) });
  });
  const transaction = await transport.begin("read", 1000);
  return (await transaction.execute([{ sql: "SELECT state FROM projects" }]))[0].rows[0][0];
};

test("decodes padded and unpadded Hrana BLOB responses without changing their bytes", async () => {
  for (const { base64, bytes } of blobCases.valid) {
    const output = await readBlob(base64);
    assert.ok(output instanceof Uint8Array);
    assert.deepEqual([...output], bytes, JSON.stringify(base64));
  }
});

test("rejects malformed typed Hrana BLOB responses", async () => {
  for (const base64 of [...blobCases.invalid, ...blobCases.wrongTypes]) {
    await assert.rejects(readBlob(base64), { status: 503, code: "POLICYSQL_DATABASE_UNAVAILABLE" }, JSON.stringify(base64));
  }
});

test("bounds padded and unpadded Hrana BLOB responses before decoding", async t => {
  const decode = t.mock.method(globalThis, "atob");
  for (const length of [MAX_BYTES_PER_VALUE - 2, MAX_BYTES_PER_VALUE - 1, MAX_BYTES_PER_VALUE]) {
    const bytes = Buffer.alloc(length, 255);
    const padded = bytes.toString("base64");
    for (const base64 of new Set([padded, padded.replace(/=+$/, "")])) {
      assert.deepEqual(Buffer.from(await readBlob(base64)), bytes);
    }
  }
  const calls = decode.mock.callCount();
  for (const length of [MAX_BYTES_PER_VALUE + 1, MAX_BYTES_PER_VALUE + 2, MAX_BYTES_PER_VALUE + 3]) {
    const padded = Buffer.alloc(length).toString("base64");
    for (const base64 of new Set([padded, padded.replace(/=+$/, "")])) {
      await assert.rejects(readBlob(base64), { status: 503, code: "POLICYSQL_DATABASE_UNAVAILABLE" });
      assert.equal(decode.mock.callCount(), calls, "oversized values are rejected before decode allocation");
    }
  }
});

test("decodes exact usage metrics while preserving transaction ownership", async () => {
  const requests = [];
  const fetchImpl = async function (_url, init) {
    assert.equal(this, undefined, "host fetch must not be invoked as a transport method");
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.requests[0].stmt?.sql.startsWith("BEGIN")) {
      return new Response(JSON.stringify({ baton: "baton_1", results: [result([], [])] }));
    }
    if (body.requests[0].stmt?.sql === "COMMIT") {
      return new Response(JSON.stringify({
        baton: null,
        results: [result([], []), { type: "ok", response: { type: "close" } }],
      }));
    }
    return new Response(JSON.stringify({
      baton: "baton_2",
      results: [result(["id"], [["p1"]], { rowsRead: 12, queryDurationMs: 2.5 })],
    }));
  };
  const transport = new TursoHttpTransport(
    { url: "https://db.test", authToken: "secret" },
    "req_1",
    fetchImpl,
  );
  const transaction = await transport.begin("read", 1000);
  const output = await transaction.execute([{ sql: "SELECT id FROM projects", args: {} }]);
  await transaction.commit();
  assert.equal(output[0].usage.rowsRead, 12);
  assert.equal(requests[1].baton, "baton_1");
  assert.equal(requests[2].baton, "baton_2");
});

test("rejects missing per-query billing metrics", async () => {
  const transport = new TursoHttpTransport(
    { url: "https://db.test", authToken: "secret" },
    "req_1",
    async () => new Response(JSON.stringify({
      baton: "baton",
      results: [{
        type: "ok",
        response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0 } },
      }],
    })),
  );
  await assert.rejects(transport.begin("read", 1000), (error) => error.code === "POLICYSQL_DATABASE_UNAVAILABLE");
});

test("HTTP operations share an absolute deadline while rollback retains its cleanup budget", async (t) => {
  let now = 10_000;
  const budgets = [];
  const requests = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(AbortSignal, "timeout", (timeout) => {
    budgets.push(timeout);
    return new AbortController().signal;
  });
  const transport = new TursoHttpTransport({ url: "https://db.test", authToken: "secret" }, "deadline", async (_url, init) => {
    const { requests: commands } = JSON.parse(init.body);
    requests.push(commands[0].stmt.sql);
    return Response.json({
      baton: commands.length === 1 ? "baton" : null,
      results: commands.map((command) => command.type === "close"
        ? { type: "ok", response: { type: "close" } } : result([], [])),
    });
  });
  const first = await transport.begin("read", 1000, 10_200);
  now += 120;
  await first.execute([{ sql: "SELECT id FROM projects" }]);
  now += 50;
  await first.commit();
  assert.deepEqual(budgets, [200, 80, 30]);

  const second = await transport.begin("read", 1000, 10_200);
  now = 10_200;
  const count = requests.length;
  await assert.rejects(second.execute([{ sql: "SELECT id FROM projects" }]), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
  await assert.rejects(second.commit(), (error) => error.code === "POLICYSQL_DATABASE_TIMEOUT");
  assert.equal(requests.length, count, "no SQL or COMMIT after expiry");
  await second.rollback();
  assert.equal(requests.at(-1), "ROLLBACK");
  assert.equal(budgets.at(-1), 1000);
  assert.equal(second.open, false);
});
