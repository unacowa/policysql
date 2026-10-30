/* tslint:disable */
/* eslint-disable */

export class PolicySqlRuntime {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Validates a wrapper-supplied trusted session, selects the role named by the
     * `PolicySQL-Role` header (or `defaultRole` when absent), and checks the endpoint's
     * required access. This is the only place these rules exist.
     *
     * Returns `{"auth": {...}}` with the canonical result that `compile_json` and
     * `catalog_json` accept, `{"error": {"code": "POLICYSQL_FORBIDDEN_ACCESS", ...}}`
     * for a client-caused denial, or `{"error": {"code": "POLICYSQL_INTERNAL", ...},
     * "fault": "<part>"}` when the session itself violates the contract. `fault` names
     * the malformed part and never contains a session value.
     */
    authorize_session_json(session_json: string, requested_role: string | null | undefined, required_access: string): string;
    /**
     * Returns the activated, role-visible logical Catalog.
     */
    catalog_json(verified_auth_json: string): string;
    /**
     * Compiles an authenticated atomic request into profile-verified statements.
     */
    compile_json(verified_auth_json: string, request_json: string, permission: string): string;
    /**
     * Computes a request identity, fingerprint, or command digest with core's canonical
     * JSON and SHA-256 (ADR 0024 pull request 2). The input and output contract is
     * [`policysql_transaction::identity_json`]; bodies are passed as their exact text, so an
     * escaped lone surrogate in a body reaches core intact.
     *
     * Adding this method does not change `ABI_VERSION`: no existing method or value changes,
     * the engine and this module ship in one bundle, and keeping the version keeps the
     * snapshot, which every fingerprint includes (ADR 0024, "ABI impact and rollout").
     */
    identity_json(input_json: string): string;
    /**
     * The effective limits of this runtime as a JSON object with camelCase keys: the
     * configured ones (defaults filled) and the fixed protocol constants core enforces. The
     * engine enforces and advertises exactly these values; it holds no copy of its own
     * (ADR 0024, "One place for limits").
     *
     * Adding this method and the optional constructor fields does not change
     * `ABI_VERSION`: every existing `limits_json` is accepted and enforced as before, no
     * existing method or value changes, and the engine and this module ship in one bundle.
     */
    limits_json(): string;
    /**
     * Activates one immutable deployment snapshot.
     *
     * # Errors
     *
     * Returns a safe JavaScript error when configuration is malformed or inconsistent.
     */
    constructor(catalog_yaml: string, policy_yaml: string, schema_version: string, policy_version: string, limits_json: string);
    /**
     * Activates a snapshot after comparing the manifest with trusted `SQLite`
     * introspection captured by the deployment Catalog builder.
     *
     * # Errors
     *
     * Fails closed when a table, column, storage affinity, or nullability does
     * not match, or when an omitted basic type cannot be derived.
     */
    static newWithPhysicalSchema(catalog_yaml: string, policy_yaml: string, schema_version: string, policy_version: string, limits_json: string, physical_schema_json: string): PolicySqlRuntime;
    /**
     * Releases a sealed envelope after commit, rollback, or transport failure.
     */
    release_execution(handle: bigint): boolean;
    /**
     * Validates a raw remote result against a previously sealed statement.
     */
    validate_result_json(handle: bigint, index: number, raw_result_json: string): string;
    readonly abi_version: number;
    readonly commit_checks_enabled: boolean;
    readonly max_bytes_per_value: number;
    readonly profile: string;
    readonly snapshot: string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_policysqlruntime_free: (a: number, b: number) => void;
    readonly policysqlruntime_abi_version: (a: number) => number;
    readonly policysqlruntime_authorize_session_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly policysqlruntime_catalog_json: (a: number, b: number, c: number) => [number, number];
    readonly policysqlruntime_commit_checks_enabled: (a: number) => number;
    readonly policysqlruntime_compile_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly policysqlruntime_identity_json: (a: number, b: number, c: number) => [number, number];
    readonly policysqlruntime_limits_json: (a: number) => [number, number];
    readonly policysqlruntime_max_bytes_per_value: (a: number) => number;
    readonly policysqlruntime_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly policysqlruntime_newWithPhysicalSchema: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly policysqlruntime_profile: (a: number) => [number, number];
    readonly policysqlruntime_release_execution: (a: number, b: bigint) => number;
    readonly policysqlruntime_snapshot: (a: number) => [number, number];
    readonly policysqlruntime_validate_result_json: (a: number, b: bigint, c: number, d: number, e: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
