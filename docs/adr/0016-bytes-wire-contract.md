# ADR 0016: Deployment-independent bytes wire contract

- Status: accepted
- Issue: #17

## Decision

The public descriptor is `type: bytes`, `representation: string`, `format: base64`.
Parameters and SELECT/RETURNING result cells use canonical RFC 4648 standard base64:
the `+/` alphabet, required padding for incomplete groups, zero unused bits, and no
whitespace. Empty bytes are `""`; nullable bytes use JSON `null` for SQL NULL.
Arrays and database-driver objects are not alternative public bytes encodings.

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
Input codecs check the decoded length before allocation. Existing request-body,
statement, time, row, result and transaction limits apply independently.

The public base64 length is `4 * ceil(decoded_bytes / 3)`. Encoded result rows count
toward the atomic result budget; interactive and callback paths also count their
result metadata in their existing cumulative budgets. The default Cloudflare result
budget remains 64,000 bytes, so less than 48,000 raw bytes fit in one returned result
envelope after JSON overhead. A permitted write value may be too large to RETURNING.
Any result or cumulative-limit failure before commit rolls back the mutation.

Malformed bytes parameters use `POLICYSQL_INVALID_PARAMETER` (400); decoded input
over the per-value limit uses `POLICYSQL_LIMIT_EXCEEDED` (413). Physical value or
encoding mismatches fail closed with a safe schema/transport error. Existing error
categories for result limits, transaction limits and authorization remain in force.

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
uses the unpadded form. The adapter bounds the encoded length before adding missing
padding, then validates the standard alphabet, zero unused bits and decoded limit.
Partial or excessive padding, whitespace and base64url remain invalid. This exception
is confined to database responses; public inputs and the private WASM ABI remain
strictly canonical. Public SELECT/RETURNING cells always use canonical padded base64,
so a returned bytes value can be submitted unchanged as a bytes parameter.

WASM and its adapter are distributed together. The ABI version participates in the
snapshot, so active transactions and bindings from ABI 1 must be recreated. No new
public API version or alternate Client mode is introduced.

Shared byte vectors, native Rust boundary tests, Client-only Transport tests and
real-WASM/JWT/HTTP/SQLite tests cover the contract, policy bypasses, physical BLOB/hash
equality, limits, rollback and replay. Local SQLite-backed transport evidence does
not establish real Cloudflare/Turso deployment conformance.
