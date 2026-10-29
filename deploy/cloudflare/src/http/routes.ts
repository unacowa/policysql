// The public HTTP routes (spec/openapi.yaml), in one place for the inbound adapter and for
// the one outbound message that names a route: the callback URL a commit-check validator
// receives (ADR 0007).

export const ROUTES = Object.freeze({
  health: "/healthz",
  capabilities: "/v1/capabilities",
  catalog: "/v1/catalog",
  explain: "/v1/transactions:explain",
  execute: "/v1/transactions:execute",
  begin: "/v1/transactions",
  statement: "/v1/transactions/:transactionId/statements",
  commit: "/v1/transactions/:transactionId/commit",
  rollback: "/v1/transactions/:transactionId/rollback",
});

export const TRANSACTION_ID = /^tx_[a-f0-9]{32}$/u;

/** The callback route, matched exactly; `fetchCallback` serves nothing else. */
export const CALLBACK_QUERY_PATH = /^\/v1\/commit-checks\/(cval_[a-f0-9]{32})\/query$/u;

/** The absolute callback URL for one validation, under the deployment's public base URL. */
export const callbackQueryUrl = (publicBaseUrl: URL, validationId: string) =>
  new URL(`/v1/commit-checks/${validationId}/query`, publicBaseUrl).toString();
