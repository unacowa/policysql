// The TransactionOwner port (ADR 0022). Routes and TransactionOwnerCore use only these
// interfaces; a platform adapter (for Cloudflare: src/adapters/durable-objects.ts)
// implements them, and the wrapper supplies that adapter.

import type { OperationError } from "./errors.ts";

/**
 * An owner's answer to one command: the operation's value, or its error (ADR 0023). The
 * engine returns it as the operation result; it carries no transport status. Adapters carry
 * it across their message boundary as data, and the engine checks its shape.
 */
export type OwnerReply = { ok: true; value: unknown } | { ok: false; error: OperationError };

export type OwnerCommandKind = "statement" | "commit" | "rollback";

/** Start of an interactive transaction (`POST /v1/transactions`). */
export type OwnerBeginInput = {
  transactionId: string;
  authFingerprint: string;
  startFingerprint: string;
  mode: "read" | "write";
  auth: unknown;
  expected?: unknown;
  databaseBinding: unknown;
  snapshot: string;
};

/** A statement, commit, or rollback of an open interactive transaction. */
export type OwnerCommandInput = {
  transactionId: string;
  authFingerprint: string;
  command: unknown;
  databaseBinding: unknown;
  snapshot: string;
};

/** An atomic execute that can trigger a commit check (ADR 0007, DO ownership). */
export type OwnerAtomicInput = {
  validationId: string;
  auth: unknown;
  request: string;
  idempotency: { keyHash: string; fingerprint: string } | null;
  databaseBinding: unknown;
  snapshot: string;
};

/** A validator's callback SELECT, with the opaque capability it presented ("" for none). */
export type OwnerCallbackInput = { capability: string; command: unknown };

/**
 * A handle to the single owner of one name. Every input and reply is plain JSON data: an
 * adapter may serialize it, and the owner validates every input as untrusted.
 *
 * Client commands (`begin`, `atomic`, `command`) are processed one at a time, in the order
 * they reach the owner. Callback queries are processed one at a time, in the order they
 * reach the owner, on a second lane, because they arrive while a commit on the first lane
 * waits for its validator.
 *
 * "Reach the owner" means the call on `TransactionOwnerCore`, which queues it synchronously.
 * An adapter that carries calls as messages must queue each message on its lane when it
 * arrives, before reading or decoding it, so a late body never lets a later message overtake
 * an earlier one. Nothing orders calls that are still in transit: two concurrent client
 * requests may reach the owner in either order, and ADR 0007 then fails a conflicting one.
 */
export interface TransactionOwnerHandle {
  begin(input: OwnerBeginInput, requestId: string): Promise<OwnerReply>;
  atomic(input: OwnerAtomicInput, requestId: string): Promise<OwnerReply>;
  command(kind: OwnerCommandKind, input: OwnerCommandInput, requestId: string): Promise<OwnerReply>;
  callbackQuery(input: OwnerCallbackInput, requestId: string): Promise<OwnerReply>;
}

/**
 * Routing: owner name (`tx_` + 32 hex, derived from the transaction or validation id) to
 * the handle of exactly one owner.
 *
 * Guarantees an adapter must keep (the conformance suite checks them):
 * - at most one live owner per name, anywhere, at any time;
 * - every call for a name reaches that owner (one `TransactionOwnerCore` instance);
 * - an owner may be lost (evicted, restarted). Its successor for the same name sees the
 *   same `OwnerStore` contents but none of the lost owner's memory, so an open database
 *   transaction is gone and the core fails it closed (ADR 0007). A lost owner must not
 *   write to the store again.
 */
export interface TransactionOwnerPort {
  route(name: string): TransactionOwnerHandle;
}

/**
 * Durable per-owner key/value state. Values are structured-clone copies.
 *
 * Port obligation (ADR 0022, ADR 0024 "State integrity"): an owner's store is readable and
 * writable only by the live owner of that name, through the adapter. Core validates the
 * stored transaction state for shape, version, bounds, owner name, and consistency, and does
 * not authenticate it, so an adapter must never expose the store to anything else (another
 * name, another tenant, a client). The Durable Objects adapter keeps it with storage that only
 * the object can reach.
 */
export interface OwnerStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** One timer per owner. A later `schedule` replaces the earlier one; at the time, the
 * adapter calls `TransactionOwnerCore.onTimer()` on the live owner for that name. */
export interface OwnerTimer {
  schedule(atMs: number): Promise<void>;
}

/** Work that continues after a reply was sent (cost observation). Never rejects the caller. */
export interface BackgroundTasks {
  run(task: Promise<unknown>): void;
}

/** What the adapter injects into each `TransactionOwnerCore` it creates. */
export type OwnerFacilities = {
  store: OwnerStore;
  timer: OwnerTimer;
  background: BackgroundTasks;
};

export const OWNER_NAME = /^tx_[a-f0-9]{32}$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");

const hasMethods = (value: unknown, names: string[]) =>
  isObject(value) && names.every((name) => typeof value[name] === "function");

const ERROR_CODE = /^POLICYSQL_[A-Z0-9_]+$/u;

/**
 * Checks a reply that crossed an adapter boundary. Anything that is not exactly a value or
 * a well-formed error is null, which the engine treats as an internal failure.
 */
export const checkedOwnerReply = (reply: unknown): OwnerReply | null => {
  if (!isObject(reply) || typeof reply === "function" || Object.keys(reply).length !== 2) return null;
  if (reply.ok === true && Object.hasOwn(reply, "value")) return { ok: true, value: reply.value };
  const error = reply.error;
  if (reply.ok === false && isObject(error) &&
    typeof error.code === "string" && ERROR_CODE.test(error.code) &&
    typeof error.message === "string" && (error.path === null || typeof error.path === "string")) {
    return { ok: false, error: { code: error.code, message: error.message, path: error.path as string | null } };
  }
  return null;
};

export const validateTransactionOwnerPort = (port: unknown): TransactionOwnerPort => {
  if (!hasMethods(port, ["route"])) {
    throw new TypeError("transactionOwners is required: a TransactionOwnerPort with route(name)");
  }
  return port as TransactionOwnerPort;
};

export const isOwnerHandle = (handle: unknown): handle is TransactionOwnerHandle =>
  hasMethods(handle, ["begin", "atomic", "command", "callbackQuery"]);

export const validateBackgroundTasks = (background: unknown): BackgroundTasks | undefined => {
  if (background === undefined) return undefined;
  if (!hasMethods(background, ["run"])) throw new TypeError("background must be BackgroundTasks with run(task)");
  return background as BackgroundTasks;
};

export const validateOwnerFacilities = (facilities: unknown): OwnerFacilities => {
  if (!isObject(facilities) || !hasMethods(facilities.store, ["get", "put"]) ||
    !hasMethods(facilities.timer, ["schedule"]) || !hasMethods(facilities.background, ["run"])) {
    throw new TypeError("owner facilities are required: { store: { get, put }, timer: { schedule }, background: { run } }");
  }
  return facilities as OwnerFacilities;
};

/**
 * Hands a task to `background`, or lets it run detached without one. A failing
 * `BackgroundTasks` is logged and never turns a completed operation into an error.
 */
export const runInBackground = (background: BackgroundTasks | undefined, task: Promise<unknown>, requestId: string) => {
  const settled = task.catch(() => undefined);
  if (!background) return;
  try {
    background.run(settled);
  } catch (error) {
    console.log(JSON.stringify({
      event: "background_task_rejected", requestId,
      errorClass: (error as { constructor?: { name?: string } })?.constructor?.name ?? "UnknownError",
    }));
  }
};
