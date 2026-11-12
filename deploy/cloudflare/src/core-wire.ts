// The shapes of core's JSON replies (ADR 0024), named so the engine can say what it reads
// instead of treating a parse result as `any` (issue #44). Core is the authority for every
// shape here; this module only declares them.
//
// These are declarations, not validators: a reply is parsed once by `parseExact` and the
// fields are read structurally, exactly as before. What changes is that an engine module can
// no longer reach a field core never defines without a compile error, and a boundary value
// that is genuinely unknown stays `unknown` until it is narrowed.

import type { ExecutionTrace } from "./types.ts";
import type { OwnerReply } from "./transaction-owner-port.ts";

/** One statement of an effect, as the database port takes it (`DriverCall`). */
export type WireStatement = Readonly<{ sql: string; args: Record<string, unknown> }>;

/** The pinned database binding (ADR 0014), as `database.ts` validates it. */
export type WireBinding = Readonly<{
  version: 1; scope: string; databaseId: string; generation: string; snapshot: string;
}>;

export type WireObserveContext = Readonly<{
  requestId: string;
  binding: WireBinding;
  statements: readonly unknown[];
}>;

/**
 * One effect of the step machine: `Effect` in `crates/policysql-transaction/src/machine/io.rs`,
 * serialized with `#[serde(tag = "type", rename_all = "camelCase")]`. The union is closed
 * here on purpose: adding an effect to core without naming it here is a compile error in the
 * owner and the engine's request step, which is where a missed effect would otherwise be
 * silently dropped.
 */
export type WireEffect =
  | { readonly type: "forward"; readonly id: number; readonly owner: string; readonly lane: string; readonly input: unknown }
  | {
    readonly type: "open"; readonly id: number; readonly binding: WireBinding;
    readonly mode: "read" | "write"; readonly timeoutMs: number; readonly deadlineMs: number;
  }
  | { readonly type: "checkBinding"; readonly id: number; readonly binding: WireBinding; readonly deadlineMs?: number }
  | {
    readonly type: "execute"; readonly id: number; readonly statements: readonly WireStatement[];
    readonly trace?: ExecutionTrace; readonly maxResponseBytes: number;
  }
  | { readonly type: "commit"; readonly id: number }
  | { readonly type: "rollback"; readonly id: number }
  | { readonly type: "setTimer"; readonly id: number; readonly atMs: number }
  | { readonly type: "persist"; readonly id: number }
  | {
    readonly type: "callValidator"; readonly id: number; readonly check: string;
    /** The hook body without `query`, in its wire key order (`RawValue` in core). */
    readonly payload: Readonly<Record<string, unknown>> & { readonly validationId?: string };
    readonly capability: Readonly<{ token: string; expiresAtMs: number }>; readonly timeoutMs: number;
  }
  | { readonly type: "respond"; readonly lane: string; readonly reply: OwnerReply }
  | {
    readonly type: "observe"; readonly statements: readonly WireStatement[];
    readonly context: WireObserveContext; readonly maxResponseBytes: number;
  }
  | { readonly type: "log"; readonly record: unknown }
  | { readonly type: "reset" };

/** `step_json`'s reply: the two texts the owner keeps verbatim, and the effects to run. */
export type StepOutput = {
  readonly durable: string;
  readonly volatile: string | null;
  readonly effects: readonly WireEffect[];
  readonly error?: { readonly code: string; readonly message: string };
};

/** A result column descriptor of the compiled contract (`presenters.ts`). */
export type CompiledColumn = {
  readonly name: string;
  readonly logicalType: string;
  readonly representation: string;
  readonly nullable: boolean;
  readonly redactedOnNull: boolean;
  readonly format?: string;
  readonly constraints?: unknown;
  readonly jsonSchema?: unknown;
};

/** One public resource an emitted statement reads. */
export type CompiledResource = { readonly name: string } & Readonly<Record<string, unknown>>;

/** One profile-verified statement of a compile result. */
export type CompiledStatement = {
  readonly operation: string;
  readonly sql: string;
  readonly clientParameters: Record<string, unknown>;
  readonly clientParameterTypes: Record<string, string | undefined>;
  readonly clientParameterNullable?: Record<string, boolean>;
  readonly serverParameters: Record<string, unknown>;
  readonly result: readonly CompiledColumn[];
  readonly explain: { readonly publicResources: readonly CompiledResource[]; readonly policyLimit?: number };
  readonly limits: { readonly maxRows: number };
};

/** `compile_json`'s reply, as `explainResponse` reads it. */
export type CompiledResponse = {
  readonly statements: readonly CompiledStatement[];
  readonly policyVersion: string;
  readonly schemaVersion: string;
  readonly transactionMode: string;
};

/**
 * The envelopes the other core calls answer with: `{"ok":true, ...}` on success, or
 * `{"error":{"code","message","path"}}`. A caller reads the success fields it needs after
 * `wasmError` has found no error.
 */
export type CoreEnvelope = {
  readonly ok?: boolean;
  readonly error?: { readonly code: string; readonly message?: string; readonly path?: string | null; readonly detail?: unknown };
  readonly fault?: string;
  readonly auth?: unknown;
  readonly estimates?: unknown;
  readonly [field: string]: unknown;
};
