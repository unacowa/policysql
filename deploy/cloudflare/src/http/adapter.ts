// The HTTP inbound adapter (ADR 0019, ADR 0023): the canonical implementation of the public
// HTTP protocol (spec/openapi.yaml, docs/http-api.md). It maps routes and methods to engine
// operations and headers to operation fields, frames bodies (src/http/body.ts), turns codes
// into statuses (src/http/status.ts, the only status table), and sets the fixed headers,
// ETag, and 304. It makes no decision of its own: every rule the specification fixes for the
// body, the session, the database, SQL, or transactions runs in the engine.
import { Hono } from "hono";
import { checkRequestContext } from "../engine.ts";
import type { CheckedRequestContext, OperationFailure, OperationResult, PolicySqlEngine, SnapshotResult } from "../engine.ts";
import { EngineError, operationError } from "../errors.ts";
import type { BackgroundTasks } from "../transaction-owner-port.ts";
import type { RequestContext } from "../types.ts";
import { readBodyText } from "./body.ts";
import { errorResponse, ifNoneMatchSnapshot, jsonResponse, snapshotResponse } from "./responses.ts";
import { CALLBACK_QUERY_PATH, ROUTES, TRANSACTION_ID } from "./routes.ts";

export type PolicySqlHttpApp = {
  /**
   * Serves one client request. The wrapper has already authenticated the caller and
   * selected the database; `context` carries both as data (ADR 0014, ADR 0019). Without
   * `context.requestId` the adapter generates one. `background` keeps post-response work
   * (cost observation) alive; without it that work runs detached (ADR 0022).
   */
  fetch(request: Request, context: RequestContext, background?: BackgroundTasks): Promise<Response>;
  /**
   * Serves a commit-check validator's callback query, and nothing else. Callbacks use the
   * database the owner pinned, so there is no session or database. `context.requestId` is
   * optional, as for `fetch`.
   */
  fetchCallback(request: Request, context?: { requestId?: string }): Promise<Response>;
};

const ENGINE_OPERATIONS = [
  "execute", "explain", "begin", "statement", "commit", "rollback", "catalog", "capabilities", "callbackQuery", "health",
] as const;

// Hono bindings the adapter builds per request; never the platform `env` object.
type AdapterEnv = { Bindings: { context: CheckedRequestContext & RequestContext; background?: BackgroundTasks } };

const notFound = () => new EngineError("POLICYSQL_NOT_FOUND", "Endpoint not found.");

/**
 * `PolicySQL-Role`: optional, and exactly one value. Repeated headers arrive joined with a
 * comma, which is ambiguous, so a comma is rejected. Whether the role is allowed is core's.
 */
const roleHeader = (request: Request): string | undefined => {
  const value = request.headers.get("policysql-role");
  if (value === null) return undefined;
  if (value.includes(",")) {
    throw new EngineError("POLICYSQL_INVALID_REQUEST", "PolicySQL-Role must be a single value.");
  }
  return value;
};

/** `Idempotency-Key`: passed as sent. A repeated header (comma-joined) fails the key syntax. */
const idempotencyHeader = (request: Request): string | undefined => request.headers.get("idempotency-key") ?? undefined;

const bearerCapability = (request: Request): string =>
  request.headers.get("authorization")?.match(/^Bearer (.*)$/su)?.[1] ?? "";

const send = (result: OperationResult, successStatus = 200) =>
  result.ok ? jsonResponse(result.value, successStatus) : errorResponse((result as OperationFailure).error, result.requestId);

const sendSnapshot = (result: SnapshotResult) =>
  result.ok ? snapshotResponse(result) : errorResponse((result as OperationFailure).error, result.requestId);

export const createHttpAdapter = (engine: PolicySqlEngine): PolicySqlHttpApp => {
  if (engine === null || typeof engine !== "object" ||
    ENGINE_OPERATIONS.some((name) => typeof (engine as any)[name] !== "function")) {
    throw new TypeError(`engine is required: { ${ENGINE_OPERATIONS.join(", ")} }`);
  }
  const app = new Hono<AdapterEnv>();
  const context = (c: { env: AdapterEnv["Bindings"] }): RequestContext => {
    const { databaseBinding, session, requestId } = c.env.context;
    return { database: databaseBinding, session, requestId };
  };
  const body = (request: Request) => () => readBodyText(request);

  app.get(ROUTES.health, async (c) => send(await engine.health({ requestId: c.env.context.requestId })));

  for (const kind of ["capabilities", "catalog"] as const) {
    app.get(ROUTES[kind], async (c) => sendSnapshot(await engine[kind]({
      role: roleHeader(c.req.raw),
      ifNoneMatch: ifNoneMatchSnapshot(c.req.raw.headers.get("if-none-match")),
    }, context(c))));
  }

  app.post(ROUTES.explain, async (c) => {
    const role = roleHeader(c.req.raw);
    return send(await engine.explain({ bodyText: body(c.req.raw), role }, context(c)));
  });

  app.post(ROUTES.execute, async (c) => {
    const role = roleHeader(c.req.raw);
    return send(await engine.execute({
      bodyText: body(c.req.raw), idempotencyKey: idempotencyHeader(c.req.raw), role,
    }, context(c), c.env.background));
  });

  app.post(ROUTES.begin, async (c) => {
    const role = roleHeader(c.req.raw);
    return send(await engine.begin({
      bodyText: body(c.req.raw), idempotencyKey: idempotencyHeader(c.req.raw), role,
    }, context(c)), 201);
  });

  for (const kind of ["statement", "commit", "rollback"] as const) {
    app.post(ROUTES[kind], async (c) => {
      const transactionId = c.req.param("transactionId");
      if (!TRANSACTION_ID.test(transactionId)) throw notFound();
      const role = roleHeader(c.req.raw);
      return send(await engine[kind]({ transactionId, bodyText: body(c.req.raw), role }, context(c)));
    });
  }

  app.notFound((c) => errorResponse(operationError(notFound()), c.env.context.requestId));

  // Only the adapter's own framing errors reach here (an operation returns its errors).
  app.onError((error, c) => {
    const requestId = c.env.context.requestId;
    console.log(JSON.stringify({
      event: "request_rejected",
      requestId,
      code: operationError(error).code,
      internalClass: error?.constructor?.name ?? "UnknownError",
      internalCode: typeof (error as unknown as { code?: unknown }).code === "string" ? (error as unknown as { code: string }).code : null,
    }));
    return errorResponse(operationError(error), requestId);
  });

  return {
    async fetch(request, requestContext, background) {
      // The context is checked before routing, so a wrapper fault is reported on every route.
      let checked: CheckedRequestContext;
      try { checked = checkRequestContext(requestContext, background); } catch (error) {
        return errorResponse(operationError(error), crypto.randomUUID());
      }
      try {
        return await app.fetch(request, { context: { ...checked, database: requestContext.database }, background: checked.background });
      } catch (error) {
        return errorResponse(operationError(error), checked.requestId);
      }
    },
    async fetchCallback(request, callbackContext) {
      const requestId = callbackContext?.requestId ?? crypto.randomUUID();
      const match = request.method === "POST" ? CALLBACK_QUERY_PATH.exec(new URL(request.url).pathname) : null;
      if (!match) return errorResponse(operationError(notFound()), requestId);
      return send(await engine.callbackQuery({
        validationId: match[1], capability: bearerCapability(request), bodyText: body(request),
      }, callbackContext === undefined ? { requestId } : { ...callbackContext, requestId }));
    },
  };
};
