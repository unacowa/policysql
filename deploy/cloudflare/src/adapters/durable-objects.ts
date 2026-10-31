// Cloudflare Workers outbound adapter for the TransactionOwner and BackgroundTasks ports
// (ADR 0019, ADR 0022). This is the only library module that names Durable Objects or
// `waitUntil`; a structural test enforces that. The wrapper assembles it:
//
//   deployment: (env) => ({ database, config,
//     transactionOwners: durableObjectTransactionOwners(<the wrapper's namespace binding>) }),
//   export const TransactionOwner = durableObjectTransactionOwnerClass(worker.ownerDependencies);
//
// The adapter makes no decisions. Durable Objects give it the port's mechanism guarantees:
// `idFromName` maps one name to one object, the platform runs at most one instance of an
// object at a time, and a restarted instance keeps its storage but none of its memory.
//
// Between the Worker and the object, commands travel as internal HTTP messages
// (`https://owner/<command>`, JSON body, request id header), plus the owner name the Worker
// routed to (`x-policysql-owner`). The body of an interactive command or a callback query is
// the step machine's forwarded owner input without its `kind` (the path names it); the
// callback capability travels in that body. The body of `/atomic` is the machine's forwarded
// atomic input as the engine's `request` step emitted it (`kind: "atomic"` included), and the
// object's reply is the public `execute` response the owner's step decided, which the Worker
// relays.
//
// The wire version guards the message shape. Both sides stamp every message and reply with the
// one constant `OWNER_WIRE_VERSION` (`x-policysql-owner-wire`); a change of any owner wire
// message must change it. A message whose version differs is answered POLICYSQL_INTERNAL (500)
// and runs nothing, so a body of another shape never reaches the machine, which would answer
// 400 POLICYSQL_INVALID_REQUEST, a definite rejection. A reply whose version differs is not
// read: a commit becomes POLICYSQL_COMMIT_OUTCOME_UNKNOWN (its COMMIT may have applied, and a
// retry must never be a rejection, ADR 0007), anything else POLICYSQL_INTERNAL. Neither is a
// rejection in the client, and a keyed execute replays from its row once the versions agree.
//
// A snapshot skew (a Worker and an object of different deployments, #85) is not a rejection.
// The Worker puts the snapshot it compiled for in the `/atomic` body. An object whose own
// snapshot differs runs nothing and answers POLICYSQL_INTERNAL (500), never
// POLICYSQL_TRANSACTION_CONFLICT, which the client takes as a definite rejection of an execute
// that may be the retry of a commit. A keyed execute that committed before the skew is
// answered 500 while it lasts and replays from its `policysql_idempotency` row once the
// snapshots agree. The Worker's STALE_OPERATION (409) for a request pinned to an earlier
// snapshot is unchanged (ADR 0024 "Owner snapshot mismatch"). A begin with another snapshot
// logs the skew but keeps its 409.
//
// A reply is a 2xx response whose body is the value, or a non-2xx response whose body is
// `{ error: { code, message, path, requestId } }`. The Worker reads only that distinction. The object sends 201 for a started
// transaction, 200 for any other value, and an error's public status from the one table in
// src/http/status.ts. The wire needs no `cloudflare:workers` import (RPC
// stubs), so the adapter also runs in the Node test harness.
import { EngineError, internalError, operationError } from "../errors.ts";
import { stringifyExact } from "../exact-json.ts";
import { statusFor } from "../http/status.ts";
import { TransactionOwnerCore } from "../transaction-owner.ts";
import type { TransactionOwnerDependencies } from "../transaction-owner.ts";
import type {
  BackgroundTasks, OwnerCommandKind, OwnerFacilities, OwnerReply, TransactionOwnerHandle, TransactionOwnerPort,
} from "../transaction-owner-port.ts";
import { OWNER_NAME } from "../transaction-owner-port.ts";

const OWNER_ORIGIN = "https://owner";
const REQUEST_ID_HEADER = "x-policysql-request-id";
const OWNER_HEADER = "x-policysql-owner";
const WIRE_HEADER = "x-policysql-owner-wire";
// Changes whenever any owner wire message changes shape.
const OWNER_WIRE_VERSION = "1";
const COMMAND_PATHS: Readonly<Record<OwnerCommandKind, string>> = Object.freeze({
  statement: "/statement", commit: "/commit", rollback: "/rollback",
});

// Worker side: one internal message to the object, its JSON reply back as data.
const send = async (stub: DurableObjectStub, path: string, body: unknown, headers: Record<string, string>): Promise<OwnerReply> => {
  const response = await stub.fetch(`${OWNER_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stringifyExact(body),
  });
  if (response.headers.get(WIRE_HEADER) !== OWNER_WIRE_VERSION) {
    // An object of another wire version: its answer is not an answer to this message.
    await response.body?.cancel().catch(() => undefined);
    console.log(JSON.stringify({ event: "owner_wire_skew", path, requestId: headers[REQUEST_ID_HEADER] ?? null }));
    const error = path === "/commit"
      ? new EngineError("POLICYSQL_COMMIT_OUTCOME_UNKNOWN", "The commit outcome is unknown.")
      : internalError();
    return { ok: false, error: operationError(error) };
  }
  let parsed: any;
  try { parsed = await response.json(); } catch { throw internalError(); }
  if (response.ok) return { ok: true, value: parsed };
  const error = parsed?.error;
  return { ok: false, error: { code: error?.code, message: error?.message, path: error?.path ?? null } };
};

// Object side: a reply as the wire response.
const replyResponse = (reply: OwnerReply, path: string, requestId: string) => {
  const failure = reply as { ok: false; error: { code: string; message: string; path: string | null } };
  return new Response(
    stringifyExact(reply.ok ? reply.value : { error: { ...failure.error, requestId } }),
    {
      status: reply.ok ? (path === "/begin" ? 201 : 200) : statusFor(failure.error.code),
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", [WIRE_HEADER]: OWNER_WIRE_VERSION },
    },
  );
};

/** Routing over a Durable Object namespace: one object per owner name. */
export const durableObjectTransactionOwners = (namespace: DurableObjectNamespace): TransactionOwnerPort => {
  if (!namespace || typeof namespace.get !== "function" || typeof namespace.idFromName !== "function") {
    throw new TypeError("durableObjectTransactionOwners requires a Durable Object namespace binding");
  }
  return {
    route(name: string): TransactionOwnerHandle {
      const stub = namespace.get(namespace.idFromName(name));
      const message = (path: string, input: unknown, requestId: string) => send(stub, path, input, {
        [REQUEST_ID_HEADER]: requestId, [OWNER_HEADER]: name, [WIRE_HEADER]: OWNER_WIRE_VERSION,
      });
      return {
        begin: (input, requestId) => message("/begin", input, requestId),
        atomic: (input, requestId) => message("/atomic", input, requestId),
        command: (kind, input, requestId) => {
          if (!Object.hasOwn(COMMAND_PATHS, kind)) return Promise.reject(new TypeError("unknown owner command"));
          return message(COMMAND_PATHS[kind], input, requestId);
        },
        callbackQuery: (input, requestId) => message("/validation-query", input, requestId),
      };
    },
  };
};

/** Owner-side facilities over the object's state: storage, its single alarm, waitUntil. */
export const durableObjectFacilities = (state: DurableObjectState): OwnerFacilities => ({
  // The object's own name, where the platform reports it; otherwise the owner takes the name
  // each message carries.
  ...(typeof (state as any).id?.name === "string" && OWNER_NAME.test((state as any).id.name) ? { name: (state as any).id.name } : {}),
  store: {
    get: (key) => state.storage.get(key),
    put: (key, value) => state.storage.put(key, value),
  },
  timer: { schedule: (atMs) => state.storage.setAlarm(atMs) },
  background: { run: (task) => state.waitUntil(task) },
});

// Object side: decode one internal message and hand it to the core. An unparsable body
// becomes null, which every core command rejects as invalid.
const serve = async (core: TransactionOwnerCore, request: Request): Promise<Response> => {
  // The core falls back to a fresh id for an empty one; the error body uses the same rule.
  const requestId = request.headers.get(REQUEST_ID_HEADER) || crypto.randomUUID();
  let body: any = null;
  try { body = await request.json(); } catch { body = null; }
  const path = new URL(request.url).pathname;
  let reply: OwnerReply;
  const owner = request.headers.get(OWNER_HEADER);
  if ((owner !== null && !core.bindName(owner)) || request.headers.get(WIRE_HEADER) !== OWNER_WIRE_VERSION) {
    // Routed to another name, or a message of another wire version: an adapter or rollout
    // fault. Nothing reaches the machine.
    console.log(JSON.stringify({ event: "owner_message_rejected", requestId, path }));
    reply = { ok: false, error: operationError(internalError()) };
  } else if (path === "/begin") reply = await core.begin(body, requestId);
  else if (path === "/atomic") reply = await core.atomic(body, requestId);
  else if (path === "/validation-query") reply = await core.callbackQuery(body, requestId);
  else {
    const kind = (Object.keys(COMMAND_PATHS) as OwnerCommandKind[]).find((name) => COMMAND_PATHS[name] === path);
    // An unknown path reaches the core as an unknown kind, which it rejects as invalid.
    reply = await core.command(kind ?? (path as OwnerCommandKind), body, requestId);
  }
  return replyResponse(reply, path, requestId);
};

/**
 * The Durable Object class for the namespace `durableObjectTransactionOwners` routes to.
 * `deployment` builds the owner's ports from the object's own env (ADR 0021); pass
 * `worker.ownerDependencies` from `createPolicySqlWorker`.
 */
export const durableObjectTransactionOwnerClass = <Env extends object>(
  deployment: (env: Env) => TransactionOwnerDependencies,
) => {
  if (typeof deployment !== "function") {
    throw new TypeError("durableObjectTransactionOwnerClass requires (env) => TransactionOwnerDependencies");
  }
  return class DurableObjectTransactionOwner {
    core: TransactionOwnerCore;
    // Messages enter the core in the order they arrive at the object. Each is queued on its
    // lane before its body is read, so a body delivered late cannot let a later message
    // overtake it. The core keeps its own lanes; these only preserve arrival order.
    lanes: { client: Promise<unknown>; callback: Promise<unknown> } = { client: Promise.resolve(), callback: Promise.resolve() };

    constructor(state: DurableObjectState, env: Env) {
      this.core = new TransactionOwnerCore(durableObjectFacilities(state), deployment(env));
    }

    fetch(request: Request): Promise<Response> {
      const lane = new URL(request.url).pathname === "/validation-query" ? "callback" : "client";
      const run = this.lanes[lane].then(() => serve(this.core, request));
      this.lanes[lane] = run.then(() => undefined, () => undefined);
      return run;
    }

    alarm(): Promise<void> {
      return this.core.onTimer();
    }
  };
};

/** BackgroundTasks over a Workers request's `ExecutionContext`. */
export const executionContextTasks = (executionContext: ExecutionContext | undefined): BackgroundTasks | undefined =>
  typeof executionContext?.waitUntil === "function"
    ? { run: (task) => executionContext.waitUntil(task) }
    : undefined;
