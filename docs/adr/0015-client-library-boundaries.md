# ADR 0015: Client library boundaries and explicit recovery

- Status: accepted
- Issue: #15

## Decision

The Client accepts a required function Transport and optional role and paired schema/policy
versions. These settings, and the HTTP helper's endpoint and fetch function, are immutable
for each instance at runtime and in TypeScript. Different configurations use different
instances. Applications keep the logical destination/DB fixed inside injected functions.

The Client, HTTP helper, Kysely adapter and generator depend on the public PolicySQL
protocol and published descriptors. Their interfaces and generated types are independent
of the gateway's hosting platform. Cloudflare Workers, Durable Objects, the private WASM
ABI and database-driver wire formats belong to server adapters. Clients treat transaction
identifiers as protocol values and do not implement owner routing. Hosting-specific limits
must not become hard-coded Client limits; supported SQL and limits follow the configured
backend profile and published Capabilities as described in ADR 0011.

For bytes support (issue #17), `bytes / string / base64` is a common PolicySQL JSON
contract for parameters and results, including SELECT and mutation RETURNING. A Client
must not choose a representation based on whether the server runs on Cloudflare. Any
optional application-side binary codec uses the public descriptor and produces the same
JSON contract through any Transport. Conversion to WASM values, driver-native buffers
and database protocol values is server-adapter work. Public Client packages must not
import deployment modules to perform it. ADR 0016 defines the encoding, validation,
limits and adapter conformance requirements for this contract.

The Transport receives a kind, a serialized JSON body where applicable, role and protocol
identifiers. It performs at most one attempt and returns status and JSON body. The HTTP
helper maps fixed routes, enforces HTTPS (localhost HTTP is allowed), rejects redirects,
omits automatic cookies and parses responses with standard `response.json()`. Authentication,
credential refresh and additional communication size limits belong to application
fetch/Transport implementations. Asynchronous preparation must check cancellation again
before sending.

There are no Client, HTTP helper or observer timers, no shared attempt budgets and no
automatic retries, including begin. Application signals and transport implementations own
communication deadlines. Server transaction limits remain unchanged. The Client exposes
expiresAt as metadata and does not infer expiry or rollback from its local clock.

The Client validates response structure and operation identity. Only documented error
code/status combinations establish rejection; unknown errors, generic server failures,
malformed responses and Transport rejections leave execution outcome unknown. The HTTP
helper preserves underlying exceptions. A command outcome error retains the original
cause. Validated public server errors retain their message and response, including path
and requestId. These are application diagnostics; the library does not log them or promise
that injected function exceptions are suitable for disclosure to an untrusted user.

An unresolved transaction command retains the exact body, role, transaction ID and sequence.
Only explicit retryPending or the same pending terminal operation resends it, once per call.
A later rejection/cancellation does not settle the original uncertainty: the same error
context and original cause survive, and lastError records the most recent confirmation
failure. A confirmed rejection stops this local transaction with status failed; that status
is not a claim that the remote database rolled back. Unknown commits cannot be replaced
by rollback or callback reexecution. An ambiguous begin has no usable transaction handle;
a fresh begin is an explicit new operation and cannot confirm the earlier outcome.

Kysely retains its query, transaction and plugin APIs. CompiledQuery copies retain options
through their public query AST; bound JSON values are not traversed as AST. Client owns
parameter snapshots, response validation and transaction command ordering/state; the Driver
only tracks in-flight communication for shutdown. Server enforces read-only transactions.
onResponse receives a separate response copy and follows ordinary Promise semantics.
Driver destruction stops new work and cancels
only that Driver's work, without closing shared Transports. A validated result survives a
shutdown race. Internal cleanup does not replace execution errors; explicit rollback and
rollback after a callback failure retain their own failures. destroy waits for every
connection and propagates newly initiated cleanup failures, using AggregateError for
multiple failures. Disposal completion is not
proof of a database outcome. An implementation that ignores signals can keep shutdown
pending; the library does not add a timer to override its contract.

Generator discovery and Explain use the same Transport contract. Generated operations
freeze SQL, role and versions, and compare the Client's explicit role and both versions
before execution. Generation saves endpoint metadata, SQL hashes and published discovery
snapshots; all queries must succeed before replacing output. The current Gateway publishes
snapshot/profile/ABI metadata, not separate compiler/registry versions. The generator keeps
published information without inventing missing versions. Applications manage destination,
DB and artifact reuse; opaque function Transports are not introspected.

## Consequences

Legacy Client endpoint/token/fetch options and the token-specific generator CLI are removed.
The CLI loads an application configuration module, and the generator is also a typed package
export. Applications configure authentication and deadlines explicitly. No SQL surface,
server authentication, authorization, DB binding or execution limits change.

ADR 0007's server replay protocol still applies. This decision replaces automatic Client
replay and local deadline behavior. ADR 0010's build workflow and artifact isolation intent
remain; endpoint metadata is application supplied and runtime checks cover immutable SQL,
role and schema/policy versions. ADR 0013 continues to define result metadata.
