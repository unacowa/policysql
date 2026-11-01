// Node-side CPU measurement of the PolicySQL request path (ADR 0027 pull request 1, #56).
//
// Provenance: the method is the one the ADR 0027 author used on origin/main f44fcdb. The routing
// test harness (test/helpers/routing.mjs: the real engine, HTTP adapter, Durable Objects adapter
// over a simulated platform, Turso HTTP transport, and the release WASM) runs a request. Time
// spent in the simulated Turso server and in the harness client's `response.json()` is excluded
// (`excludeTime`); everything else is the CPU a Worker and a Durable Object would spend. Each
// figure is the best of `runs` after a warm-up, in ms of wall time on a single-threaded
// CPU-bound path. The scenario shapes come from the ADR's Context tables and its pull request 1
// text. Nothing here depends on files outside the repository.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync } from "../../pkg/policysql_wasm.js";
import { RawJson, harness } from "../../test/helpers/routing.mjs";
import { MIB } from "./cpu-model.mjs";
import { REQUEST_SHAPES, countJsonValues } from "./cpu-shapes.mjs";

const fixtureFile = (name) => readFileSync(new URL(`../../../../tests/fixtures/bytes/${name}`, import.meta.url), "utf8");
// The runtime limits of every scenario: wide enough that the scenario's own bound never bites
// first (the ADR's measurement harness used the same). The model's `B`/`V` are computed from
// what the scenario actually moved, not from these.
// The request limits are the hard maxima (ADR 0027), so the request shapes (sized by
// REQUEST_VALUE_BUDGET, the reference wrapper's value limit) are never refused for size.
const MEASURE_LIMITS = {
  maxRows: 2_000, maxResultBytes: 524_288, timeoutMs: 10_000, maxStatements: 8,
  maxRequestBytes: 2_097_152, maxJsonValues: 131_072,
};

/** The WASM linear memory (never shrinks, so its size is the process's high-water mark), MiB. */
const wasmMemoryMiB = () => {
  const wasm = initSync({ module: readFileSync(new URL("../../pkg/policysql_wasm_bg.wasm", import.meta.url)) });
  return wasm.memory.buffer.byteLength / MIB;
};

const makeClock = (cold = false) => {
  let excluded = 0;
  return {
    /** Cold: `best` times only the first call, with no warm-up (a fresh process's first request). */
    cold,
    reset() { excluded = 0; },
    get excluded() { return excluded; },
    async excludeTime(work) {
      const started = performance.now();
      try { return await work(); } finally { excluded += performance.now() - started; }
    },
  };
};

/** Best (minimum) of `runs` timed calls of `work(index)` after one warm-up call (index 0). */
const best = async (clock, runs, work) => {
  if (clock.cold) {
    clock.reset();
    const started = performance.now();
    await work(0);
    return performance.now() - started - clock.excluded;
  }
  await work(0);
  let fastest = Infinity;
  for (let run = 1; run <= runs; run += 1) {
    clock.reset();
    const started = performance.now();
    await work(run);
    fastest = Math.min(fastest, performance.now() - started - clock.excluded);
  }
  return fastest;
};

const withHarness = async (fixture, scenario, work, { cold = false } = {}) => {
  const cleanups = [];
  const clock = makeClock(cold);
  const log = console.log;
  console.log = () => {};
  try {
    const h = await harness({ after: (fn) => cleanups.push(fn) }, {
      fixture, hooks: false, idempotencyTable: true, runtimeLimits: scenario.limits ?? MEASURE_LIMITS, excludeTime: clock.excludeTime,
    });
    const raw = { cols: 0, cells: 0, textBytes: 0, columnMetadataBytes: 0, rawBytes: 0 };
    const resetRaw = () => Object.keys(raw).forEach((key) => { raw[key] = 0; });
    // The simulated database's replies as the engine receives them: the raw result the model's
    // `B` and `V_res` describe. The hook runs inside `excludeTime` and returns nothing.
    h.replaceDatabaseResponse(({ results }) => {
      raw.rawBytes += JSON.stringify(results).length;
      for (const result of results) {
        const body = result.response?.result;
        if (!body) continue;
        raw.cols += body.cols.length;
        raw.cells += body.rows.length * body.cols.length;
        for (const column of body.cols) raw.columnMetadataBytes += 2 * column.name.length + 2 * (column.decltype ?? "").length + 32;
        for (const row of body.rows) for (const cell of row) if (cell.type === "text") raw.textBytes += Buffer.byteLength(cell.value);
      }
    });
    return await work({ h, clock, raw, resetRaw });
  } finally {
    console.log = log;
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
};

// ---------------------------------------------------------------------------------------------
// Request shapes (ADR 0027 "Request and JSON-cell result path"): an INSERT whose JSON `metadata`
// parameter carries the shape, then a SELECT of the row back.

const BYTES_FIXTURE = () => ({
  catalog: fixtureFile("catalog.yaml"), policy: fixtureFile("policy.yaml"), schema: fixtureFile("schema.sql"),
  physicalSchema: fixtureFile("physical-schema.json"), seed() {},
});
const INSERT_SQL = "INSERT INTO projects(id,name,state,metadata) VALUES(:id,:name,:state,:metadata)";
const SELECT_BACK_SQL = "SELECT id, name, state, metadata FROM projects WHERE id = :id";

const requestScenarios = (target) => Object.entries(REQUEST_SHAPES).flatMap(([shape, make]) => {
  const prefix = `request: ${shape}`;
  const metadata = make(target);
  const params = (id, extra = {}) => ({ id, name: "n", state: "AA==", metadata, ...extra });
  const body = (id, extra) => JSON.stringify({ statements: [{ sql: INSERT_SQL, params: params(id, extra) }] });
  const bodyBytes = Buffer.byteLength(body("x"));
  const values = countJsonValues(JSON.parse(body("x")));
  const shared = { bodyBytes, values };
  return [
    {
      id: `${prefix} | atomic keyed`, group: "request", ...shared,
      async run(context, runs) {
        const raws = Array.from({ length: runs + 1 }, (_, r) => new RawJson(body(`a${r}`)));
        const measuredMs = await best(context.clock, runs, async (r) => {
          const res = await context.h.request("a", "/v1/transactions:execute", raws[r], `key-atomic-${r}-0123456789`);
          assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
        });
        return { measuredMs, inputs: { rMiB: bodyBytes / MIB, bMiB: 0, vReq: values, vRes: 0 }, details: { bodyBytes, jsonValues: values } };
      },
    },
    {
      // No database: the unknown parameter fails after the body was parsed and before anything runs.
      id: `${prefix} | rejected at compile`, group: "request", ...shared,
      async run(context, runs) {
        const raw = new RawJson(body("r", { bogus: 1 }));
        const measuredMs = await best(context.clock, runs, async () => {
          const res = await context.h.request("a", "/v1/transactions:execute", raw, null);
          assert.notEqual(res.status, 200);
        });
        return { measuredMs, inputs: { rMiB: bodyBytes / MIB, bMiB: 0, vReq: values, vRes: 0 }, details: { bodyBytes, jsonValues: values } };
      },
    },
    {
      id: `${prefix} | SELECT back`, group: "result-json", ...shared,
      async run(context, runs) {
        // The row to read back: one atomic insert first (not timed).
        const inserted = await context.h.request("a", "/v1/transactions:execute", new RawJson(body("s1")), "key-seed-0123456789");
        assert.equal(inserted.status, 200);
        let outcome = null;
        const measuredMs = await best(context.clock, runs, async () => {
          context.resetRaw();
          const res = await context.h.request("a", "/v1/transactions:execute", { statements: [{ sql: SELECT_BACK_SQL, params: { id: "s1" } }] }, null);
          outcome = { status: res.status, code: res.body?.error?.code ?? null, publicBytes: res.status === 200 ? Buffer.byteLength(JSON.stringify(res.body)) : 0 };
        });
        if (outcome.status !== 200) return { skipped: `HTTP ${outcome.status} ${outcome.code}`, details: { bodyBytes, jsonValues: values } };
        const { raw } = context;
        // V_res: raw cells and descriptors, plus the values inside the JSON cell. B: the text and
        // the column metadata the raw bound is made of (ADR 0027 "B").
        const vRes = raw.cols + raw.cells + values;
        return {
          measuredMs,
          inputs: { rMiB: 0, bMiB: (raw.textBytes + raw.columnMetadataBytes + 512) / MIB, vReq: 0, vRes },
          details: { publicResponseBytes: outcome.publicBytes, rawBytes: raw.rawBytes, jsonValues: values },
        };
      },
    },
  ];
});

// ---------------------------------------------------------------------------------------------
// Result shapes (ADR 0027 "Cell-heavy result path" and the companion-heavy shape of pull request 1).

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const columnNames = (count) => Array.from({ length: count }, (_, index) => `c${index}`);

/**
 * A table `wide` of `columns` columns (all INTEGER or all TEXT). With `conditional`, every
 * column is projected with `visible_if` (each emits a visibility `CASE` companion cell). The
 * update policy carries a check (a check companion cell in RETURNING); RETURNING lists plain
 * columns, because the policy language allows `visible_if` on SELECT projections only.
 */
const wideFixture = ({ columns, rows, conditional = true, type = "integer" }) => {
  const names = columnNames(columns);
  const projection = (indent, visible = conditional) => names.map((name) => visible
    ? `${indent}- name: ${name}\n${indent}  visible_if: { tenant_id: { eq: { session: tenant_id } } }\n${indent}  on_deny: null`
    : `${indent}- ${name}`).join("\n");
  const declared = type === "integer" ? "INTEGER" : "TEXT";
  return {
    catalog: `version: 1\nresources:\n  wide:\n    source: { table: wide }\n    columns:\n      id: { type: string }\n      tenant_id: { type: string }\n${names.map((name) => `      ${name}: { type: ${type} }`).join("\n")}\n`,
    policy: `version: 1\nresources:\n  wide:\n    roles:\n      member:\n        select:\n          columns:\n            - id\n${projection("            ")}\n          filter: { tenant_id: { eq: { session: tenant_id } } }\n          limit: ${rows}\n        update:\n          columns: [${names[0]}]\n          filter: { tenant_id: { eq: { session: tenant_id } } }\n          check: { tenant_id: { eq: { session: tenant_id } } }\n          returning:\n            columns:\n              - id\n${projection("              ", false)}\n`,
    schema: `CREATE TABLE wide (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, ${names.map((name) => `${name} ${declared} NOT NULL`).join(", ")});`,
    physicalSchema: JSON.stringify({ tables: { wide: { columns: { id: { declaredType: "TEXT", nullable: false }, tenant_id: { declaredType: "TEXT", nullable: false }, ...Object.fromEntries(names.map((name) => [name, { declaredType: declared, nullable: false }])) } } } }),
    seed(db, tenant) {
      const insert = db.prepare(`INSERT INTO wide VALUES (?, ?, ${names.map(() => "?").join(", ")})`);
      for (let row = 0; row < rows; row += 1) insert.run(`r${row}`, `tenant_${tenant}`, ...names.map((_, index) => (type === "integer" ? (row + index) % 10 : `v${(row + index) % 10}`)));
    },
  };
};

const resultScenario = ({ id, rows, columns, conditional = true, aliases = false, verb = "select" }) => ({
  id, group: "result-cells",
  async run(context, runs) {
    const names = columnNames(columns);
    const select = aliases
      ? `SELECT id AS _, ${names.map((name, index) => `${name} AS ${LETTERS[index]}`).join(", ")} FROM wide`
      : `SELECT id, ${names.join(", ")} FROM wide`;
    const returning = aliases
      ? `id AS _, ${names.map((name, index) => `${name} AS ${LETTERS[index]}`).join(", ")}`
      : `id, ${names.join(", ")}`;
    const sql = verb === "select" ? select : `UPDATE wide SET c0 = :v RETURNING ${returning}`;
    const params = verb === "select" ? {} : { v: 7 };
    let status = 0;
    let publicBytes = 0;
    const measuredMs = await best(context.clock, runs, async (r) => {
      context.resetRaw();
      const res = await context.h.request("a", "/v1/transactions:execute", { statements: [{ sql, params }] }, verb === "select" ? null : `key-${verb}-${r}-0123456789`);
      status = res.status;
      assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
      publicBytes = Buffer.byteLength(JSON.stringify(res.body));
    });
    const { raw } = context;
    return {
      measuredMs,
      inputs: { rMiB: 0, bMiB: (raw.textBytes + raw.columnMetadataBytes + 512) / MIB, vReq: 0, vRes: raw.cols + raw.cells },
      details: { rows, columns, conditional, publicResponseBytes: publicBytes, rawBytes: raw.rawBytes, rawValues: raw.cols + raw.cells, status },
    };
  },
});

const wideScenarios = () => [
  { ...resultScenario({ id: "result: 100 x 64 conditional (visible_if)", rows: 100, columns: 64 }), fixture: () => wideFixture({ rows: 100, columns: 64 }) },
  { ...resultScenario({ id: "result: 100 x 64 plain", rows: 100, columns: 64, conditional: false }), fixture: () => wideFixture({ rows: 100, columns: 64, conditional: false }) },
  { ...resultScenario({ id: "result: 1,000 x 10 conditional", rows: 1_000, columns: 10 }), fixture: () => wideFixture({ rows: 1_000, columns: 10 }) },
  { ...resultScenario({ id: "result: 2,000 x 4 conditional", rows: 2_000, columns: 4 }), fixture: () => wideFixture({ rows: 2_000, columns: 4 }) },
  // The companion-heavy shapes: one-character aliases (every alias costs the least text per
  // companion cell), every column `visible_if`, and RETURNING with the check column.
  { ...resultScenario({ id: "result: 1,000 x 25 conditional, 1-char aliases", rows: 1_000, columns: 25, aliases: true }), fixture: () => wideFixture({ rows: 1_000, columns: 25 }) },
  { ...resultScenario({ id: "result: UPDATE RETURNING + check, 1,000 x 25, 1-char aliases", rows: 1_000, columns: 25, aliases: true, verb: "update" }), fixture: () => wideFixture({ rows: 1_000, columns: 25 }) },
];

// ---------------------------------------------------------------------------------------------
// SQL-dense shapes (ADR 0027 pull request 1): does `a_b` cover parse, bind, policy composition,
// emit, the height counts, and re-parse, or does the formula need a term for SQL bytes? They go
// through `:explain`: everything before the database, no execution.

const MAX_SQL_BYTES = 65_536;
const MAX_STATEMENTS = 8;
const DENSE_COLUMNS = 128;

/**
 * Nine small resources `j0` ... `j8`, each with its own select policy and tenant row filter: the
 * smallest Catalog in which an 8-join statement is allowed (a self-join is rejected), so every
 * join adds a row filter to the emitted statement.
 */
const joinFixture = () => {
  const tables = Array.from({ length: 9 }, (_, index) => `j${index}`);
  return {
    catalog: `version: 1\nresources:\n${tables.map((table) => `  ${table}:\n    source: { table: ${table} }\n    columns:\n      id: { type: string }\n      tenant_id: { type: string }\n      v: { type: integer }\n`).join("")}`,
    policy: `version: 1\nresources:\n${tables.map((table) => `  ${table}:\n    roles:\n      member:\n        select:\n          columns: [id, v]\n          filter: { tenant_id: { eq: { session: tenant_id } } }\n          limit: 100\n`).join("")}`,
    schema: tables.map((table) => `CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, v INTEGER NOT NULL);`).join("\n"),
    physicalSchema: JSON.stringify({ tables: Object.fromEntries(tables.map((table) => [table, { columns: { id: { declaredType: "TEXT", nullable: false }, tenant_id: { declaredType: "TEXT", nullable: false }, v: { declaredType: "INTEGER", nullable: false } } }])) }),
    seed(db, tenant) {
      for (const table of tables) db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run("r0", `tenant_${tenant}`, 1);
    },
  };
};

const denseFixture = () => wideFixture({ rows: 10, columns: DENSE_COLUMNS, conditional: false, type: "string" });
const nest = (wrapper, inner, depth) => `${`${wrapper}(`.repeat(depth)}${inner}${")".repeat(depth)}`;
/** A SELECT at the input limits: `projections` expressions nested `depth` deep, padded to `bytes`. */
const denseStatement = ({ projections, depth, bytes }) => {
  const list = Array.from({ length: projections }, (_, index) => `${nest("lower", `c${index % DENSE_COLUMNS}`, depth)} AS a${index}`).join(", ");
  const head = `SELECT ${list} FROM wide`;
  if (bytes === undefined) return head;
  const prefix = `${head} WHERE c0 <> '`;
  const suffix = "'";
  return `${prefix}${"x".repeat(Math.max(0, bytes - prefix.length - suffix.length))}${suffix}`;
};

const explainScenario = ({ id, statements, group = "sql-dense", fixture = denseFixture }) => ({
  id, group, fixture,
  async run(context, runs) {
    const body = JSON.stringify({ statements });
    const bodyBytes = Buffer.byteLength(body);
    const values = countJsonValues(JSON.parse(body));
    const sqlBytes = statements.reduce((sum, statement) => sum + Buffer.byteLength(statement.sql), 0);
    const raw = new RawJson(body);
    let status = 0;
    let code = null;
    const measuredMs = await best(context.clock, runs, async () => {
      const res = await context.h.request("a", "/v1/transactions:explain", raw, null);
      status = res.status;
      code = res.body?.error?.code ?? null;
    });
    // A rejected statement would measure an early exit, not the SQL pipeline.
    assert.equal(status, 200, `${id}: ${code}`);
    return {
      measuredMs,
      // SQL text is request bytes: `R` covers it, which is exactly the question.
      inputs: { rMiB: bodyBytes / MIB, bMiB: 0, vReq: values, vRes: 0 },
      details: { bodyBytes, sqlBytes, statements: statements.length, jsonValues: values, status, code },
    };
  },
});

const sqlDenseScenarios = () => {
  const statement = (sql) => ({ sql, params: {} });
  const orChain = (terms) => Array.from({ length: terms }, (_, index) => `c${index} = 'v${index}'`).join(" OR ");
  const joins = (count) => `SELECT t0.id, t0.v FROM j0 AS t0 ${Array.from({ length: count }, (_, index) => `JOIN j${index + 1} AS t${index + 1} ON t${index + 1}.id = t${index}.id`).join(" ")}`;
  return [
    explainScenario({ id: "sql: expression depth 31 (nested lower())", statements: [statement(`SELECT ${nest("lower", "c0", 31)} AS a FROM wide`)] }),
    explainScenario({ id: "sql: OR chain, 32 terms", statements: [statement(`SELECT id FROM wide WHERE ${orChain(32)}`)] }),
    explainScenario({ id: "sql: 128 projections", statements: [statement(`SELECT ${columnNames(DENSE_COLUMNS).join(", ")} FROM wide`)] }),
    explainScenario({ id: "sql: 128 projections x nested lower() depth 30", statements: [statement(denseStatement({ projections: 128, depth: 30 }))] }),
    explainScenario({ id: "sql: 8 joins with row filters (9 policy filters)", statements: [statement(joins(8))], fixture: joinFixture }),
    explainScenario({ id: `sql: 1 statement at maxSqlBytes (${MAX_SQL_BYTES})`, statements: [statement(denseStatement({ projections: 128, depth: 30, bytes: MAX_SQL_BYTES - 16 }))] }),
    explainScenario({ id: `sql: ${MAX_STATEMENTS} statements at maxSqlBytes, dense and padded`, statements: Array.from({ length: MAX_STATEMENTS }, () => statement(denseStatement({ projections: 128, depth: 30, bytes: MAX_SQL_BYTES - 16 }))) }),
    explainScenario({ id: `sql: ${MAX_STATEMENTS} statements, 8 joins each`, statements: Array.from({ length: MAX_STATEMENTS }, () => statement(joins(8))), fixture: joinFixture }),
  ];
};

// ---------------------------------------------------------------------------------------------

/** Every scenario: `{ id, group, run(context, runs), fixture? }`. */
export const scenarios = ({ target = 1_000_000 } = {}) => [
  ...requestScenarios(target).map((scenario) => ({ ...scenario, fixture: BYTES_FIXTURE })),
  ...wideScenarios(),
  ...sqlDenseScenarios(),
];

/**
 * Runs one scenario in this process. Returns the scenario's row (`measuredMs`, model `inputs`,
 * `details`) and the WASM linear memory after it (the high-water mark when the process runs only
 * this scenario), or `{ skipped }` when the scenario cannot run against the build.
 */
export const runScenario = async (scenario, { runs = 5, cold = false } = {}) => {
  const result = await withHarness(scenario.fixture(), scenario, (context) => scenario.run(context, runs), { cold });
  return { id: scenario.id, group: scenario.group, ...result, wasmMemoryMiB: wasmMemoryMiB() };
};
