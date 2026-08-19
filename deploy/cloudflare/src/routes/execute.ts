import type { Hono } from "hono";
import { readJsonBody } from "../http.ts";
import { mutationIdempotency } from "../idempotency.ts";
import { authorize } from "../middleware/authorization.ts";
import { runtimeContext } from "../middleware/request-context.ts";
import { explainResponse, parsedRuntimeCall } from "../presenters.ts";
import { jsonResponse } from "../responses.ts";
import { observeCostEnvelope } from "../cost.ts";
import { executeSealedEnvelope } from "../turso.ts";
import type { AppDependencies, AppEnv } from "../types.ts";

export const registerExecuteRoutes = (app: Hono<AppEnv>, dependencies: AppDependencies) => {
  app.post("/v1/transactions:explain", authorize("explain", "explain"), runtimeContext(dependencies), async (context) => {
    const runtime = context.get("runtime");
    const auth = context.get("auth");
    const body = await readJsonBody(context.req.raw);
    const compiled = parsedRuntimeCall(runtime.compile_json(JSON.stringify(auth), body.text, "explain"));
    return jsonResponse(context, explainResponse(compiled, auth, context.get("requestId")));
  });

  app.post("/v1/transactions:execute", authorize("execute", "execute"), runtimeContext(dependencies), async (context) => {
    const runtime = context.get("runtime");
    const auth = context.get("auth");
    const requestId = context.get("requestId");
    const body = await readJsonBody(context.req.raw);
    const compiled = parsedRuntimeCall(runtime.compile_json(JSON.stringify(auth), body.text, "execute"));
    const idempotency = compiled.transactionMode === "write"
      ? await mutationIdempotency(context.req.raw, context.env, auth, body.value)
      : null;
    const potentiallyTriggered = compiled.transactionMode === "write" &&
      (compiled.commitChecks ?? []).some((check: any) => compiled.statements.some((statement: any) =>
        statement.operation !== "select" && check.triggeredBy.includes(statement.resource),
      ));

    if (potentiallyTriggered) {
      runtime.release_execution(BigInt(compiled.executionHandle));
      const validationId = `cval_${idempotency.keyHash.slice(0, 32)}`;
      const ownerName = `tx_${validationId.slice("cval_".length)}`;
      const owner = context.env.TRANSACTION_OWNER.get(context.env.TRANSACTION_OWNER.idFromName(ownerName));
      const response = await owner.fetch("https://owner/atomic", {
        method: "POST",
        headers: { "content-type": "application/json", "x-policysql-request-id": requestId },
        body: JSON.stringify({ validationId, auth, request: body.text, idempotency }),
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
      });
    }

    const executed = await executeSealedEnvelope(
      runtime,
      compiled,
      context.env,
      requestId,
      dependencies.transportFactory,
      idempotency,
    );
    const executionContext = context.executionCtx as Partial<ExecutionContext>;
    executionContext?.waitUntil?.(
      observeCostEnvelope(compiled, context.env, `${requestId}-cost`, dependencies.costTransportFactory),
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
    });
  });
};
