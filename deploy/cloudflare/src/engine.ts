// The engine's operations (ADR 0019 stage 3, ADR 0023). The engine exposes operations, not
// HTTP: each takes its input fields and the per-request context, and returns a success value
// or an operation error `{ code, message, path }`. The HTTP adapter (src/http/adapter.ts) maps
// routes and headers to these calls and codes to statuses; a non-HTTP entry point (an
// in-process call or a service binding) calls them directly.
//
// The operations match the client `PolicySqlTransport` kinds (ADR 0015): execute, explain,
// begin, statement, commit, rollback, catalog, capabilities; plus callbackQuery for a
// commit-check validator and health.
import { internalError, operationError, EngineError } from "./errors.ts";
import type { OperationError } from "./errors.ts";
import { parseBodyText } from "./request-body.ts";
import type { BodyText } from "./request-body.ts";
import { requestIdentity, startDigest } from "./core-identity.ts";
import { authorizeSession } from "./session.ts";
import type { RequiredAccess } from "./session.ts";
import { capabilities as capabilitiesValue, explainResponse, parsedRuntimeCall } from "./presenters.ts";
import { runRequestStep } from "./request-step.ts";
import {
  checkDatabaseBinding, databaseRequired, validateDatabaseBinding, validateDatabaseProvider,
} from "./database.ts";
import type { DatabaseBinding } from "./database.ts";
import { runtimeBytesLimit } from "./binary.ts";
import { runtimeLimits } from "./limits.ts";
import { POLICY_VERSION, SCHEMA_VERSION } from "./config.ts";
import { validateConfig } from "./engine-config.ts";
import {
  checkedOwnerReply, isOwnerHandle, OWNER_NAME, validateBackgroundTasks, validateTransactionOwnerPort,
} from "./transaction-owner-port.ts";
import type { BackgroundTasks, OwnerReply, TransactionOwnerHandle } from "./transaction-owner-port.ts";
import type { AppDependencies, AuthContext, EngineDependencies, RequestContext } from "./types.ts";

export type { BodyText } from "./request-body.ts";

/** Every result carries the request id the engine used (the caller's, or a fresh UUID). */
export type OperationFailure = { ok: false; error: OperationError; requestId: string };
export type OperationResult<T = unknown> = { ok: true; value: T; requestId: string } | OperationFailure;
/**
 * Catalog and Capabilities results name the snapshot that identifies the representation.
 * When `ifNoneMatch` named that snapshot, the result is `notModified` and has no value.
 */
export type SnapshotResult<T = unknown> =
  | { ok: true; notModified: false; snapshot: string; value: T; requestId: string }
  | { ok: true; notModified: true; snapshot: string; requestId: string }
  | OperationFailure;

export type ExecuteInput = {
  bodyText: BodyText;
  /** Optional replay key (16-128 of `A-Za-z0-9._:-+/=`). */
  idempotencyKey?: string;
  /** Requested role; omitted selects the session's default role. */
  role?: string;
};
export type ExplainInput = { bodyText: BodyText; role?: string };
export type BeginInput = { bodyText: BodyText; idempotencyKey?: string; role?: string };
export type TransactionCommandInput = { transactionId: string; bodyText: BodyText; role?: string };
export type SnapshotInput = {
  role?: string;
  /** The snapshot of a representation the caller already holds. */
  ifNoneMatch?: string;
};
export type CallbackQueryInput = {
  validationId: string;
  /** The opaque capability the validator received in its hook request ("" for none). */
  capability: string;
  bodyText: BodyText;
};
/** Callback queries use the database the owner pinned, so they take no session or database. */
export type CallbackContext = { requestId?: string };

// Every client operation runs in the same order: request context, session (core), database
// binding (the wrapper's provider), then the body. A body is never read for a caller whose
// session or database is rejected.
export interface PolicySqlEngine {
  /** `background` keeps post-response work (cost observation) alive; without it, it runs detached. */
  execute(input: ExecuteInput, context: RequestContext, background?: BackgroundTasks): Promise<OperationResult>;
  explain(input: ExplainInput, context: RequestContext): Promise<OperationResult>;
  begin(input: BeginInput, context: RequestContext): Promise<OperationResult>;
  statement(input: TransactionCommandInput, context: RequestContext): Promise<OperationResult>;
  commit(input: TransactionCommandInput, context: RequestContext): Promise<OperationResult>;
  rollback(input: TransactionCommandInput, context: RequestContext): Promise<OperationResult>;
  catalog(input: SnapshotInput, context: RequestContext): Promise<SnapshotResult>;
  capabilities(input: SnapshotInput, context: RequestContext): Promise<SnapshotResult>;
  callbackQuery(input: CallbackQueryInput, context?: CallbackContext): Promise<OperationResult>;
  /** Liveness and the loaded runtime's identity. Needs no session. */
  health(context?: CallbackContext): Promise<OperationResult>;
}

/** The context after `checkRequestContext`: the binding is validated, a request id is set. */
export type CheckedRequestContext = {
  databaseBinding: DatabaseBinding;
  session: unknown;
  requestId: string;
  background?: BackgroundTasks;
};

const REQUEST_CONTEXT_KEYS = new Set(["database", "session", "requestId"]);
// Echoed in results and forwarded to the transaction owner.
export const REQUEST_ID = /^[\x21-\x7e]{1,128}$/u;
const TRANSACTION_ID = /^tx_[a-f0-9]{32}$/u;
const VALIDATION_ID = /^cval_[a-f0-9]{32}$/u;

const invalidRequest = () => new EngineError("POLICYSQL_INVALID_REQUEST", "The request is invalid.");

const logRejectedField = (field: string) =>
  console.log(JSON.stringify({ event: "request_context_rejected", field }));

/**
 * Validates the wrapper's per-request context. A missing database or a malformed context is
 * a wrapper fault (500); a binding the engine does not accept is 403. Throws an EngineError.
 */
export const checkRequestContext = (context: unknown, background?: unknown): CheckedRequestContext => {
  const value = context as RequestContext;
  const database = value === null || typeof value !== "object" ? undefined : value.database;
  if (database === undefined || database === null) throw databaseRequired();
  const unknownKey = Object.keys(value).find((key) => !REQUEST_CONTEXT_KEYS.has(key));
  if (unknownKey !== undefined || (value.requestId !== undefined &&
    (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)))) {
    logRejectedField(unknownKey ?? "requestId");
    throw internalError();
  }
  let tasks: BackgroundTasks | undefined;
  try { tasks = validateBackgroundTasks(background); } catch {
    logRejectedField("background");
    throw internalError();
  }
  const databaseBinding = validateDatabaseBinding(database, (database as DatabaseBinding).snapshot);
  return { databaseBinding, session: value.session, requestId: value.requestId ?? crypto.randomUUID(), background: tasks };
};

const callbackRequestId = (context: unknown): string => {
  if (context === undefined) return crypto.randomUUID();
  const value = context as CallbackContext;
  if (value === null || typeof value !== "object" || Object.keys(value).some((key) => key !== "requestId") ||
    (value.requestId !== undefined && (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)))) {
    logRejectedField("requestId");
    throw internalError();
  }
  return value.requestId ?? crypto.randomUUID();
};

// Operation inputs come from the caller (the HTTP adapter or a wrapper), not the client
// directly. A non-object or an unknown field is a caller fault (500); a field's value is the
// client's and is checked where it is used.
const operationInput = <T>(input: unknown, keys: readonly string[]): T => {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))) {
    console.log(JSON.stringify({ event: "operation_input_rejected" }));
    throw internalError();
  }
  return input as T;
};

const role = (value: unknown): string | undefined => {
  if (value === undefined || typeof value === "string") return value as string | undefined;
  throw invalidRequest();
};

const logRejected = (error: unknown, requestId: string) => {
  const failure = operationError(error);
  const coded = error as { code?: unknown; constructor?: { name?: string } };
  console.log(JSON.stringify({
    event: "request_rejected",
    requestId,
    code: failure.code,
    internalClass: coded?.constructor?.name ?? "UnknownError",
    internalCode: typeof coded?.code === "string" ? coded.code : null,
  }));
};

const failure = (error: unknown, requestId: string): OperationFailure =>
  ({ ok: false, error: operationError(error), requestId });

// An owner's reply as the operation result. A reply of any other shape is an adapter fault.
const fromOwner = (reply: unknown, requestId: string): OperationResult => {
  const checked = checkedOwnerReply(reply);
  if (checked === null) {
    console.log(JSON.stringify({ event: "owner_reply_rejected", requestId }));
    return failure(internalError(), requestId);
  }
  return checked.ok ? { ok: true, value: checked.value, requestId } : { ok: false, error: (checked as { error: OperationError }).error, requestId };
};

/**
 * Builds the engine from its ports (ADR 0019, ADR 0021, ADR 0022). Every port and the
 * configuration are validated here, before any operation can reach a database, owner, or
 * validator.
 */
// The snapshot versions Capabilities and `expected` report. Any other key is rejected, so a
// removed setting (`limits`, ADR 0024: limits come only from the runtime) cannot linger.
const validatePublicConfig = (publicConfig: unknown) => {
  if (publicConfig === undefined) return;
  if (!publicConfig || Array.isArray(publicConfig) || typeof publicConfig !== "object") {
    throw new TypeError("publicConfig must be { schemaVersion, policyVersion }");
  }
  for (const key of Object.keys(publicConfig)) {
    if (key === "limits") throw new TypeError("publicConfig.limits was removed; limits are configured only as RuntimeLimits");
    if (key !== "schemaVersion" && key !== "policyVersion") throw new TypeError(`publicConfig.${key} is not a setting`);
    if (typeof publicConfig[key] !== "string") throw new TypeError(`publicConfig.${key} must be a string`);
  }
};

export const createEngine = (input: AppDependencies): PolicySqlEngine => {
  if (typeof input?.getRuntime !== "function") {
    throw new TypeError("getRuntime is required");
  }
  validateDatabaseProvider(input.database);
  if ("transportFactory" in input || "costTransportFactory" in input) {
    throw new TypeError("transportFactory overrides were removed; supply database explicitly");
  }
  validateTransactionOwnerPort(input.transactionOwners);
  validatePublicConfig(input.publicConfig);
  const dependencies: EngineDependencies = { ...input, config: validateConfig(input.config) };

  /**
   * The handle of the one owner for `name`, through the wrapper's TransactionOwner port
   * (ADR 0022). A malformed name or handle is a library or wrapper fault: 500, no command sent.
   */
  const owner = (name: string): TransactionOwnerHandle => {
    if (!OWNER_NAME.test(name)) throw internalError();
    const handle = dependencies.transactionOwners.route(name);
    if (!isOwnerHandle(handle)) throw internalError();
    return handle;
  };

  // The wrapper authenticated the caller and passed the trusted session as data (ADR 0019).
  // Core validates it before any body read, owner lookup, or database work.
  const authorize = (context: CheckedRequestContext, requestedRole: unknown, access: RequiredAccess): AuthContext =>
    authorizeSession(dependencies.getRuntime(), context.session, role(requestedRole), access, context.requestId);

  // Runs one client operation: context check, then the work; any thrown error becomes the
  // operation's error. A context fault gets a fresh request id, since the caller's may be
  // the fault.
  const run = async <R extends object>(
    context: unknown,
    background: unknown,
    work: (checked: CheckedRequestContext) => Promise<R>,
  ): Promise<(R & { requestId: string }) | OperationFailure> => {
    let checked: CheckedRequestContext;
    try { checked = checkRequestContext(context, background); } catch (error) {
      return failure(error, crypto.randomUUID());
    }
    try {
      return { ...await work(checked), requestId: checked.requestId };
    } catch (error) {
      logRejected(error, checked.requestId);
      return failure(error, checked.requestId);
    }
  };

  const snapshotRead = (access: RequiredAccess, present: (runtime: any, auth: AuthContext) => unknown) =>
    (input: SnapshotInput, context: RequestContext): Promise<SnapshotResult> => run(context, undefined, async (checked) => {
      const fields = operationInput<SnapshotInput>(input, ["role", "ifNoneMatch"]);
      const auth = authorize(checked, fields.role, access);
      const runtime = dependencies.getRuntime();
      await checkDatabaseBinding(dependencies.database, checked.databaseBinding, runtime.snapshot);
      const snapshot: string = runtime.snapshot;
      if (fields.ifNoneMatch !== undefined && fields.ifNoneMatch === snapshot) {
        return { ok: true as const, notModified: true as const, snapshot };
      }
      return { ok: true as const, notModified: false as const, snapshot, value: present(runtime, auth) };
    });

  const command = (kind: "statement" | "commit" | "rollback") =>
    (input: TransactionCommandInput, context: RequestContext): Promise<OperationResult> =>
      run(context, undefined, async (checked) => {
        const fields = operationInput<TransactionCommandInput>(input, ["transactionId", "bodyText", "role"]);
        const auth = authorize(checked, fields.role, "execute");
        if (typeof fields.transactionId !== "string" || !TRANSACTION_ID.test(fields.transactionId)) throw invalidRequest();
        const snapshot = dependencies.getRuntime().snapshot;
        const databaseBinding = await checkDatabaseBinding(dependencies.database, checked.databaseBinding, snapshot);
        const body = await parseBodyText(fields.bodyText);
        // The owner's step machine compiles and hashes the verified text itself (ADR 0024 pull
        // request 7, #70), and derives the auth fingerprint from `auth` and the binding.
        const reply = await owner(fields.transactionId).command(kind, {
          transactionId: fields.transactionId, auth, command: body.text, databaseBinding, snapshot,
        }, checked.requestId);
        return fromOwner(reply, checked.requestId);
      });

  const health = async (context?: CallbackContext): Promise<OperationResult> => {
    let requestId: string;
    try { requestId = callbackRequestId(context); } catch (error) { return failure(error, crypto.randomUUID()); }
    try {
      const runtime = dependencies.getRuntime();
      return {
        ok: true,
        requestId,
        value: {
          status: "ok",
          live: true,
          // The runtime loaded. Identity configuration belongs to the wrapper (ADR 0019).
          ready: true,
          environment: dependencies.config.environment,
          abiVersion: runtime.abi_version,
          profile: runtime.profile,
          snapshot: runtime.snapshot,
          requestId,
        },
      };
    } catch (error) {
      logRejected(error, requestId);
      return failure(error, requestId);
    }
  };

  return {
    explain: (input, context) => run(context, undefined, async (checked) => {
      const fields = operationInput<ExplainInput>(input, ["bodyText", "role"]);
      const auth = authorize(checked, fields.role, "explain");
      const runtime = dependencies.getRuntime();
      await checkDatabaseBinding(dependencies.database, checked.databaseBinding, runtime.snapshot);
      const body = await parseBodyText(fields.bodyText);
      const compiled = parsedRuntimeCall(runtime.compile_json(JSON.stringify(auth), body.text, "explain"));
      return { ok: true as const, value: explainResponse(compiled, auth, checked.requestId) };
    }),

    execute: (input, context, background) => run(context, background, async (checked): Promise<OperationResult> => {
      const fields = operationInput<ExecuteInput>(input, ["bodyText", "idempotencyKey", "role"]);
      const auth = authorize(checked, fields.role, "execute");
      const runtime = dependencies.getRuntime();
      const { requestId } = checked;
      // ADR 0023 order: the provider decides the binding before the body is read. The step
      // machine's own binding check of this request is answered with this outcome, so the
      // provider is asked once (src/request-step.ts).
      const databaseBinding = await checkDatabaseBinding(dependencies.database, checked.databaseBinding, runtime.snapshot);
      // A misconfigured runtime fails here, before the body is read and before BEGIN.
      const maxBytes = runtimeBytesLimit(runtime);
      runtimeLimits(runtime);
      const body = await parseBodyText(fields.bodyText);
      // Everything else is the step machine's `request` kind (ADR 0024 pull request 8): the
      // binding check, compile of the verified text (#70), idempotency, placement (direct, or
      // the owner of an envelope that could trigger a commit check), and the response.
      const reply = await runRequestStep({
        getRuntime: dependencies.getRuntime,
        database: dependencies.database,
        costCatalog: dependencies.config.costCatalog,
        owner,
        executionTrace: dependencies.executionTrace,
      }, {
        kind: "execute",
        auth,
        databaseBinding,
        snapshot: runtime.snapshot,
        bodyText: body.text,
        ...(fields.idempotencyKey === undefined ? {} : { idempotencyKey: fields.idempotencyKey }),
        trace: dependencies.executionTrace?.enabled === true,
      }, { requestId, checked: databaseBinding, maxBytes, background: checked.background });
      const result = fromOwner(reply, requestId);
      if (!result.ok) {
        const { error } = result as OperationFailure;
        logRejected(new EngineError(error.code, error.message, error.path), requestId);
      }
      return result;
    }),

    begin: (input, context) => run(context, undefined, async (checked): Promise<OperationResult> => {
      const fields = operationInput<BeginInput>(input, ["bodyText", "idempotencyKey", "role"]);
      const auth = authorize(checked, fields.role, "execute");
      const snapshot = dependencies.getRuntime().snapshot;
      const databaseBinding = await checkDatabaseBinding(dependencies.database, checked.databaseBinding, snapshot);
      const body = await parseBodyText(fields.bodyText);
      const keys = body.value && typeof body.value === "object" && !Array.isArray(body.value)
        ? Object.keys(body.value) : [];
      if (!keys.every((key) => ["mode", "expected"].includes(key)) || !keys.includes("mode") ||
        !["read", "write"].includes(body.value.mode)) {
        throw invalidRequest();
      }
      if (body.value.expected !== undefined &&
        (!body.value.expected || Array.isArray(body.value.expected) || typeof body.value.expected !== "object" ||
          Object.keys(body.value.expected).length !== 2 ||
          !Object.hasOwn(body.value.expected, "schemaVersion") ||
          !Object.hasOwn(body.value.expected, "policyVersion"))) {
        throw invalidRequest();
      }
      if (body.value.expected &&
        (body.value.expected.schemaVersion !== (dependencies.publicConfig?.schemaVersion ?? SCHEMA_VERSION) ||
         body.value.expected.policyVersion !== (dependencies.publicConfig?.policyVersion ?? POLICY_VERSION))) {
        throw new EngineError("POLICYSQL_STALE_OPERATION", "The operation was compiled for a different active snapshot.");
      }
      const runtime = dependencies.getRuntime();
      const { requestId } = checked;
      const idempotency = requestIdentity(runtime, {
        key: fields.idempotencyKey, auth, bodyText: body.text, endpoint: "interactive-start", databaseBinding,
      });
      const transactionId = `tx_${idempotency?.keyHash.slice(0, 32) ?? crypto.randomUUID().replaceAll("-", "")}`;
      // The owner still validates its start command; this digest is not a public retry key.
      // The owner computes the auth fingerprint from `auth` and the binding (ADR 0024).
      const startFingerprint = idempotency?.fingerprint ?? startDigest(runtime, transactionId, body.text);
      const reply: OwnerReply = await owner(transactionId).begin({
        transactionId,
        startFingerprint,
        mode: body.value.mode,
        auth,
        // Omitted, not undefined, when absent: the owner checks exact keys.
        ...(body.value.expected === undefined ? {} : { expected: body.value.expected }),
        databaseBinding,
        snapshot,
      }, checked.requestId);
      return fromOwner(reply, checked.requestId);
    }),

    statement: command("statement"),
    commit: command("commit"),
    rollback: command("rollback"),

    capabilities: snapshotRead("catalog", (runtime) => capabilitiesValue(runtime, dependencies.publicConfig)),
    catalog: snapshotRead("catalog", (runtime, auth) => parsedRuntimeCall(runtime.catalog_json(JSON.stringify(auth)))),

    async callbackQuery(input, context) {
      let requestId: string;
      try { requestId = callbackRequestId(context); } catch (error) { return failure(error, crypto.randomUUID()); }
      try {
        const fields = operationInput<CallbackQueryInput>(input, ["validationId", "capability", "bodyText"]);
        if (typeof fields.validationId !== "string" || !VALIDATION_ID.test(fields.validationId)) throw invalidRequest();
        const body = await parseBodyText(fields.bodyText);
        const reply = await owner(`tx_${fields.validationId.slice("cval_".length)}`).callbackQuery({
          validationId: fields.validationId,
          capability: typeof fields.capability === "string" ? fields.capability : "",
          // The verified text: the owner compiles and hashes it, never a re-serialization (#70).
          command: body.text,
        }, requestId);
        return fromOwner(reply, requestId);
      } catch (error) {
        logRejected(error, requestId);
        return failure(error, requestId);
      }
    },

    health,
  };
};
