import { PolicySqlTransaction } from "./transaction.js";
import {
  object, protocolError, required, validateKey, statement, validateResult,
  validateRole, validateOptions, sendCommand,
} from "./protocol.js";
export { PolicySqlError, PolicySqlOutcomeUnknownError } from "./protocol.js";
export { createHttpTransport } from "./http.js";

export class PolicySqlClient {
  #transport;
  #role;
  #expected;

  constructor(options) {
    validateOptions(options, ["transport", "role", "schemaVersion", "policyVersion"]);
    const { transport, role, schemaVersion, policyVersion } = options;
    if (typeof transport !== "function") throw new TypeError("transport must be a function");
    this.#role = validateRole(role);
    if ((schemaVersion === undefined) !== (policyVersion === undefined)) {
      throw new TypeError("schemaVersion and policyVersion must be supplied together");
    }
    if (schemaVersion !== undefined) {
      this.#expected = Object.freeze({
        schemaVersion: required(schemaVersion, "schemaVersion"),
        policyVersion: required(policyVersion, "policyVersion"),
      });
    }
    this.#transport = transport;
    Object.freeze(this);
  }

  get role() { return this.#role; }
  get schemaVersion() { return this.#expected?.schemaVersion; }
  get policyVersion() { return this.#expected?.policyVersion; }

  #request(kind, body, extra = {}) {
    return Object.freeze({ kind, body, ...(this.#role === undefined ? {} : { role: this.#role }), ...extra });
  }

  async execute(sql, params = {}, options = {}) {
    validateOptions(options, ["idempotencyKey", "expect", "signal"]);
    const idempotencyKey = validateKey(options.idempotencyKey);
    const body = JSON.stringify({
      ...(this.#expected === undefined ? {} : { expected: this.#expected }),
      statements: [statement(sql, params, options.expect)],
    });
    const request = this.#request("execute", body, idempotencyKey === undefined ? {} : { idempotencyKey });
    const response = await sendCommand(this.#transport, request, { phase: "execute" }, (response) => {
      if (response.status !== "committed" || !Array.isArray(response.results) || response.results.length !== 1 || !object(response.meta)) throw protocolError();
      validateResult(response.results[0]);
    }, options.signal);
    return { ...response.results[0], envelopeMeta: response.meta, ...(response.debug === undefined ? {} : { debug: response.debug }) };
  }

  async beginTransaction(options = {}) {
    validateOptions(options, ["mode", "signal"]);
    const { mode = "write", signal } = options;
    if (!["read", "write"].includes(mode)) throw new TypeError("invalid transaction mode");
    const body = JSON.stringify({ mode, ...(this.#expected === undefined ? {} : { expected: this.#expected }) });
    const response = await sendCommand(this.#transport, this.#request("begin", body), { phase: "begin" }, (response) => {
      if (typeof response.transactionId !== "string" || !/^tx_[a-f0-9]{32}$/.test(response.transactionId) || response.status !== "active" ||
        response.nextSequence !== 1 || typeof response.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(response.expiresAt)) || !object(response.meta)) throw protocolError();
    }, signal);
    return new PolicySqlTransaction(response, mode, this.#transport, this.#role);
  }
}
