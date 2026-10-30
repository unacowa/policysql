// Request identities, fingerprints, and command digests, as core computes them (ADR 0024 pull
// request 2, ADR 0025). Core's canonical JSON and SHA-256 are the only definition: the engine
// and the owner use `identity_json`'s result and compute no hash of their own. Core also checks
// the client's `Idempotency-Key` syntax (POLICYSQL_IDEMPOTENCY_KEY_INVALID).
import { internalError, wasmError } from "./errors.ts";
import type { DatabaseBinding } from "./database.ts";
import type { AuthContext } from "./types.ts";

export type IdentityRuntime = { identity_json(inputJson: string): string };
export type Idempotency = { keyHash: string; fingerprint: string };

const HASH = /^[a-f0-9]{64}$/u;

const hash = (value: unknown): string => {
  if (typeof value !== "string" || !HASH.test(value)) throw internalError();
  return value;
};

/** Core's result for `input`, or its error thrown; anything malformed is POLICYSQL_INTERNAL. */
const fromCore = <T>(runtime: IdentityRuntime, input: unknown, read: (result: any) => T): T => {
  let result;
  try {
    result = JSON.parse(runtime.identity_json(JSON.stringify(input)));
  } catch {
    throw internalError();
  }
  const error = wasmError(result);
  if (error) throw error;
  return read(result);
};

// The client's key as core reads it: absent when the caller sent none, a string as is, and
// anything else as `null`, which core rejects with POLICYSQL_IDEMPOTENCY_KEY_INVALID. A
// transport that can repeat a field (HTTP joins repeated headers with a comma) passes the
// joined value, which never matches the key syntax.
const keyMember = (key: unknown) => key === undefined ? {} : { key: typeof key === "string" ? key : null };

/**
 * `{ keyHash, fingerprint }` of a request with an optional idempotency key, or null without
 * one. `bodyText` is the exact text the engine parsed.
 */
export const requestIdentity = (runtime: IdentityRuntime, input: {
  key: unknown;
  auth: AuthContext;
  bodyText: string;
  endpoint: "execute" | "interactive-start";
  databaseBinding: DatabaseBinding;
}): Idempotency | null => fromCore(runtime, {
  op: "request", endpoint: input.endpoint, auth: input.auth, binding: input.databaseBinding, body: input.bodyText,
  ...keyMember(input.key),
}, (result) => {
  if (result?.idempotency === null) return null;
  return { keyHash: hash(result?.idempotency?.keyHash), fingerprint: hash(result?.idempotency?.fingerprint) };
});

/** The interactive transaction's caller fingerprint (session identity and full binding). */
export const authIdentity = (runtime: IdentityRuntime, auth: AuthContext, databaseBinding: DatabaseBinding): string =>
  fromCore(runtime, { op: "auth", auth, binding: databaseBinding }, (result) => hash(result?.fingerprint));

/** The start fingerprint of an unkeyed begin. */
export const startDigest = (runtime: IdentityRuntime, transactionId: string, bodyText: string): string =>
  fromCore(runtime, { op: "start", transactionId, body: bodyText }, (result) => hash(result?.digest));

/**
 * The digest of an interactive command, which an exact retry must repeat. The owner holds the
 * command as a value, so core reads its `JSON.stringify` text.
 */
export const commandDigest = (runtime: IdentityRuntime, kind: "statement" | "commit" | "rollback", command: unknown): string =>
  fromCore(runtime, { op: "command", kind, command }, (result) => hash(result?.digest));

/** The digest of a callback query, which an exact retry must repeat. */
export const callbackDigest = (runtime: IdentityRuntime, command: unknown): string =>
  fromCore(runtime, { op: "callback", command }, (result) => hash(result?.digest));
