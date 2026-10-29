# ADR 0020: Trusted session input and the JWT identity adapter

- Status: accepted
- Issue: #33 (stage 1 of [ADR 0019](0019-library-layers-and-the-wrapper-boundary.md))
- Supersedes: the JWT verification parts of
  [ADR 0005](0005-jwt-and-trusted-session-contract.md)

## Context

ADR 0005 fixed both the trusted-session rules and the JWT that carries them, and the
library verified the JWT itself. ADR 0019 assigns credential verification to the wrapper:
which identity provider, which keys, and which claim layout are deployment knowledge.
Session shape was also validated twice, in TypeScript `auth.ts` and in Rust
`activate_auth`, and idempotency and the interactive-transaction fingerprint depended on
`POLICYSQL_JWT_ISSUER`.

## Decision

### Input contract (library)

The wrapper authenticates the caller and passes the result per request:

Superseded in form by [ADR 0022](0022-transaction-owner-port.md): the request context is
unchanged, but `createApp().fetch(request, { database, session, requestId? }, background?)`
takes no `env` or `ExecutionContext`; the Workers entry
`createPolicySqlWorker().app.fetch(request, env, executionContext, context)` keeps the form
below. The block records the state this ADR left.

```ts
app.fetch(request, env, executionContext, { database, session, requestId? })

type TrustedSession = {
  principal: string;   // opaque, wrapper-namespaced, unambiguous stable identity
  subject: string;     // becomes the reserved `subject_id` session value
  roles: string[];
  defaultRole: string;
  access: ("catalog" | "explain" | "execute" | "debug")[];
  session: Record<string, string>;
};
```

`fetchCallback` is unchanged and takes no session. A missing or null `database` fails with
500 `POLICYSQL_DATABASE_REQUIRED`. Any other key in the context object, or a `requestId`
that is not 1-128 printable ASCII characters, fails with 500 `POLICYSQL_INTERNAL`.

### One rule set in core

`PolicySqlRuntime.authorize_session_json(sessionJson, requestedRole, requiredAccess)` is
the only implementation of the ADR 0005 session rules. In order, it checks that all six
fields are present with the right JSON types and no others, `principal` and `subject` are
non-empty, `roles` is a non-empty set of `^[a-z][a-z0-9_]*$` identifiers, `defaultRole`
is in `roles`, `access` is a non-empty set of known scopes, and session keys are
identifiers other than `subject_id` and `role`. Only then does it select the role
(`PolicySQL-Role`, or `defaultRole` when absent) and check the endpoint's access. It
returns the canonical result `{ principal, subject, role, roles, access, session }`.
`compile_json` and `catalog_json` accept only that canonical result and re-enter the same
function, so there is no second rule set.

The engine reads the `PolicySQL-Role` header (a repeated header, which arrives joined with
a comma, is 400 `POLICYSQL_INVALID_REQUEST`) and calls core before it reads the body, looks
up a transaction owner, or checks or connects to a database.

| Condition | Result |
| --- | --- |
| Session missing, wrong type, unknown or missing field, reserved key, bad identifier, `defaultRole` not in `roles`, unknown or duplicate access | 500 `POLICYSQL_INTERNAL` (wrapper fault), structured log `trusted_session_rejected` with the faulty part only, never a value |
| `PolicySQL-Role` not in `roles`, or required access missing | 403 `POLICYSQL_FORBIDDEN_ACCESS` (client-caused) |
| Credential missing, invalid, expired, or revoked | Returned by the wrapper, typically 401 `POLICYSQL_UNAUTHENTICATED`; the library never returns 401 |

Both 401 codes are wrapper-returned and built with `createErrorResponse`; the library emits
neither. `POLICYSQL_UNAUTHENTICATED` is the wrapper's 401 for a missing or invalid
credential, and the only 401 code the reference wrapper and the JWT adapter use.
`POLICYSQL_AUTHENTICATION_FAILED` is reserved: no shipped code emits it. It stays in the
public contract (and in the client's 401 rejection table, which treats both codes the same:
the request was not executed) so that a custom wrapper may use it for a credential that is
present but failed verification (bad signature, expired, revoked), to distinguish it from a
missing credential.
Clients must handle both codes identically.

### Identity in idempotency and transactions

The idempotency key identity is `{ principal, subject, role, session, endpoint, database }`,
and the interactive-transaction fingerprint is
`{ principal, subject, role, session, databaseBinding }`. Two callers with equal subject,
role, and session values but different principals cannot replay each other's keys or
continue each other's transactions.

### JWT identity adapter (optional, wrapper-side)

The library exports `createJwtSessionVerifier({ jwks?, jwksUrl?, issuer, audience })`,
which returns `(request) => Promise<TrustedSession>` and rejects with
`JwtAuthenticationError` (`status` 401, `code` `POLICYSQL_UNAUTHENTICATED`). Exactly one
of `jwks` (object or JSON text) and `jwksUrl` is required; invalid configuration throws a
`TypeError` at construction. The profile is unchanged from ADR 0005: one issuer and
audience, RS256/ES256, 5 s clock tolerance, required `sub`, `iat`, `exp`, and a
`policysql` object claim `{ roles, default_role, access, session? }`. A single
`Authorization: Bearer` header is required. `principal` is `JSON.stringify([iss, sub])`: a
plain `iss:sub` join would be ambiguous because issuers usually contain `:` (issuer
`https://a.test` with sub `x:y` and issuer `https://a.test:x` with sub `y` would collide),
whereas the JSON array encoding is injective. `jwksUrl` must use `https:`; any other scheme
is a `TypeError` at construction, because keys fetched in plaintext could be replaced in
transit. Remote key sets use a 1.5 s timeout, a 30 s cooldown, and a 5 min cache, so key
removal takes effect within the cache age. The adapter only
translates claims; core validates the result, so a verified token whose claims break the
session rules is a 500 deployment fault rather than a 401.

The engine (routes, middleware, idempotency, transactions) never imports the adapter and
reads no `POLICYSQL_JWT_*` or `POLICYSQL_JWKS_*` setting. The reference wrapper
(`deploy/cloudflare/wrapper/`) and `examples/database-routing/` read those names, verify
after rate limiting and before `app.fetch`, and return 401 through `createErrorResponse`.
`/healthz` stays public and no longer reports identity configuration.

### Wrapper obligations

- Authenticate every client request, including every interactive command and commit. The
  library stores the session fingerprint, not the credential, so stopping a transaction
  after token expiry or revocation is the wrapper's job.
- Encode `principal` unambiguously and namespace it so it cannot collide across identity
  providers or tenants (for example a JSON array of its parts, never a plain `:` join).
- Treat a 500 `POLICYSQL_INTERNAL` with a `trusted_session_rejected` log as a wrapper or
  identity-provider configuration bug.

## Consequences

- Breaking change for embedders: `app.fetch` takes `{ database, session }` instead of a bare
  `DatabaseBinding`; `WorkerBindings` no longer declares JWT settings; the WASM ABI is
  version 3. No compatibility layer (beta, ADR 0019).
- Idempotency keys and open transactions created before this change do not match after it.
- Non-JWT deployments (mTLS, sessions, an upstream gateway) supply a session without the
  adapter.
- Tests pass sessions directly to the library; JWT tests cover the adapter and the two
  wrappers, including expiry and revocation stopping interactive commands and commit.
