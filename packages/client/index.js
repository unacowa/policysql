import { PolicySqlTransaction } from "./transaction.js";
import {
  PolicySqlError, PolicySqlOutcomeUnknownError, object, protocolError,
  required, validateKey, statement, validateResult, retryable, unknown,
} from "./protocol.js";
export { PolicySqlError, PolicySqlOutcomeUnknownError };

export class PolicySqlClient {
  #endpoint;
  #headers;
  #expected;
  #fetch;

  constructor({ endpoint, token, role, schemaVersion, policyVersion, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
    const url = new URL(required(endpoint, "endpoint"));
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) || url.username || url.password) {
      throw new TypeError("endpoint must use HTTPS (or HTTP on localhost) without URL credentials");
    }
    required(token, "token");
    if (role !== undefined && (typeof role !== "string" || !/^[a-z][a-z0-9_]*$/.test(role))) {
      throw new TypeError("role must be a valid role identifier");
    }
    if ((schemaVersion === undefined) !== (policyVersion === undefined)) {
      throw new TypeError("schemaVersion and policyVersion must be supplied together");
    }
    if (schemaVersion !== undefined) {
      required(schemaVersion, "schemaVersion");
      required(policyVersion, "policyVersion");
      this.#expected = Object.freeze({ schemaVersion, policyVersion });
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    this.#endpoint = url.href;
    this.#headers = Object.freeze({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(role === undefined ? {} : { "policysql-role": role }),
    });
    // Validate header values before any request is sent.
    new Headers(this.#headers);
    this.#fetch = fetchImpl;
    Object.freeze(this);
  }

  get endpoint() { return this.#endpoint; }
  get role() { return this.#headers["policysql-role"]; }
  get schemaVersion() { return this.#expected?.schemaVersion; }
  get policyVersion() { return this.#expected?.policyVersion; }

  // Each command captures its serialized body before the first attempt. Neither a retry
  // nor changes to application objects can change its authenticated context or payload.
  async #request(path, body, { idempotencyKey, deadline = Date.now() + 5_000, signal } = {}) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PolicySqlError("PolicySQL request timed out.", "POLICYSQL_TRANSPORT_ERROR");
    const controller = new AbortController();
    let timer;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      const stop = () => {
        controller.abort();
        reject(new PolicySqlError("PolicySQL request interrupted.", "POLICYSQL_TRANSPORT_ERROR"));
      };
      timer = setTimeout(stop, remaining);
      onAbort = stop;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const send = async () => {
      let response;
      try {
        response = await this.#fetch(new URL(path, this.#endpoint), {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { ...this.#headers, ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }) },
          body,
        });
      } catch {
        throw new PolicySqlError("PolicySQL transport failed.", "POLICYSQL_TRANSPORT_ERROR");
      }
      let data;
      try { data = await response.json(); } catch { throw protocolError(); }
      if (!response.ok) {
        const code = typeof data?.error?.code === "string" && /^POLICYSQL_[A-Z_]+$/.test(data.error.code)
          ? data.error.code : "POLICYSQL_REQUEST_FAILED";
        throw new PolicySqlError("PolicySQL request failed.", code, response.status);
      }
      if (!object(data)) throw protocolError();
      return data;
    };
    try { return await Promise.race([send(), aborted]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async execute(sql, params = {}, options = {}) {
    if (!object(options) || Object.keys(options).some((key) => !["idempotencyKey", "expect", "signal"].includes(key))) {
      throw new TypeError("invalid execute options");
    }
    const idempotencyKey = validateKey(options.idempotencyKey);
    const body = JSON.stringify({
      ...(this.#expected === undefined ? {} : { expected: this.#expected }),
      statements: [statement(sql, params, options.expect)],
    });
    let response;
    try {
      response = await this.#request("/v1/transactions:execute", body, { idempotencyKey, signal: options.signal });
      if (response.status !== "committed" || !Array.isArray(response.results) || response.results.length !== 1 || !object(response.meta)) {
        throw protocolError();
      }
      validateResult(response.results[0]);
    } catch (error) {
      // No automatic atomic replay. In particular, an unkeyed write must never be retried.
      if (retryable(error)) throw unknown(undefined, "execute");
      throw error;
    }
    return { ...response.results[0], envelopeMeta: response.meta, ...(response.debug ? { debug: response.debug } : {}) };
  }

  async beginTransaction(options = {}) {
    if (!object(options) || Object.keys(options).some((key) => key !== "mode")) throw new TypeError("invalid transaction start options");
    const { mode = "write" } = options;
    if (!["read", "write"].includes(mode)) throw new TypeError("invalid transaction mode");
    const body = JSON.stringify({ mode, ...(this.#expected === undefined ? {} : { expected: this.#expected }) });
    const deadline = Date.now() + 4_000;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.#request("/v1/transactions", body, { deadline });
        if (!/^tx_[a-f0-9]{32}$/.test(response.transactionId) || response.status !== "active" ||
          response.nextSequence !== 1 || typeof response.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(response.expiresAt)) || Date.parse(response.expiresAt) <= Date.now() || !object(response.meta)) {
          throw protocolError();
        }
        return new PolicySqlTransaction(response, mode, (path, payload, options) => this.#request(path, payload, options));
      } catch (error) {
        if (!retryable(error)) throw error;
        // No application SQL has run: a fresh, unkeyed begin is safe. The old owner expires.
        if (attempt === 1 || Date.now() >= deadline) throw unknown(undefined, "begin");
      }
    }
  }
}
