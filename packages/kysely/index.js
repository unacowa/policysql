import { SqliteAdapter, SqliteQueryCompiler } from "kysely";
import { copyJson } from "../client/protocol.js";
import { PolicySqlDriver } from "./driver.js";
import { extractOptions, operation } from "./options.js";
export { policyOptions } from "./options.js";

const freezeJson = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
};
class PolicySqlQueryCompiler extends SqliteQueryCompiler {
  #compiled;
  constructor(compiled) { super(); this.#compiled = compiled; }
  getCurrentParameterPlaceholder() { return `:p${this.numParameters}`; }
  compileQuery(root, queryId) {
    const { node, options } = extractOptions(root);
    const compiled = super.compileQuery(node, queryId);
    const query = Object.freeze({ ...compiled, parameters: freezeJson(copyJson(compiled.parameters)) });
    this.#compiled.set(query, Object.freeze({ operation: operation(node), options }));
    return query;
  }
}
class PolicySqlAdapter extends SqliteAdapter {
  get supportsMultipleConnections() { return true; }
  async acquireMigrationLock() { throw new TypeError("PolicySQL migrations are not supported"); }
  async releaseMigrationLock() { throw new TypeError("PolicySQL migrations are not supported"); }
}
export class PolicySqlDialect {
  #client;
  #config;
  #compiled = new WeakMap();
  constructor({ client, autoIdempotencyKey = false }) {
    if (typeof client?.execute !== "function" || typeof client?.beginTransaction !== "function") {
      throw new TypeError("PolicySqlDialect requires a PolicySqlClient");
    }
    if (typeof autoIdempotencyKey !== "boolean") throw new TypeError("autoIdempotencyKey must be a boolean");
    this.#client = client;
    this.#config = Object.freeze({ autoIdempotencyKey });
  }
  createAdapter() { return new PolicySqlAdapter(); }
  createQueryCompiler() { return new PolicySqlQueryCompiler(this.#compiled); }
  createDriver() { return new PolicySqlDriver(this.#client, this.#config, this.#compiled); }
  createIntrospector() { throw new TypeError("PolicySQL database introspection is not supported; use the public Catalog"); }
}
