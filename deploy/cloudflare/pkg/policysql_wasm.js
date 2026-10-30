/* @ts-self-types="./policysql_wasm.d.ts" */

export class PolicySqlRuntime {
    static __wrap(ptr) {
        const obj = Object.create(PolicySqlRuntime.prototype);
        obj.__wbg_ptr = ptr;
        PolicySqlRuntimeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PolicySqlRuntimeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_policysqlruntime_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get abi_version() {
        const ret = wasm.policysqlruntime_abi_version(this.__wbg_ptr);
        return ret >>> 0;
    }
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
     * @param {string} session_json
     * @param {string | null | undefined} requested_role
     * @param {string} required_access
     * @returns {string}
     */
    authorize_session_json(session_json, requested_role, required_access) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(session_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(requested_role) ? 0 : passStringToWasm0(requested_role, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(required_access, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.policysqlruntime_authorize_session_json(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            deferred4_0 = ret[0];
            deferred4_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Returns the activated, role-visible logical Catalog.
     * @param {string} verified_auth_json
     * @returns {string}
     */
    catalog_json(verified_auth_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(verified_auth_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.policysqlruntime_catalog_json(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {boolean}
     */
    get commit_checks_enabled() {
        const ret = wasm.policysqlruntime_commit_checks_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Compiles an authenticated atomic request into profile-verified statements.
     * @param {string} verified_auth_json
     * @param {string} request_json
     * @param {string} permission
     * @returns {string}
     */
    compile_json(verified_auth_json, request_json, permission) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(verified_auth_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(permission, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.policysqlruntime_compile_json(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            deferred4_0 = ret[0];
            deferred4_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Evaluates the cost of one envelope from the `EXPLAIN QUERY PLAN` results an `Observe`
     * effect's statements returned and the wrapper's cost catalog (ADR 0024 "Cost"). The
     * engine only logs the result: cost admits or rejects nothing. The contract is
     * [`policysql_transaction::cost`].
     * @param {string} input_json
     * @returns {string}
     */
    cost_estimate_json(input_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.policysqlruntime_cost_estimate_json(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Computes a request identity, fingerprint, or command digest with core's canonical
     * JSON and SHA-256 (ADR 0024 pull request 2, ADR 0025). The input and output contract is
     * [`policysql_transaction::identity_json`]; bodies are passed as their exact text.
     *
     * ADR 0025 made core's canonical form the only definition, which changes this method's
     * values for some inputs, so it bumped `ABI_VERSION` to 5. `keyHash`, the auth and start
     * fingerprints, and the `{sequence}` digests are unchanged
     * (`tests/fixtures/identity-goldens.json`).
     * @param {string} input_json
     * @returns {string}
     */
    identity_json(input_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.policysqlruntime_identity_json(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The effective limits of this runtime as a JSON object with camelCase keys: the
     * configured ones (defaults filled) and the fixed protocol constants core enforces. The
     * engine enforces and advertises exactly these values; it holds no copy of its own
     * (ADR 0024, "One place for limits").
     *
     * Adding this method and the optional constructor fields does not change
     * `ABI_VERSION`: every existing `limits_json` is accepted and enforced as before, no
     * existing method or value changes, and the engine and this module ship in one bundle.
     * @returns {string}
     */
    limits_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.policysqlruntime_limits_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get max_bytes_per_value() {
        const ret = wasm.policysqlruntime_max_bytes_per_value(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Activates one immutable deployment snapshot.
     *
     * # Errors
     *
     * Returns a safe JavaScript error when configuration is malformed or inconsistent.
     * @param {string} catalog_yaml
     * @param {string} policy_yaml
     * @param {string} schema_version
     * @param {string} policy_version
     * @param {string} limits_json
     */
    constructor(catalog_yaml, policy_yaml, schema_version, policy_version, limits_json) {
        const ptr0 = passStringToWasm0(catalog_yaml, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(policy_yaml, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(schema_version, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(policy_version, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(limits_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.policysqlruntime_new(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        PolicySqlRuntimeFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Activates a snapshot after comparing the manifest with trusted `SQLite`
     * introspection captured by the deployment Catalog builder.
     *
     * # Errors
     *
     * Fails closed when a table, column, storage affinity, or nullability does
     * not match, or when an omitted basic type cannot be derived.
     * @param {string} catalog_yaml
     * @param {string} policy_yaml
     * @param {string} schema_version
     * @param {string} policy_version
     * @param {string} limits_json
     * @param {string} physical_schema_json
     * @returns {PolicySqlRuntime}
     */
    static newWithPhysicalSchema(catalog_yaml, policy_yaml, schema_version, policy_version, limits_json, physical_schema_json) {
        const ptr0 = passStringToWasm0(catalog_yaml, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(policy_yaml, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(schema_version, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(policy_version, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(limits_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(physical_schema_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ret = wasm.policysqlruntime_newWithPhysicalSchema(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PolicySqlRuntime.__wrap(ret[0]);
    }
    /**
     * @returns {string}
     */
    get profile() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.policysqlruntime_profile(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Releases a sealed envelope after commit, rollback, or transport failure.
     * @param {bigint} handle
     * @returns {boolean}
     */
    release_execution(handle) {
        const ret = wasm.policysqlruntime_release_execution(this.__wbg_ptr, handle);
        return ret !== 0;
    }
    /**
     * @returns {string}
     */
    get snapshot() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.policysqlruntime_snapshot(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * One step of the transaction machine (ADR 0024): the current durable and volatile state
     * (the JSON texts a previous step returned, or `None`), one event, and the host facts.
     * Returns `{"durable": string|null, "volatile": string|null, "effects": [...]}`; the engine
     * keeps both texts verbatim, writes `durable` when an effect says `persist`, and passes
     * both back with the next event. Invalid host facts or an unreadable event give
     * `{"error":{"code":"POLICYSQL_INTERNAL",...}}` and no state. The contract is
     * [`policysql_transaction::machine`].
     *
     * Adding this method bumped `ABI_VERSION` to 6; commit checks and callbacks (pull request
     * 5) changed what it returns for some inputs and bumped it to 7; atomic execution (pull
     * request 6: an `atomic` input is executed instead of answered `POLICYSQL_INTERNAL`, the
     * `request` event, `Execute.trace`, and the `Observe` context) bumped it to 8. Production
     * owners call it for interactive transactions since ADR 0024 pull request 7, and the
     * engine and owners for atomic execution since pull request 8. Pull request 8 added the
     * outcome class `limit` without a bump: every input this method read before is answered
     * byte for byte as before (the transcripts replay unchanged), only an `executeFailed` it
     * rejected as unreadable is now read, and keeping the snapshot is what keeps keyed atomic
     * retries replaying across that deployment.
     * @param {string | null | undefined} durable_json
     * @param {string | null | undefined} volatile_json
     * @param {string} event_json
     * @param {string} host_json
     * @returns {string}
     */
    step_json(durable_json, volatile_json, event_json, host_json) {
        let deferred5_0;
        let deferred5_1;
        try {
            var ptr0 = isLikeNone(durable_json) ? 0 : passStringToWasm0(durable_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(volatile_json) ? 0 : passStringToWasm0(volatile_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(event_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passStringToWasm0(host_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len3 = WASM_VECTOR_LEN;
            const ret = wasm.policysqlruntime_step_json(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
            deferred5_0 = ret[0];
            deferred5_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Validates a raw remote result against a previously sealed statement.
     * @param {bigint} handle
     * @param {number} index
     * @param {string} raw_result_json
     * @returns {string}
     */
    validate_result_json(handle, index, raw_result_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(raw_result_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.policysqlruntime_validate_result_json(this.__wbg_ptr, handle, index, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) PolicySqlRuntime.prototype[Symbol.dispose] = PolicySqlRuntime.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./policysql_wasm_bg.js": import0,
    };
}

const PolicySqlRuntimeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_policysqlruntime_free(ptr, 1));

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('policysql_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
