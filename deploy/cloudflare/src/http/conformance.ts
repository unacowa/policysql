// HTTP mapping conformance suite (ADR 0019, ADR 0023). A wrapper that serves PolicySQL over
// HTTP either uses `createHttpAdapter` or passes this suite with its own mapping. It drives a
// mapping built over a recording engine, so it checks the mapping alone: routes and methods to
// operations, headers to fields, body framing, the status of every code, fixed headers, ETag
// and 304, and request ids. It needs no database, owner, or runtime, and no test framework:
//
//   import { runHttpConformance } from "@unacowa/policysql/cloudflare/http-conformance";
//   const failures = (await runHttpConformance((engine) => myMapping(engine))).filter((r) => !r.ok);
//
// The expectations are the public protocol (spec/openapi.yaml, website/api/errors.md).
import { checkRequestContext } from "../engine.ts";
import type { PolicySqlEngine } from "../engine.ts";
import { operationError } from "../errors.ts";
import { parseBodyText } from "../request-body.ts";
import { ERROR_STATUS } from "./status.ts";

/** What a mapping must provide: the same shape `createHttpAdapter` returns. */
export type HttpMapping = {
  fetch(request: Request, context: unknown, background?: unknown): Promise<Response>;
  fetchCallback(request: Request, context?: { requestId?: string }): Promise<Response>;
};
export type CreateHttpMapping = (engine: PolicySqlEngine) => HttpMapping;
export type ConformanceCase = { name: string; run(createMapping: CreateHttpMapping): Promise<void> };
export type ConformanceResult = { name: string; ok: boolean; error?: unknown };

type Call = { operation: string; input: any; context: any; background?: unknown; body?: string };
type Answer = (call: Call) => unknown;

const ORIGIN = "https://policysql.test";
const TX = `tx_${"a".repeat(32)}`;
const CVAL = `cval_${"b".repeat(32)}`;
const SNAPSHOT = "snapshot_conformance";
const BINDING = Object.freeze({ version: 1, scope: "conformance", databaseId: "db", generation: "1", snapshot: SNAPSHOT });
const SESSION = Object.freeze({ principal: "p", subject: "s", roles: ["member"], defaultRole: "member", access: ["execute"], session: {} });
const FIXED = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" };

const fail = (message: string): never => { throw new Error(message); };
const check = (condition: unknown, message: string) => { if (!condition) fail(message); };
const same = (actual: unknown, expected: unknown, message: string) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${message}: expected ${e}, got ${a}`);
};

// Bodies a mapping handed over already read, collected per case. The engine checks the
// session and the database before it reads a body (ADR 0023), so a mapping must pass the
// body as a reader; one that reads it eagerly would read bodies the engine then rejects.
let eagerBodies: string[] = [];

// The request limits of the recording engine, as a real engine reads them from its runtime
// (ADR 0027). The mapping under test must stream a reader's body at the limit it is handed, so
// the suite uses small limits of its own and learns them from nothing but this engine.
const LIMITS = Object.freeze({ maxRequestBytes: 4_096, maxJsonValues: 1_024 });

/**
 * An engine that records each call and answers with `answer(call)` (default: a success whose
 * value names the operation). Like the real engine, it checks the request context, then reads
 * the deferred body and returns the reader's error as the operation's. A body that is not a
 * reader is a conformance failure.
 */
const recordingEngine = (answer?: Answer) => {
  const calls: Call[] = [];
  const operation = (name: string, takesContext: boolean) => async (input: any, context?: any, background?: unknown) => {
    const call: Call = { operation: name, input, context, background };
    calls.push(call);
    const requestId = context?.requestId ?? "generated";
    if (takesContext) {
      try { checkRequestContext(context, background); } catch (error) {
        return { ok: false, error: operationError(error), requestId };
      }
    }
    if (input && Object.hasOwn(input, "bodyText")) {
      if (typeof input.bodyText !== "function") eagerBodies.push(name);
      try { call.body = (await parseBodyText(input.bodyText, LIMITS)).text; } catch (error) {
        return { ok: false, error: operationError(error), requestId };
      }
    }
    return answer?.(call) ?? { ok: true, value: { operation: name }, requestId, snapshot: SNAPSHOT, notModified: false };
  };
  const engine = {
    execute: operation("execute", true), explain: operation("explain", true), begin: operation("begin", true),
    statement: operation("statement", true), commit: operation("commit", true), rollback: operation("rollback", true),
    catalog: operation("catalog", true), capabilities: operation("capabilities", true),
    callbackQuery: operation("callbackQuery", false), health: operation("health", false),
  } as unknown as PolicySqlEngine;
  return { engine, calls };
};

const post = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });
const context = (extra: Record<string, unknown> = {}) => ({ database: BINDING, session: SESSION, requestId: "req_conformance", ...extra });

const expectFixedHeaders = (response: Response, label: string) => {
  for (const [name, value] of Object.entries(FIXED)) same(response.headers.get(name), value, `${label}: ${name}`);
};
const expectError = async (response: Response, status: number, code: string, label: string, requestId?: string) => {
  same(response.status, status, `${label}: status`);
  expectFixedHeaders(response, label);
  const body: any = await response.json();
  check(body && typeof body.error === "object", `${label}: error body`);
  same(Object.keys(body.error).sort(), ["code", "message", "path", "requestId"], `${label}: error fields`);
  same(body.error.code, code, `${label}: code`);
  check(typeof body.error.message === "string" && body.error.message !== "", `${label}: message`);
  check(typeof body.error.requestId === "string" && body.error.requestId !== "", `${label}: requestId`);
  if (requestId !== undefined) same(body.error.requestId, requestId, `${label}: requestId`);
};

// Every client route: method and path, the operation, and the fields it carries.
const ROUTE_CASES: Array<{ label: string; request: () => Request; operation: string; input: Record<string, unknown>; status: number }> = [
  { label: "GET /v1/capabilities", request: () => get("/v1/capabilities"), operation: "capabilities", input: {}, status: 200 },
  { label: "GET /v1/catalog", request: () => get("/v1/catalog", { "policysql-role": "member" }), operation: "catalog",
    input: { role: "member" }, status: 200 },
  { label: "POST /v1/transactions:explain", request: () => post("/v1/transactions:explain", '{"statements":[]}', { "policysql-role": "member" }),
    operation: "explain", input: { role: "member", body: '{"statements":[]}' }, status: 200 },
  { label: "POST /v1/transactions:execute", request: () => post("/v1/transactions:execute", '{"statements":[]}', { "idempotency-key": "conformance-key-0001" }),
    operation: "execute", input: { idempotencyKey: "conformance-key-0001", body: '{"statements":[]}' }, status: 200 },
  { label: "POST /v1/transactions", request: () => post("/v1/transactions", '{"mode":"read"}'), operation: "begin",
    input: { body: '{"mode":"read"}' }, status: 201 },
  { label: "POST statements", request: () => post(`/v1/transactions/${TX}/statements`, '{"sequence":1}'), operation: "statement",
    input: { transactionId: TX, body: '{"sequence":1}' }, status: 200 },
  { label: "POST commit", request: () => post(`/v1/transactions/${TX}/commit`, '{"sequence":2}'), operation: "commit",
    input: { transactionId: TX, body: '{"sequence":2}' }, status: 200 },
  { label: "POST rollback", request: () => post(`/v1/transactions/${TX}/rollback`, '{"sequence":2}'), operation: "rollback",
    input: { transactionId: TX, body: '{"sequence":2}' }, status: 200 },
];

const fieldsOf = (call: Call) => {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.input ?? {})) {
    if (key === "bodyText") continue;
    if (value !== undefined) fields[key] = value;
  }
  if (call.body !== undefined) fields.body = call.body;
  return fields;
};

// Every case also fails when the mapping passed any body already read.
const conformanceCase = (name: string, run: ConformanceCase["run"]): ConformanceCase => ({
  name,
  async run(createMapping) {
    eagerBodies = [];
    await run(createMapping);
    if (eagerBodies.length > 0) {
      fail(`bodyText must be a reader the engine calls after the session and database checks; read eagerly for ${[...new Set(eagerBodies)].join(", ")}`);
    }
  },
});

export const httpConformanceCases: readonly ConformanceCase[] = Object.freeze(([
  {
    name: "each route calls its operation with the header fields, the body text, and the wrapper context",
    async run(createMapping) {
      for (const route of ROUTE_CASES) {
        const { engine, calls } = recordingEngine();
        const background = { run() {} };
        const response = await createMapping(engine).fetch(route.request(), context(), background);
        same(calls.map((call) => call.operation), [route.operation], `${route.label}: operations`);
        same(fieldsOf(calls[0]), route.input, `${route.label}: fields`);
        same(calls[0].context?.database, BINDING, `${route.label}: database`);
        same(calls[0].context?.session, SESSION, `${route.label}: session`);
        same(calls[0].context?.requestId, "req_conformance", `${route.label}: requestId`);
        if (route.operation === "execute") check(calls[0].background === background, "execute: background tasks are passed");
        same(response.status, route.status, `${route.label}: success status`);
        if (!["capabilities", "catalog"].includes(route.operation)) {
          expectFixedHeaders(response, route.label);
          same(await response.json(), { operation: route.operation }, `${route.label}: body is the value`);
        }
      }
      const { engine, calls } = recordingEngine();
      const health = await createMapping(engine).fetch(get("/healthz"), context());
      same(calls.map((call) => call.operation), ["health"], "GET /healthz");
      same(health.status, 200, "GET /healthz: status");
      expectFixedHeaders(health, "GET /healthz");
    },
  },
  {
    name: "the commit-check callback route calls callbackQuery with the bearer capability, through fetchCallback only",
    async run(createMapping) {
      const { engine, calls } = recordingEngine();
      const mapping = createMapping(engine);
      const response = await mapping.fetchCallback(post(`/v1/commit-checks/${CVAL}/query`, '{"sequence":1}', { authorization: "Bearer capability_1" }),
        { requestId: "req_callback" });
      same(response.status, 200, "callback: status");
      expectFixedHeaders(response, "callback");
      same(calls.map((call) => [call.operation, fieldsOf(call)]),
        [["callbackQuery", { validationId: CVAL, capability: "capability_1", body: '{"sequence":1}' }]], "callback: call");
      same(calls[0].context?.requestId, "req_callback", "callback: requestId");
      await mapping.fetchCallback(post(`/v1/commit-checks/${CVAL}/query`, "{}"));
      same(fieldsOf(calls[1]).capability, "", "callback without a bearer capability passes an empty one");
      for (const request of [
        post(`/v1/commit-checks/cval_short/query`, "{}"), post(`/v1/commit-checks/${CVAL}/other`, "{}"),
        get(`/v1/commit-checks/${CVAL}/query`), post("/v1/catalog", "{}"),
      ]) await expectError(await mapping.fetchCallback(request), 404, "POLICYSQL_NOT_FOUND", `fetchCallback ${request.method} ${request.url}`);
      await expectError(await mapping.fetch(post(`/v1/commit-checks/${CVAL}/query`, "{}"), context()), 404, "POLICYSQL_NOT_FOUND",
        "the callback route through fetch");
      same(calls.length, 2, "no other request reached the engine");
    },
  },
  {
    name: "every code is served with its status from the public table, in the public error shape",
    async run(createMapping) {
      const codes = { ...ERROR_STATUS, POLICYSQL_NOT_IN_THE_TABLE: 500 };
      for (const [code, status] of Object.entries(codes)) {
        for (const route of ROUTE_CASES) {
          const { engine } = recordingEngine(() => ({ ok: false, error: { code, message: "safe message", path: "/statements/0" }, requestId: "req_err" }));
          const response = await createMapping(engine).fetch(route.request(), context());
          await expectError(response, status, code, `${route.label} ${code}`, "req_err");
        }
      }
      const { engine } = recordingEngine(() => ({ ok: false, error: { code: "POLICYSQL_INTERNAL", message: "m", path: null }, requestId: "req_cb" }));
      await expectError(await createMapping(engine).fetchCallback(post(`/v1/commit-checks/${CVAL}/query`, "{}")), 500, "POLICYSQL_INTERNAL",
        "callback error", "req_cb");
    },
  },
  {
    name: "Catalog and Capabilities carry the snapshot as a strong ETag and answer a matching If-None-Match with 304",
    async run(createMapping) {
      for (const path of ["/v1/catalog", "/v1/capabilities"]) {
        const values = recordingEngine((call) => ({ ok: true, notModified: false, snapshot: SNAPSHOT, value: { path }, requestId: "r" }));
        const fresh = await createMapping(values.engine).fetch(get(path), context());
        same(fresh.status, 200, `${path}: status`);
        same(fresh.headers.get("etag"), `"${SNAPSHOT}"`, `${path}: etag`);
        same(fresh.headers.get("cache-control"), "private, max-age=0, must-revalidate", `${path}: cache-control`);
        same(fresh.headers.get("content-type"), FIXED["content-type"], `${path}: content-type`);
        same(await fresh.json(), { path }, `${path}: body`);
        const unchanged = recordingEngine(() => ({ ok: true, notModified: true, snapshot: SNAPSHOT, requestId: "r" }));
        const mapping = createMapping(unchanged.engine);
        const cached = await mapping.fetch(get(path, { "if-none-match": `"${SNAPSHOT}"` }), context());
        same(cached.status, 304, `${path}: not modified`);
        same(cached.headers.get("etag"), `"${SNAPSHOT}"`, `${path}: 304 etag`);
        same(await cached.text(), "", `${path}: 304 has no body`);
        same(unchanged.calls[0].input.ifNoneMatch, SNAPSHOT, `${path}: If-None-Match names the snapshot`);
        for (const header of [`W/"${SNAPSHOT}"`, SNAPSHOT, `"${SNAPSHOT}", "other"`]) {
          await mapping.fetch(get(path, { "if-none-match": header }), context());
          same(unchanged.calls.at(-1).input.ifNoneMatch, undefined, `${path}: If-None-Match ${header} is not one strong tag`);
        }
      }
    },
  },
  {
    name: "PolicySQL-Role must be one value; a comma-joined value is 400 before any operation",
    async run(createMapping) {
      for (const route of ROUTE_CASES) {
        const { engine, calls } = recordingEngine();
        const request = route.request();
        request.headers.set("policysql-role", "member, admin");
        await expectError(await createMapping(engine).fetch(request, context()), 400, "POLICYSQL_INVALID_REQUEST", `${route.label} role`, "req_conformance");
        same(calls.length, 0, `${route.label}: no operation`);
        same(request.bodyUsed, false, `${route.label}: the body is not read`);
      }
    },
  },
  {
    name: "body framing: Content-Type, Content-Length, streamed size, and strict UTF-8",
    async run(createMapping) {
      const cases: Array<[string, () => Request, number, string]> = [
        ["text/plain", () => post("/v1/transactions:execute", "{}", { "content-type": "text/plain" }), 415, "POLICYSQL_UNSUPPORTED_MEDIA_TYPE"],
        ["no content-type", () => new Request(`${ORIGIN}/v1/transactions:execute`, { method: "POST", body: new Uint8Array([0x7b, 0x7d]) }), 415, "POLICYSQL_UNSUPPORTED_MEDIA_TYPE"],
        ["declared too large", () => post("/v1/transactions:execute", "{}", { "content-length": String(LIMITS.maxRequestBytes + 1) }), 413, "POLICYSQL_REQUEST_TOO_LARGE"],
        ["streamed too large", () => post("/v1/transactions:execute", "x".repeat(LIMITS.maxRequestBytes + 1)), 413, "POLICYSQL_REQUEST_TOO_LARGE"],
        ["malformed UTF-8", () => post("/v1/transactions:execute", new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])), 400, "POLICYSQL_INVALID_REQUEST"],
        ["duplicate key", () => post("/v1/transactions:execute", '{"a":1,"a":2}'), 400, "POLICYSQL_INVALID_REQUEST"],
        ["no body", () => post("/v1/transactions:execute", null), 400, "POLICYSQL_INVALID_REQUEST"],
      ];
      for (const [label, request, status, code] of cases) {
        const { engine } = recordingEngine();
        await expectError(await createMapping(engine).fetch(request(), context()), status, code, label);
      }
      const { engine, calls } = recordingEngine();
      await createMapping(engine).fetch(post("/v1/transactions:execute", new TextEncoder().encode('{"a":"é\u{1f600}"}'),
        { "content-type": "application/json; charset=utf-8" }), context());
      same(calls[0].body, '{"a":"é\u{1f600}"}', "UTF-8 body text");
    },
  },
  {
    name: "unknown routes and malformed transaction ids are 404 without an operation",
    async run(createMapping) {
      const { engine, calls } = recordingEngine();
      const mapping = createMapping(engine);
      for (const request of [
        get("/v1/unknown"), post("/v1/transactions:other", "{}"), post(`/v1/transactions/${TX}/unknown`, "{}"),
        post("/v1/transactions/tx_short/statements", "{}"), post(`/v1/transactions/${TX.toUpperCase()}/commit`, "{}"),
        get("/v1/transactions:execute"),
      ]) await expectError(await mapping.fetch(request, context()), 404, "POLICYSQL_NOT_FOUND", `${request.method} ${request.url}`, "req_conformance");
      same(calls.length, 0, "no operation");
    },
  },
  {
    name: "request ids: the wrapper's is used; without one, a fresh id is generated and passed to the operation",
    async run(createMapping) {
      const { engine, calls } = recordingEngine((call) => ({ ok: false, error: { code: "POLICYSQL_FORBIDDEN_ACCESS", message: "m", path: null }, requestId: call.context.requestId }));
      const mapping = createMapping(engine);
      const response = await mapping.fetch(get("/v1/catalog", { "cf-ray": "platform-header" }), { database: BINDING, session: SESSION });
      const id = ((await response.json()) as any).error.requestId;
      check(typeof calls[0].context.requestId === "string" && calls[0].context.requestId !== "", "a request id is generated");
      same(id, calls[0].context.requestId, "the generated id is the operation's");
      check(id !== "platform-header", "no platform header is read as the request id");
    },
  },
  {
    name: "a malformed wrapper context is a 500 before any operation runs",
    async run(createMapping) {
      for (const [label, value, code] of [
        ["no database", { session: SESSION }, "POLICYSQL_DATABASE_REQUIRED"],
        ["unknown field", { ...context(), tenant: "x" }, "POLICYSQL_INTERNAL"],
        ["malformed request id", context({ requestId: "has space" }), "POLICYSQL_INTERNAL"],
      ] as const) {
        const { engine, calls } = recordingEngine();
        const request = post("/v1/transactions:execute", "{}");
        await expectError(await createMapping(engine).fetch(request, value), 500, code, label);
        check(calls.every((call) => call.operation === "execute"), `${label}: only the operation itself may see it`);
        same(request.bodyUsed, false, `${label}: the body is not read`);
      }
    },
  },
] as ConformanceCase[]).map((item) => conformanceCase(item.name, item.run)));

/** Runs every case against mappings built by `createMapping`. Never throws. */
export const runHttpConformance = async (createMapping: CreateHttpMapping): Promise<ConformanceResult[]> => {
  const results: ConformanceResult[] = [];
  for (const conformance of httpConformanceCases) {
    try {
      await conformance.run(createMapping);
      results.push({ name: conformance.name, ok: true });
    } catch (error) {
      results.push({ name: conformance.name, ok: false, error });
    }
  }
  return results;
};
