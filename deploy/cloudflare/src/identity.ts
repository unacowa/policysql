// Request identities, fingerprints, and command digests, computed by core (ADR 0024 pull
// request 2) and checked against the TypeScript reference in `idempotency.ts`.
//
// Core canonicalizes from the body text with its own tokenizer (`identity_json`), and its
// result is the one the engine uses. Until ADR 0024 pull request 9 deletes `idempotency.ts`,
// every computation also runs there, and the two outcomes are compared before any database
// work: equal values (or the same error code) proceed with core's; anything else logs
// `identity_mismatch` without values and fails with POLICYSQL_INTERNAL, which a client treats
// as an uncertain outcome. A mismatch is therefore an availability fault, never a wrong retry
// decision (a false IDEMPOTENCY_CONFLICT, or a committed keyed request executed again).
import { EngineError, internalError, wasmError } from "./errors.ts";
import { requestIdempotency, authFingerprint, sha256, stableJson } from "./idempotency.ts";
import type { DatabaseBinding } from "./database.ts";
import type { AuthContext } from "./types.ts";

export type IdentityRuntime = { identity_json(inputJson: string): string };
export type Idempotency = { keyHash: string; fingerprint: string };
export type IdentityComputation = "request" | "auth" | "start" | "command" | "callback";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: EngineError };

const HASH = /^[a-f0-9]{64}$/u;

const hash = (value: unknown): string => {
  if (typeof value !== "string" || !HASH.test(value)) throw internalError();
  return value;
};

const asEngineError = (error: unknown): EngineError => error instanceof EngineError ? error : internalError();

const errorOf = <T>(outcome: Outcome<T>): EngineError | null =>
  outcome.ok ? null : (outcome as { error: EngineError }).error;

const fromCore = <T>(runtime: IdentityRuntime, input: unknown, read: (result: any) => T): Outcome<T> => {
  try {
    const result = JSON.parse(runtime.identity_json(JSON.stringify(input)));
    const error = wasmError(result);
    return error ? { ok: false, error } : { ok: true, value: read(result) };
  } catch (error) {
    return { ok: false, error: asEngineError(error) };
  }
};

const fromReference = async <T>(compute: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await compute() };
  } catch (error) {
    return { ok: false, error: asEngineError(error) };
  }
};

/** Both outcomes computed; core's returned (or thrown) when they agree, POLICYSQL_INTERNAL otherwise. */
const gate = async <T>(
  computation: IdentityComputation,
  requestId: string | undefined,
  core: () => Outcome<T>,
  reference: () => Promise<T>,
): Promise<T> => {
  const primary = core();
  const secondary = await fromReference(reference);
  const primaryError = errorOf(primary);
  const secondaryError = errorOf(secondary);
  const same = primary.ok && secondary.ok
    ? JSON.stringify(primary.value) === JSON.stringify(secondary.value)
    : primaryError !== null && secondaryError !== null && primaryError.code === secondaryError.code;
  if (!same) {
    console.log(JSON.stringify({
      event: "identity_mismatch",
      computation,
      requestId: requestId ?? null,
      core: primary.ok ? "value" : "error",
      reference: secondary.ok ? "value" : "error",
    }));
    throw internalError();
  }
  if (primaryError !== null) throw primaryError;
  return (primary as { value: T }).value;
};

// The client's key as core reads it: absent when the caller sent none, a string as is, and
// anything else as `null`, which core rejects as the reference does (`typeof key !== "string"`).
const keyMember = (key: unknown) => key === undefined ? {} : { key: typeof key === "string" ? key : null };

/**
 * `{ keyHash, fingerprint }` of a request with an optional idempotency key, or null without
 * one. `bodyText` is the exact text whose parse is `body`.
 */
export const requestIdentity = (runtime: IdentityRuntime, input: {
  key: unknown;
  auth: AuthContext;
  bodyText: string;
  body: unknown;
  endpoint: "execute" | "interactive-start";
  databaseBinding: DatabaseBinding;
  requestId?: string;
}): Promise<Idempotency | null> => gate(
  "request",
  input.requestId,
  () => fromCore(runtime, {
    op: "request", endpoint: input.endpoint, auth: input.auth, binding: input.databaseBinding, body: input.bodyText,
    ...keyMember(input.key),
  }, (result) => {
    if (result?.idempotency === null) return null;
    return { keyHash: hash(result?.idempotency?.keyHash), fingerprint: hash(result?.idempotency?.fingerprint) };
  }),
  async () => {
    const value = await requestIdempotency(input.key, input.auth, input.body, input.endpoint, input.databaseBinding);
    return value === null ? null : { keyHash: value.keyHash, fingerprint: value.fingerprint };
  },
);

/** The interactive transaction's caller fingerprint (session identity and full binding). */
export const authIdentity = (
  runtime: IdentityRuntime, auth: AuthContext, databaseBinding: DatabaseBinding, requestId?: string,
): Promise<string> => gate(
  "auth",
  requestId,
  () => fromCore(runtime, { op: "auth", auth, binding: databaseBinding }, (result) => hash(result?.fingerprint)),
  () => authFingerprint(auth, databaseBinding),
);

/** The start fingerprint of an unkeyed begin. */
export const startDigest = (
  runtime: IdentityRuntime, transactionId: string, bodyText: string, body: unknown, requestId?: string,
): Promise<string> => gate(
  "start",
  requestId,
  () => fromCore(runtime, { op: "start", transactionId, body: bodyText }, (result) => hash(result?.digest)),
  () => sha256(stableJson({ transactionId, request: body })),
);

/**
 * The digest of an interactive command, which an exact retry must repeat. The owner holds the
 * command as a value, so core reads its `JSON.stringify` text, which escapes lone surrogates.
 */
export const commandDigest = (
  runtime: IdentityRuntime, kind: "statement" | "commit" | "rollback", command: unknown, requestId?: string,
): Promise<string> => gate(
  "command",
  requestId,
  () => fromCore(runtime, { op: "command", kind, command }, (result) => hash(result?.digest)),
  () => sha256(stableJson({ kind, command })),
);

/** The digest of a callback query, which an exact retry must repeat. */
export const callbackDigest = (runtime: IdentityRuntime, command: unknown, requestId?: string): Promise<string> => gate(
  "callback",
  requestId,
  () => fromCore(runtime, { op: "callback", command }, (result) => hash(result?.digest)),
  () => sha256(stableJson(command)),
);
