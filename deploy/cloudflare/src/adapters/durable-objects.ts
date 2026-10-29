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
// always used (`https://owner/<command>`, JSON body, request id header). Keeping that wire
// form lets a Worker and an object of adjacent versions talk during a rollout, and needs no
// `cloudflare:workers` import (RPC stubs), so the adapter also runs in the Node test harness.
import { HttpError } from "../errors.ts";
import { ownerResponse } from "../responses.ts";
import { TransactionOwnerCore } from "../transaction-owner.ts";
import type { TransactionOwnerDependencies } from "../transaction-owner.ts";
import type {
  BackgroundTasks, OwnerCommandKind, OwnerFacilities, OwnerReply, TransactionOwnerHandle, TransactionOwnerPort,
} from "../transaction-owner-port.ts";

const OWNER_ORIGIN = "https://owner";
const REQUEST_ID_HEADER = "x-policysql-request-id";
const COMMAND_PATHS: Readonly<Record<OwnerCommandKind, string>> = Object.freeze({
  statement: "/statement", commit: "/commit", rollback: "/rollback",
});

const malformedReply = () => new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");

// Worker side: one internal message to the object, its JSON reply back as data.
const send = async (stub: DurableObjectStub, path: string, body: unknown, headers: Record<string, string>): Promise<OwnerReply> => {
  const response = await stub.fetch(`${OWNER_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw malformedReply(); }
  return { status: response.status, body: parsed };
};

/** Routing over a Durable Object namespace: one object per owner name. */
export const durableObjectTransactionOwners = (namespace: DurableObjectNamespace): TransactionOwnerPort => {
  if (!namespace || typeof namespace.get !== "function" || typeof namespace.idFromName !== "function") {
    throw new TypeError("durableObjectTransactionOwners requires a Durable Object namespace binding");
  }
  return {
    route(name: string): TransactionOwnerHandle {
      const stub = namespace.get(namespace.idFromName(name));
      return {
        begin: (input, requestId) => send(stub, "/begin", input, { [REQUEST_ID_HEADER]: requestId }),
        atomic: (input, requestId) => send(stub, "/atomic", input, { [REQUEST_ID_HEADER]: requestId }),
        command: (kind, input, requestId) => {
          if (!Object.hasOwn(COMMAND_PATHS, kind)) return Promise.reject(new TypeError("unknown owner command"));
          return send(stub, COMMAND_PATHS[kind], input, { [REQUEST_ID_HEADER]: requestId });
        },
        callbackQuery: ({ authorization, command }, requestId) =>
          send(stub, "/validation-query", command, { authorization, [REQUEST_ID_HEADER]: requestId }),
      };
    },
  };
};

/** Owner-side facilities over the object's state: storage, its single alarm, waitUntil. */
export const durableObjectFacilities = (state: DurableObjectState): OwnerFacilities => ({
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
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? "";
  let body: any = null;
  try { body = await request.json(); } catch { body = null; }
  const path = new URL(request.url).pathname;
  let reply: OwnerReply;
  if (path === "/begin") reply = await core.begin(body, requestId);
  else if (path === "/atomic") reply = await core.atomic(body, requestId);
  else if (path === "/validation-query") {
    reply = await core.callbackQuery({ authorization: request.headers.get("authorization") ?? "", command: body }, requestId);
  } else {
    const kind = (Object.keys(COMMAND_PATHS) as OwnerCommandKind[]).find((name) => COMMAND_PATHS[name] === path);
    // An unknown path reaches the core as an unknown kind, which it rejects as invalid.
    reply = await core.command(kind ?? (path as OwnerCommandKind), body, requestId);
  }
  return ownerResponse(reply);
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

    constructor(state: DurableObjectState, env: Env) {
      this.core = new TransactionOwnerCore(durableObjectFacilities(state), deployment(env));
    }

    fetch(request: Request): Promise<Response> {
      return serve(this.core, request);
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
