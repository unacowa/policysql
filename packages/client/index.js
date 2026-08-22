const required = (value, name) => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
};

export class PolicySqlClient {
  constructor({ endpoint, token, role, schemaVersion, policyVersion, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
    this.endpoint = new URL(required(endpoint, "endpoint"));
    if (this.endpoint.protocol !== "https:" && this.endpoint.hostname !== "localhost") {
      throw new TypeError("endpoint must use HTTPS");
    }
    this.token = required(token, "token");
    this.role = required(role, "role");
    this.schemaVersion = required(schemaVersion, "schemaVersion");
    this.policyVersion = required(policyVersion, "policyVersion");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    this.fetchImpl = fetchImpl;
  }

  async execute(sql, params = {}, options = {}) {
    const response = await this.fetchImpl(new URL("/v1/transactions:execute", this.endpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-policysql-role": this.role,
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        expected: { schemaVersion: this.schemaVersion, policyVersion: this.policyVersion },
        statements: [{ sql, params, ...(options.expect ? { expect: options.expect } : {}) }],
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body?.error?.message ?? "PolicySQL request failed");
      error.code = body?.error?.code;
      error.status = response.status;
      throw error;
    }
    const result = body.results[0];
    return {
      ...result,
      rows: result.rows,
      meta: result.meta,
      envelopeMeta: body.meta,
      ...(body.debug ? { debug: body.debug } : {}),
    };
  }
}
