import { SqliteAdapter, SqliteQueryCompiler } from "kysely";
import { PolicySqlDriver } from "./driver.js";
import { extractOptions } from "./options.js";
export { policyOptions } from "./options.js";

class PolicySqlQueryCompiler extends SqliteQueryCompiler {
  getCurrentParameterPlaceholder() { return `:p${this.numParameters}`; }
  compileQuery(root, queryId) {
    const { node } = extractOptions(root);
    // Keep options on the public AST; copying a CompiledQuery preserves them.
    // Only the cleaned tree is emitted as SQL. Client snapshots values at submission.
    return Object.freeze({ ...super.compileQuery(node, queryId), query: root });
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
  constructor({ client, autoIdempotencyKey = false }) {
    if (typeof client?.execute !== "function" || typeof client?.beginTransaction !== "function") {
      throw new TypeError("PolicySqlDialect requires a PolicySqlClient");
    }
    if (typeof autoIdempotencyKey !== "boolean") throw new TypeError("autoIdempotencyKey must be a boolean");
    this.#client = client;
    this.#config = Object.freeze({ autoIdempotencyKey });
  }
  createAdapter() { return new PolicySqlAdapter(); }
  createQueryCompiler() { return new PolicySqlQueryCompiler(); }
  createDriver() { return new PolicySqlDriver(this.#client, this.#config); }
  createIntrospector() { throw new TypeError("PolicySQL database introspection is not supported; use the public Catalog"); }
}
