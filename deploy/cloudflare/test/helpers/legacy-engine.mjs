// `execute` as the engine ran it before ADR 0024 pull request 8: the TypeScript direct path
// (`executeSealedEnvelope`, `observeCostEnvelope`) and, for an envelope that could trigger a
// commit check, the owner's TypeScript atomic path (`LegacyTransactionOwnerCore`), reached
// through a TransactionOwner port whose handles have `atomic(input, requestId)`.
// TEST ONLY: the reference of the atomic differential harness (step-atomic-differential.test.mjs)
// and the writer of the rows "origin/main" stored, for the tests of keyed retries across the
// deployment (atomic-switch.test.mjs), until pull request 9 deletes the TypeScript decision code.
//
// Transcribed from deploy/cloudflare/src/engine.ts `execute` at 6f97c57 (origin/main before
// pull request 8); only the engine's shared helpers are imported, unchanged.
import { internalError, operationError } from "../../src/errors.ts";
import { checkRequestContext } from "../../src/engine.ts";
import { authorizeSession } from "../../src/session.ts";
import { parseBodyText } from "../../src/request-body.ts";
import { requestIdentity } from "../../src/core-identity.ts";
import { parsedRuntimeCall } from "../../src/presenters.ts";
import { observeCostEnvelope } from "../../src/cost.ts";
import { executeSealedEnvelope } from "../../src/turso.ts";
import { checkDatabaseBinding, databaseTransportFactory } from "../../src/database.ts";
import { runtimeBytesLimit } from "../../src/binary.ts";
import { runtimeLimits } from "../../src/limits.ts";
import { validateConfig } from "../../src/engine-config.ts";
import { checkedOwnerReply, runInBackground } from "../../src/transaction-owner-port.ts";

const fromOwner = (reply, requestId) => {
  const checked = checkedOwnerReply(reply);
  if (checked === null) {
    console.log(JSON.stringify({ event: "owner_reply_rejected", requestId }));
    return { ok: false, error: operationError(internalError()), requestId };
  }
  return checked.ok ? { ok: true, value: checked.value, requestId } : { ok: false, error: checked.error, requestId };
};

export const createLegacyExecute = ({ getRuntime, database, config, transactionOwners, executionTrace }) => {
  const validated = validateConfig(config);
  return async (input, context, background) => {
    let checked;
    try { checked = checkRequestContext(context, background); } catch (error) {
      return { ok: false, error: operationError(error), requestId: crypto.randomUUID() };
    }
    const { requestId } = checked;
    try {
      const auth = authorizeSession(getRuntime(), checked.session, input.role, "execute", requestId);
      const runtime = getRuntime();
      const databaseBinding = await checkDatabaseBinding(database, checked.databaseBinding, runtime.snapshot);
      const maxBytesPerValue = runtimeBytesLimit(runtime);
      const { costTimeoutMs } = runtimeLimits(runtime);
      const transportFactory = databaseTransportFactory(database, databaseBinding, maxBytesPerValue);
      const body = await parseBodyText(input.bodyText);
      const compiled = parsedRuntimeCall(runtime.compile_json(JSON.stringify(auth), body.text, "execute"));
      const debugAuthorized = executionTrace?.enabled === true && auth.access.includes("debug");
      let idempotency;
      try {
        idempotency = compiled.transactionMode === "write"
          ? requestIdentity(runtime, { key: input.idempotencyKey, auth, bodyText: body.text, endpoint: "execute", databaseBinding })
          : null;
      } catch (error) {
        runtime.release_execution(BigInt(compiled.executionHandle));
        throw error;
      }
      const potentiallyTriggered = compiled.transactionMode === "write" &&
        (compiled.commitChecks ?? []).some((check) => compiled.statements.some((statement) =>
          statement.operation !== "select" && check.triggeredBy.includes(statement.resource),
        ));
      if (potentiallyTriggered) {
        runtime.release_execution(BigInt(compiled.executionHandle));
        const validationId = `cval_${idempotency?.keyHash.slice(0, 32) ?? crypto.randomUUID().replaceAll("-", "")}`;
        const reply = fromOwner(await transactionOwners.route(`tx_${validationId.slice("cval_".length)}`).atomic({
          validationId, auth, request: body.text, idempotency, databaseBinding, snapshot: runtime.snapshot,
        }, requestId), requestId);
        if (!reply.ok) return reply;
        const executed = reply.value;
        return {
          ok: true,
          requestId,
          value: {
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
            ...(debugAuthorized && executed.executionTrace ? { debug: { executionTrace: executed.executionTrace } } : {}),
          },
        };
      }
      const executed = await executeSealedEnvelope(runtime, compiled, requestId, transportFactory, idempotency,
        executionTrace?.enabled ? { enabled: true, sink: executionTrace.sink, inputStatements: body.value.statements } : null);
      runInBackground(checked.background, observeCostEnvelope(
        compiled, validated.costCatalog, `${requestId}-cost`, transportFactory, maxBytesPerValue, costTimeoutMs,
      ), requestId);
      return {
        ok: true,
        requestId,
        value: {
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
          ...(debugAuthorized && executed.executionTrace ? { debug: { executionTrace: executed.executionTrace } } : {}),
        },
      };
    } catch (error) {
      return { ok: false, error: operationError(error), requestId };
    }
  };
};
