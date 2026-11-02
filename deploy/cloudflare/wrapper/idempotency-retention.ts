// The reference wrapper's half of the idempotency cleanup (ADR 0028): the Turso runner, the
// deployment's own credentials, and the fixed window. The procedure itself is the library's
// (`../src/idempotency-cleanup.ts`); another deployment supplies its own runner and schedule and
// keeps the same procedure.
//
// This file is not published (ADR 0019): `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are this
// wrapper's env convention, and the Cron Trigger is this deployment's.
import { TursoHttpTransport } from "../src/turso-http.ts";
import {
  IDEMPOTENCY_CLEANUP_BATCH_SIZE, IDEMPOTENCY_CLEANUP_MAX_BATCHES, IDEMPOTENCY_RETENTION_SECONDS,
  cleanupIdempotency,
} from "../src/idempotency-cleanup.ts";
import type { CleanupResult, CleanupRunner } from "../src/idempotency-cleanup.ts";
import { RUNTIME_LIMITS } from "./limits.ts";

/**
 * The runner the reference wrapper uses: the library's own Turso transport, with the
 * deployment's administrative credentials (never a client's). Each statement is its own short
 * transaction, so a batch DELETE commits on its own and a failed statement rolls back.
 */
export const transportCleanupRunner = (
  connection: Readonly<{ url: string; authToken: string }>,
  requestId: string,
): CleanupRunner => {
  const transport = new TursoHttpTransport(connection, requestId);
  return async (sql, args, mode) => {
    const transaction = await transport.begin(mode, 5_000, undefined, {
      maxBytesPerValue: RUNTIME_LIMITS.maxBytesPerValue,
    });
    try {
      const [result] = await transaction.execute([{ sql, args }], {
        maxResponseBytes: RUNTIME_LIMITS.maxResponseBytes,
      });
      await (mode === "write" ? transaction.commit() : transaction.rollback());
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => { /* the failure is already terminal */ });
      throw error;
    }
  };
};

/** The env names the cleanup reads: the deployment's own administrative credentials. */
export type CleanupEnv = Readonly<{ TURSO_DATABASE_URL?: unknown; TURSO_AUTH_TOKEN?: unknown }>;

/**
 * The `scheduled` handler's body (ADR 0028): a missing credential is `not_configured` and deletes
 * nothing, and every other outcome comes from `cleanupIdempotency`, which never throws. `create`
 * is the runner factory; a test injects one instead of the deployment's transport.
 */
export const cleanupFromEnv = async (
  env: CleanupEnv,
  log: (event: Record<string, unknown>) => void,
  create: typeof transportCleanupRunner = transportCleanupRunner,
): Promise<CleanupResult> => {
  const options = {
    retentionSeconds: IDEMPOTENCY_RETENTION_SECONDS,
    batchSize: IDEMPOTENCY_CLEANUP_BATCH_SIZE,
    maxBatches: IDEMPOTENCY_CLEANUP_MAX_BATCHES,
    log,
  };
  const url = env.TURSO_DATABASE_URL;
  const authToken = env.TURSO_AUTH_TOKEN;
  if (typeof url !== "string" || !url || typeof authToken !== "string" || !authToken) {
    // The same empty values the library's configuration rejects. Nothing is deleted without
    // them, and this is reported the same way as every other outcome.
    const result = { outcome: "not_configured", deleted: 0, batches: 0 } as const;
    log({ event: "idempotency_cleanup", ...result });
    return result;
  }
  return cleanupIdempotency(create({ url, authToken }, "idempotency-cleanup"), options);
};
