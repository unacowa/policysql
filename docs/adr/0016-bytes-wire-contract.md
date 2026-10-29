# ADR 0016: Deployment-independent bytes wire contract

- Status: accepted
- Issue: #17

## Decision

The public descriptor is `type: bytes`, `representation: string`, `format: base64`.
Parameters and SELECT/RETURNING result cells use canonical RFC 4648 standard base64:
the `+/` alphabet, required padding for incomplete groups, zero unused bits, and no
whitespace. Empty bytes are `""`. A nullable bytes result cell uses JSON `null` for
SQL NULL. JSON `null` for a bytes client parameter follows the same rule as every
other logical type ([ADR 0017](0017-nullable-assignments.md), #20): it binds SQL
NULL only when every use is a direct assignment to a nullable column, Explain
reports exactly that as the parameter's `nullable`, and any other JSON `null` is
rejected with `POLICYSQL_INVALID_PARAMETER`. Arrays and database-driver objects are not alternative
public bytes encodings.

The compiler resolves SQL parameter uses against the immutable Catalog before
decoding. A normal string or JSON value is never interpreted as bytes based on its
contents. Reusing one parameter with incompatible logical types is rejected.
Row/column authorization, independent RETURNING permission, server parameter
ownership, emission verification and transaction checks retain their existing rules.

The Client, Kysely adapter and generator use this same public representation through
their injected Transport, independently of the server's hosting platform. They do
not import Cloudflare, WASM or database-driver codecs. An application may explicitly
encode/decode binary buffers; the JSON contract and metadata remain unchanged.

The SQLite/Turso profile binds bytes as physical BLOB. The result boundary must
retain physical BLOB identity: a TEXT cell containing valid base64 is a schema
mismatch. Raw database objects cannot impersonate the adapter's typed BLOB value.
Missing cells and non-finite numbers cannot be converted to nullable bytes NULL.

INSERT and UPDATE presets may use a fixed base64 literal, for example
`seed: { literal: "AAEC/w==" }`, when the Catalog column is bytes. Policy activation
validates it using the same codec. The emitter binds it in the server-owned namespace.
Client assignment to the preset column remains forbidden. This extension does not
permit bytes-valued session coercion, bytes literal policy comparisons, NULL presets,
public BLOB literals or `CAST(... AS BLOB)`.

## Bounds and failures

The initial profile limits each decoded bytes value to 262,144 bytes (256 KiB), for
client parameters, presets and physical results. Capabilities exposes this as
`limits.maxBytesPerValue`; Clients must not hard-code a hosting platform's limits.
Codecs validate the complete alphabet, padding and unused bits before classifying
size, then check the decoded length before allocating the decoded payload. Existing
request-body, statement, time, row, result and transaction limits apply independently.

The public base64 length is `4 * ceil(decoded_bytes / 3)`. Encoded result rows count
toward the atomic result budget; interactive and callback paths also count their
result metadata in their existing cumulative budgets. The default Cloudflare result
budget remains 64,000 bytes, so less than 48,000 raw bytes fit in one returned result
envelope after JSON overhead. A permitted write value may be too large to RETURNING.
Any result or cumulative-limit failure before commit rolls back the mutation.
Fixed internal result bounds are result limits too: a statement result over the
private WASM result ABI bound (1 MiB of raw result JSON) or a statement response
over the Turso HTTP transport bound (2 MiB) uses `POLICYSQL_LIMIT_EXCEEDED` (413),
even when every value is within the per-value limit. Oversized `BEGIN`, `COMMIT` or
`ROLLBACK` responses and non-success HTTP responses remain transport failures (503),
because they are not result data and a commit outcome is never reported as a limit.

Malformed bytes parameters use `POLICYSQL_INVALID_PARAMETER` (400) regardless of
their length; only well-formed input whose decoded size exceeds the per-value limit
uses `POLICYSQL_LIMIT_EXCEEDED` (413).

A well-formed physical BLOB over the per-value limit also uses
`POLICYSQL_LIMIT_EXCEEDED` (413) and rolls back the transaction. This matches the
existing category for result row/byte limits: the condition is permanent for that
stored row, so it is neither a retryable `POLICYSQL_DATABASE_UNAVAILABLE` (503) nor a
Catalog contract mismatch (422). Both Cloudflare database transports (the Turso
HTTP adapter and the `@tursodatabase/serverless` driver path) classify it before
calling WASM; the private WASM result boundary and the `policysql-turso` adapter
independently apply the same category rather than trusting the host. Other physical
value or encoding mismatches fail closed with a safe schema/transport error:
malformed typed BLOB encoding in a Hrana response remains a transport failure (503),
and wrong physical types remain `POLICYSQL_SCHEMA_MISMATCH` (422). Existing error
categories for transaction limits and authorization remain in force.

## Adapter and release contract

The Cloudflare private WASM ABI is version 2. Only internal bytes values use
`{ "type": "blob", "base64": "..." }`; validated public results use strings.
The adapter converts those tagged parameters to `Uint8Array` for both client and
server values, including cost queries, and tags only actual binary driver results.
Rust performs result-contract validation before public encoding. This private
format is not an extension of the public parameter schema.

The Turso HTTP adapter accepts either canonical padded base64 or its fully unpadded
form in a typed database BLOB response. Hrana's
[BLOB serializer](https://github.com/tursodatabase/libsql/blob/d8bc862d20bedc72945a1da27c8b7045414c0261/libsql-hrana/src/proto.rs#L641-L649)
uses the unpadded form. Within the bounded HTTP response, the adapter adds missing
padding, validates the standard alphabet and zero unused bits, then checks the
decoded limit before allocating the decoded payload.
Partial or excessive padding, whitespace and base64url remain invalid. This exception
is confined to database responses; public inputs and the private WASM ABI remain
strictly canonical. Public SELECT/RETURNING cells always use canonical padded base64,
so a returned bytes value can be submitted unchanged as a bytes parameter.

WASM and its adapter are distributed together. The ABI version participates in the
snapshot, so active transactions and bindings from ABI 1 must be recreated. No new
public API version or alternate Client mode is introduced.

The per-value limit has a single source, `policysql_core::bytes::MAX_BYTES_PER_VALUE`,
exposed to the host as `PolicySqlRuntime.max_bytes_per_value` (#22). The TypeScript
adapter keeps no copy: Capabilities, WASM-parameter decoding (including cost
queries), driver-result classification and the Turso HTTP transport all take the
limit from the loaded runtime. PolicySQL passes it to every database transport as
`begin(..., { maxBytesPerValue })`, and PolicySQL still classifies size with the
runtime value before WASM. The Turso HTTP transport and the private codec have no
unbounded mode: an omitted, infinite or malformed limit fails closed with a
`TypeError` before any database request. Runtime construction rejects a missing or
malformed limit, so changing only the Rust constant changes every boundary together and cannot
turn valid WASM output into `POLICYSQL_INTERNAL`.

Shared byte vectors, native Rust boundary tests, Client-only Transport tests and
real-WASM/JWT/HTTP/SQLite tests cover the contract, policy bypasses, physical BLOB/hash
equality, limits, rollback and replay. Local SQLite-backed transport evidence does
not establish real Cloudflare/Turso deployment conformance.
