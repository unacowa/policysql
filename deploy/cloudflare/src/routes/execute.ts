import type { Hono } from "hono";
import { readJsonBody } from "../http.ts";
import { mutationIdempotency } from "../idempotency.ts";
import { authorize } from "../middleware/authorization.ts";
import { runtimeContext } from "../middleware/request-context.ts";
import { explainResponse, parsedRuntimeCall } from "../presenters.ts";
import { jsonResponse } from "../responses.ts";
import { observeCostEnvelope } from "../cost.ts";
import { executeSealedEnvelope } from "../turso.ts";
import { checkDatabaseBinding, databaseTransportFactory } from "../database.ts";
import { runtimeBytesLimit } from "../binary.ts";
import type { AppDependencies, AppEnv } from "../types.ts";

export const registerExecuteRoutes = (app: Hono<AppEnv>, dependencies: AppDependencies) => {
  app.post("/v1/transactions:explain", authorize(dependencies, "explain"), runtimeContext(dependencies), async (context) => {
    const runtime = context.get("runtime");
    const auth = context.get("auth");
    await checkDatabaseBinding(dependencies.database, context.env.databaseBinding, context.env.deployment, runtime.snapshot);
    const body = await readJsonBody(context.req.raw);
    const compiled = parsedRuntimeCall(runtime.compile_json(JSON.stringify(auth), body.text, "explain"));
    return jsonResponse(context, explainResponse(compiled, auth, context.get("requestId")));
  });

  app.post("/v1/transactions:execute", authorize(dependencies, "execute"), runtimeContext(dependencies), async (context) => {
    const runtime = context.get("runtime");
    const auth = context.get("auth");
    const requestId = context.get("requestId");
    const databaseBinding = await checkDatabaseBinding(dependencies.database, context.env.databaseBinding, context.env.deployment, runtime.snapshot);
    const maxBytesPerValue = runtimeBytesLimit(runtime);
    const transportFactory = databaseTransportFactory(dependencies.database, databaseBinding, maxBytesPerValue);
    const body = await readJsonBody(context.req.raw);
    const compiled = parsedRuntimeCall(runtime.compile_json(JSON.stringify(auth), body.text, "execute"));
    const debugAuthorized = dependencies.executionTrace?.enabled === true && auth.access.includes("debug");
    let idempotency;
    try {
      idempotency = compiled.transactionMode === "write"
        ? await mutationIdempotency(context.req.raw, auth, body.value, databaseBinding)
        : null;
    } catch (error) {
      runtime.release_execution(BigInt(compiled.executionHandle));
      throw error;
    }
    const potentiallyTriggered = compiled.transactionMode === "write" &&
      (compiled.commitChecks ?? []).some((check: any) => compiled.statements.some((statement: any) =>
        statement.operation !== "select" && check.triggeredBy.includes(statement.resource),
      ));

    if (potentiallyTriggered) {
      runtime.release_execution(BigInt(compiled.executionHandle));
      const validationId = `cval_${idempotency?.keyHash.slice(0, 32) ?? crypto.randomUUID().replaceAll("-", "")}`;
      const ownerName = `tx_${validationId.slice("cval_".length)}`;
      const owner = context.env.deployment.TRANSACTION_OWNER.get(context.env.deployment.TRANSACTION_OWNER.idFromName(ownerName));
      const response = await owner.fetch("https://owner/atomic", {
        method: "POST",
        headers: { "content-type": "application/json", "x-policysql-request-id": requestId },
        body: JSON.stringify({ validationId, auth, request: body.text, idempotency, databaseBinding, snapshot: runtime.snapshot }),
      });
      const executed: any = await response.clone().json();
      if (!response.ok) return response;
      return jsonResponse(context, {
        transactionId: executed.transactionId,
        status: "committed",
        results: executed.results,
        meta: {
          requestId: executed.originalRequestId ?? requestId,
          policyVersion: compiled.policyVersion,
          schemaVersion: compiled.schemaVersion,
          role: auth.role,
          commitChecks: executed.commitChecks,
        },
        ...(debugAuthorized && executed.executionTrace
          ? { debug: { executionTrace: executed.executionTrace } }
          : {}),
      });
    }

    const executed = await executeSealedEnvelope(
      runtime,
      compiled,
      context.env.deployment,
      requestId,
      transportFactory,
      idempotency,
      dependencies.executionTrace?.enabled ? {
        enabled: true,
        sink: dependencies.executionTrace.sink,
        inputStatements: body.value.statements,
      } : null,
    );
    const executionContext = context.executionCtx as Partial<ExecutionContext>;
    executionContext?.waitUntil?.(
      observeCostEnvelope(compiled, context.env.deployment, `${requestId}-cost`, transportFactory, maxBytesPerValue),
    );
    return jsonResponse(context, {
      transactionId: executed.transactionId ?? `atomic_${requestId}`,
      status: "committed",
      results: executed.results,
      meta: {
        requestId: executed.originalRequestId ?? requestId,
        policyVersion: compiled.policyVersion,
        schemaVersion: compiled.schemaVersion,
        role: auth.role,
        commitChecks: "not_triggered",
      },
      ...(debugAuthorized && executed.executionTrace
        ? { debug: { executionTrace: executed.executionTrace } }
        : {}),
    });
  });
};
