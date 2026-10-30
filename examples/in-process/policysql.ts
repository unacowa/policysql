// PolicySQL without HTTP (ADR 0019, ADR 0023): one Node process calls the engine operations
// directly. There is no route, header, or status here; results are values or
// `{ code, message, path }`. A Cloudflare service binding would call the same operations
// through `createPolicySqlWorker(...).engine(env)`.
//
// The wrapper's responsibilities stay with this file: it authenticates nobody (the caller
// passes a trusted session), selects the one database, and supplies the ports. Node's
// built-in SQLite stands in for a remote database, and transaction owners live in this
// process, which is the whole TransactionOwner contract only because there is one process.
//
// In a bundled deployment the imports are `@unacowa/policysql/cloudflare`; this example
// imports the library source so it runs in Node without a bundler.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { initSync, PolicySqlRuntime } from "../../deploy/cloudflare/pkg/policysql_wasm.js";
import { createEngine } from "../../deploy/cloudflare/src/engine.ts";
import type { PolicySqlEngine } from "../../deploy/cloudflare/src/engine.ts";
import { TransactionOwnerCore } from "../../deploy/cloudflare/src/transaction-owner.ts";
import type { TransactionOwnerPort } from "../../deploy/cloudflare/src/transaction-owner-port.ts";
import type {
  DatabaseBinding, DatabaseProvider, DatabaseResult, DatabaseTransaction,
} from "../../deploy/cloudflare/src/database.ts";
import type { PolicySqlConfig } from "../../deploy/cloudflare/src/engine-config.ts";

const file = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
export const SCHEMA_VERSION = "schema_in_process_1";
export const POLICY_VERSION = "policy_in_process_1";

/** Loads the WASM core once for this process. */
export const loadRuntime = (): (() => PolicySqlRuntime) => {
  initSync({ module: readFileSync(new URL("../../deploy/cloudflare/pkg/policysql_wasm_bg.wasm", import.meta.url)) });
  const runtime = PolicySqlRuntime.newWithPhysicalSchema(
    file("catalog.yaml"), file("policy.yaml"), SCHEMA_VERSION, POLICY_VERSION,
    JSON.stringify({ max_rows: 100, max_result_bytes: 64_000, timeout_ms: 1_000, max_statements: 8 }),
    file("physical-schema.json"),
  );
  return () => runtime;
};

const NO_USAGE = Object.freeze({ rowsRead: 0, rowsWritten: 0, queryDurationMs: 0 });

// A DatabaseTransaction over one node:sqlite connection. PolicySQL sends only the protected
// SQL it compiled, with named arguments, and validates every result itself.
const sqliteTransaction = (database: DatabaseSync, mode: "read" | "write"): DatabaseTransaction => {
  database.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
  let open = true;
  const end = (sql: string) => { if (open) { open = false; database.exec(sql); } };
  return {
    get open() { return open; },
    usage: [],
    async execute(statements) {
      return statements.map(({ sql, args = {} }): DatabaseResult => {
        const statement = database.prepare(sql);
        statement.setReturnArrays(true);
        const columns = statement.columns().map((column) => column.name);
        const rows = statement.all(args as Record<string, any>) as unknown as unknown[][];
        const changes = /^\s*(insert|update|delete)\b/iu.test(sql)
          ? Number((database.prepare("SELECT changes()").get() as Record<string, unknown>)["changes()"]) : 0;
        return { columns, rows, rowsAffected: changes, usage: NO_USAGE };
      });
    },
    async commit() { end("COMMIT"); },
    async rollback() { end("ROLLBACK"); },
  };
};

// One registered database. `check` must return exactly true for the binding the wrapper selected.
const sqliteProvider = (binding: DatabaseBinding, database: DatabaseSync): DatabaseProvider => {
  const registered = (selected: DatabaseBinding) =>
    (Object.keys(binding) as Array<keyof DatabaseBinding>).every((key) => binding[key] === selected[key]);
  return {
    check: registered,
    connect(selected) {
      if (!registered(selected)) throw new Error("unregistered database");
      return { begin: async (mode) => sqliteTransaction(database, mode) };
    },
  };
};

// One owner per name in this process, with a durable store, one timer, and background tasks.
const inProcessOwners = (dependencies: ConstructorParameters<typeof TransactionOwnerCore>[1]): TransactionOwnerPort => {
  const owners = new Map<string, TransactionOwnerCore>();
  return {
    route(name) {
      let owner = owners.get(name);
      if (!owner) {
        const store = new Map<string, unknown>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const core: TransactionOwnerCore = new TransactionOwnerCore({
          store: { get: async (key) => structuredClone(store.get(key)), put: async (key, value) => { store.set(key, structuredClone(value)); } },
          timer: {
            async schedule(atMs) {
              clearTimeout(timer);
              timer = setTimeout(() => { void core.onTimer(); }, Math.max(0, atMs - Date.now()));
              timer.unref?.();
            },
          },
          background: { run: (task) => { void task; } },
        }, dependencies);
        owner = core;
        owners.set(name, owner);
      }
      return owner;
    },
  };
};

export type InProcessPolicySql = {
  engine: PolicySqlEngine;
  database: DatabaseSync;
  /** The context this wrapper passes to every client operation. */
  binding: DatabaseBinding;
  close(): void;
};

/** Assembles the engine for one in-memory SQLite database. */
export const createInProcessPolicySql = (getRuntime: () => PolicySqlRuntime): InProcessPolicySql => {
  const database = new DatabaseSync(":memory:");
  database.exec(file("schema.sql"));
  // Needed only for atomic writes with an idempotency key.
  database.exec(file("idempotency.sql"));
  const binding: DatabaseBinding = Object.freeze({
    version: 1, scope: "in-process", databaseId: "memory", generation: "1", snapshot: getRuntime().snapshot,
  });
  const config: PolicySqlConfig = { environment: "in-process", commitChecks: {} };
  const ownerDependencies = { getRuntime, database: sqliteProvider(binding, database), config };
  const engine = createEngine({
    ...ownerDependencies,
    transactionOwners: inProcessOwners(ownerDependencies),
    publicConfig: { schemaVersion: SCHEMA_VERSION, policyVersion: POLICY_VERSION },
  });
  return { engine, database, binding, close: () => database.close() };
};
