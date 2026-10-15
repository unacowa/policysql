import type { Hono } from "hono";
import { HttpError } from "../errors.ts";
import { readJsonBody } from "../http.ts";
import { authFingerprint, requestIdempotency } from "../idempotency.ts";
import { authorize } from "../middleware/authorization.ts";
import { jsonResponse } from "../responses.ts";
import { POLICY_VERSION, SCHEMA_VERSION } from "../config.ts";
import { checkDatabaseBinding } from "../database.ts";
import type { AppDependencies, AppEnv } from "../types.ts";

const TRANSACTION_ID = /^tx_[a-f0-9]{32}$/u;

const invalidRequest = () =>
  new HttpError(400, "POLICYSQL_INVALID_REQUEST", "The request is invalid.");

export const registerTransactionRoutes = (app: Hono<AppEnv>, dependencies: AppDependencies) => {
  app.post("/v1/transactions", authorize("execute", "interactive"), async (context) => {
    const auth = context.get("auth");
    const body = await readJsonBody(context.req.raw);
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
      throw new HttpError(409, "POLICYSQL_STALE_OPERATION", "The operation was compiled for a different active snapshot.");
    }
    const snapshot = dependencies.getRuntime().snapshot;
    const databaseBinding = await checkDatabaseBinding(dependencies.database, context.env.databaseBinding, context.env.deployment, snapshot);
    const idempotency = await requestIdempotency(
      context.req.raw,
      context.env.deployment,
      auth,
      body.value,
      "interactive-start",
      databaseBinding,
    );
    const transactionId = `tx_${idempotency.keyHash.slice(0, 32)}`;
    const fingerprint = await authFingerprint(context.env.deployment, auth, databaseBinding);
    const owner = context.env.deployment.TRANSACTION_OWNER.get(context.env.deployment.TRANSACTION_OWNER.idFromName(transactionId));
    return owner.fetch("https://owner/begin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-policysql-request-id": context.get("requestId") },
      body: JSON.stringify({
        transactionId,
        authFingerprint: fingerprint,
        startFingerprint: idempotency.fingerprint,
        mode: body.value.mode,
        auth,
        expected: body.value.expected,
        databaseBinding,
        snapshot,
      }),
    });
  });

  app.post("/v1/transactions/:transactionId/:command", authorize("execute", "interactive"), async (context) => {
    const transactionId = context.req.param("transactionId");
    const command = context.req.param("command");
    if (!TRANSACTION_ID.test(transactionId) || !["statements", "commit", "rollback"].includes(command)) {
      throw new HttpError(404, "POLICYSQL_NOT_FOUND", "Endpoint not found.");
    }
    const auth = context.get("auth");
    const body = await readJsonBody(context.req.raw);
    const snapshot = dependencies.getRuntime().snapshot;
    const databaseBinding = await checkDatabaseBinding(dependencies.database, context.env.databaseBinding, context.env.deployment, snapshot);
    const fingerprint = await authFingerprint(context.env.deployment, auth, databaseBinding);
    const owner = context.env.deployment.TRANSACTION_OWNER.get(context.env.deployment.TRANSACTION_OWNER.idFromName(transactionId));
    return owner.fetch(`https://owner/${command === "statements" ? "statement" : command}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-policysql-request-id": context.get("requestId") },
      body: JSON.stringify({ transactionId, authFingerprint: fingerprint, command: body.value, databaseBinding, snapshot }),
    });
  });
};
