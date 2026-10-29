import { required, validateKey, validateOptions, validateRole } from "./protocol.js";

const routes = Object.freeze({
  execute: ["POST", "/v1/transactions:execute"],
  explain: ["POST", "/v1/transactions:explain"],
  begin: ["POST", "/v1/transactions"],
  catalog: ["GET", "/v1/catalog"],
  capabilities: ["GET", "/v1/capabilities"],
});

// Uses redirect: "error", so it targets browsers and Node and is not meant to run
// inside a Cloudflare Worker (workerd rejects that mode with a TypeError).
export const createHttpTransport = (options) => {
  validateOptions(options, ["endpoint", "fetchImpl"]);
  const url = new URL(required(options.endpoint, "endpoint"));
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) || url.username || url.password) {
    throw new TypeError("endpoint must use HTTPS (or HTTP on localhost) without URL credentials");
  }
  const endpoint = url.href;
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch?.bind(globalThis) : options.fetchImpl;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  return async (request, { signal } = {}) => {
    signal?.throwIfAborted();
    const kind = request?.kind;
    let route;
    if (["statement", "commit", "rollback"].includes(kind)) {
      validateOptions(request, ["kind", "role", "body", "transactionId"]);
      if (typeof request.transactionId !== "string" || !/^tx_[a-f0-9]{32}$/.test(request.transactionId)) throw new TypeError("invalid transactionId");
      route = ["POST", `/v1/transactions/${request.transactionId}/${kind === "statement" ? "statements" : kind}`];
    } else if (Object.hasOwn(routes, kind)) {
      route = routes[kind];
      validateOptions(request, ["kind", "role", ...(route[0] === "POST" ? ["body"] : []), ...(kind === "execute" ? ["idempotencyKey"] : [])]);
    } else { throw new TypeError("invalid Transport request kind"); }
    const [method, path] = route;
    const role = validateRole(request.role);
    const key = validateKey(request.idempotencyKey);
    const body = method === "POST" ? required(request.body, "body") : undefined;
    const headers = new Headers({
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(role === undefined ? {} : { "policysql-role": role }),
      ...(key === undefined ? {} : { "idempotency-key": key }),
    });
    const response = await fetchImpl(new URL(path, endpoint), {
      method, headers, body, signal, redirect: "error", credentials: "omit",
    });
    return { status: response.status, body: await response.json() };
  };
};
