# ADR 0015: Explicit client transports and outcome-preserving cleanup

- Status: accepted
- Specification: GitHub issue #8; design: #12.

## Decision

The protocol client requires an injected transport. Endpoint, JWT, provider, fetch,
communication deadlines and abort controllers belong to transports. Role and paired
snapshot preconditions are optional client inputs. All client communication uses the
injected transport.

A scope pins context across a transaction. An operation owns the finite budget for
one command's automatic attempts. Explicit pending recovery creates another operation
without replacing the saved command or its uncertain history. Statement recovery is
limited by the server's expiresAt. A previously sent terminal command may be confirmed
after that live deadline using the server's retained response. The client never replays
the application callback or moves pending work to another transaction.

Transport replies distinguish server responses from transport failures. Unsent evidence
applies only to the current attempt; it cannot erase an earlier unknown commit. Unknown
exceptions, invalid replies and potentially sent cancellations are handled conservatively.
The server remains responsible for authentication, authorization, binding and snapshot.

Operation and scope release are local cleanup. Internal release errors cannot replace
a validated result or the original execution error. This rule does not suppress SQL
commit/rollback failures or application observer errors. The application owns shared
transports; destroying one Driver does not dispose its peers' transport.

The bundled HTTP transport and MessagePort bridge implement the same contract. The
bridge transfers plain commands and normalized replies, never credentials or callbacks.
Authentication services, worker placement and bootstrap are application concerns.

## Consequences

- Client constructors require an explicit transport.
- Automatic retries share a deadline. Manual recovery receives a new finite budget.
- A server live deadline is not evidence that a remote commit failed or rolled back.
- Custom transports must implement finite completion; the client does not compensate
  for a nonconforming transport with an independent outer communication timeout.
- Client, Kysely, generator, public types and examples use the same injected boundary.
- Tests distinguish local fixtures, real MessagePorts, worker threads and the local
  gateway/JWT/Wasm/SQLite harness from live browser or Cloudflare/Turso acceptance.
