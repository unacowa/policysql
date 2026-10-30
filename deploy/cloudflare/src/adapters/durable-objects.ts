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
// Between the Worker and the object, commands travel as the internal HTTP messages they
// always used (`https://owner/<command>`, JSON body, request id header), plus the owner name
// the Worker routed to (`x-policysql-owner`). Since ADR 0024 pull request 7 the body of an
// interactive command or a callback query is the step machine's forwarded owner input
// without its `kind` (the path names it); the callback capability travels in that body. A
// message in the earlier wire shape (an `authFingerprint` member, which only an earlier
// Worker sends during a rollout) is answered POLICYSQL_INTERNAL, which no client takes as a
// rejection. A reply is a 2xx response whose body
// is the value, or a non-2xx response whose body is `{ error: { code, message, path,
// requestId } }`. A Worker of this version reads only that distinction. The object still
// sends exactly the statuses and bodies of earlier versions (201 for a started transaction,
// 200 for any other value, an error's public status from the one table in src/http/status.ts)
// because an earlier Worker forwards them to the client unchanged during a rollout
// (ADR 0023). The wire needs no `cloudflare:workers` import (RPC
// stubs), so the adapter also runs in the Node test harness.
import { internalError, operationError } from "../errors.ts";
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
const COMMAND_PATHS: Readonly<Record<OwnerCommandKind, string>> = Object.freeze({
  statement: "/statement", commit: "/commit", rollback: "/rollback",
});

// Worker side: one internal message to the object, its JSON reply back as data.
const send = async (stub: DurableObjectStub, path: string, body: unknown, headers: Record<string, string>): Promise<OwnerReply> => {
  const response = await stub.fetch(`${OWNER_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let parsed: any;
  try { parsed = await response.json(); } catch { throw internalError(); }
  if (response.ok) return { ok: true, value: parsed };
  const error = parsed?.error;
  return { ok: false, error: { code: error?.code, message: error?.message, path: error?.path ?? null } };
};

// Object side: a reply as the wire response, byte-compatible with what earlier objects sent,
// since an earlier Worker forwards status and body to the client as they are.
const replyResponse = (reply: OwnerReply, path: string, requestId: string) => {
  const failure = reply as { ok: false; error: { code: string; message: string; path: string | null } };
  return new Response(
    stringifyExact(reply.ok ? reply.value : { error: { ...failure.error, requestId } }),
    {
      status: reply.ok ? (path === "/begin" ? 201 : 200) : statusFor(failure.error.code),
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
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
      const headers = (requestId: string) => ({ [REQUEST_ID_HEADER]: requestId, [OWNER_HEADER]: name });
      return {
        begin: (input, requestId) => send(stub, "/begin", input, headers(requestId)),
        atomic: (input, requestId) => send(stub, "/atomic", input, headers(requestId)),
        command: (kind, input, requestId) => {
          if (!Object.hasOwn(COMMAND_PATHS, kind)) return Promise.reject(new TypeError("unknown owner command"));
          return send(stub, COMMAND_PATHS[kind], input, headers(requestId));
        },
        callbackQuery: (input, requestId) => send(stub, "/validation-query", input, headers(requestId)),
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
  if ((owner !== null && !core.bindName(owner)) || (body !== null && typeof body === "object" && Object.hasOwn(body, "authFingerprint"))) {
    // Routed to another name, or the earlier wire shape: an adapter or rollout fault.
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
