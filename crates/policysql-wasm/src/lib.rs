#![forbid(unsafe_code)]

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    ClientParameterName, ColumnName, CompileContext, ConstraintScalar, ExpectationKind,
    JsonSchemaType, JsonValueSchema, LimitName, LogicalType, LogicalValue, ResourceId,
    ResourceName, SnapshotId, StorageClass, ValueConstraints, ValueDescriptor, ValueRepresentation,
};
use policysql_execution::{ComplexityCause, ExecutionLimits};
use policysql_gateway::{
    AuthContext, BindingCatalog, EndpointPermission, Gateway, GatewayError, ParameterReason,
    Rejection, RejectionDetail, RejectionKind, StatementRequest, classify_bind_error,
};
use policysql_ir::{BoundExpr, BoundSelect, BoundStatement};
use policysql_parser::{SqliteFrontend, UnsupportedFeature};
use policysql_policy::PolicyBundle;
use policysql_transaction::machine::io::ErrorDetail;
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

/// 5: core-defined canonical JSON (ADR 0025) changes `identity_json` values for some inputs
/// (non-integer numbers, integers beyond 2^53 - 1, non-ASCII object keys) and reads decimals
/// correctly rounded.
/// 6: `step_json`, the transaction step machine (ADR 0024 pull request 4), and the runtime
/// limits it requires to keep durable transaction state within its bound.
/// 7: commit checks and callbacks in `step_json` (ADR 0024 pull request 5): a commit whose
/// mutations trigger checks now emits `callValidator` instead of being rejected, callback
/// queries are served, and the `validatorReplied`/`validatorFailed` events are read.
/// 8: atomic execution in `step_json` (ADR 0024 pull request 6).
/// 9: the request fingerprint of `identity_json` (and of keyed atomic execution in
/// `step_json`) no longer includes the binding's `snapshot` (#80), so a committed keyed
/// write retried after a snapshot-changing deployment replays instead of conflicting.
/// 10: the `Idempotency-Key` syntax of `identity_json` and `step_json` accepts `+`, `/`, and `=`
/// (so such keys now hash instead of being rejected), and a malformed key is answered
/// `POLICYSQL_IDEMPOTENCY_KEY_INVALID` with a new message instead of `..._KEY_REQUIRED` (#65).
/// 11: an owner answers an `atomic` input whose snapshot is not its own `POLICYSQL_INTERNAL`
/// (the version-skew answer) instead of `POLICYSQL_TRANSACTION_CONFLICT` (#85).
/// 12: `commitFailed` with class `not_committed` is a definite rejection (#54).
/// 13: ADR 0027 pull request 3: `limits_json` reports every limit the ADR adds and has new
/// constructor fields (`max_request_bytes`, `max_json_values`, `max_sql_bytes`);
/// `max_bytes_per_value` is no longer a getter; the request-path bounds are derived from
/// `max_request_bytes` (compile, hash, and event inputs) and the session bound is 65,536
/// bytes, so the same input can be accepted or answered differently; SQL over its limit is
/// 413 `POLICYSQL_REQUEST_TOO_LARGE` (was 400). No identity value changed.
/// 14: ADR 0027 pull request 4: `max_parameters`, `max_expression_depth`, `max_projections`,
/// and `max_joins` are constructor fields (the default of `max_parameters` is 1,024, was 128);
/// the new code `POLICYSQL_SQL_TOO_COMPLEX` (400) answers an emitted statement over the
/// parser's height or recursion cap, over 2,000 result columns, 32,766 host parameters, a
/// 50,000-byte bound LIKE pattern, or the 1 MiB column-metadata guard (was 400
/// `POLICYSQL_UNSUPPORTED_SQL`); any other re-parse failure of emitted SQL is 500
/// `POLICYSQL_INTERNAL`; the step machine reads the outcome class `complex` (with the statement
/// index) and a `databaseCode` on `executeFailed`, and writes the log events `sql_too_complex`,
/// `emitted_sql_reparse_failed`, and `database_error_unclassified`. No identity value changed.
/// 15: ADR 0027 pull request 6: `max_statements`, `max_rows`, and `max_result_bytes` have hard
/// maxima (64, 100,000, 524,288) and `max_response_bytes` is a constructor field, so a limit
/// that was accepted is refused and a response over it is 413 `POLICYSQL_LIMIT_EXCEEDED` with
/// rollback before COMMIT; result-side `max_json_values` is enforced (413); the raw result
/// bound is compiled per envelope and replaces the 1 MiB per statement bound; the step machine
/// writes `maxResponseBytes` on `execute` and `observe` effects, a stored response over the
/// lookup bound is 500 `POLICYSQL_INTERNAL` on a keyed retry, and the event and volatile bounds
/// are derived. No identity value changed.
/// 16: ADR 0027 pull request 7 (#56, #60, #66): `check_body_json` and `begin_body_json` are the
/// strict body parse, in core, and the engine uses them instead of its own scan and
/// `JSON.parse`; the client nesting limit is 64 levels (the engine's scan accepted 65, and
/// canonical JSON allowed 127), and a body over it is 400
/// `POLICYSQL_JSON_TOO_DEEP` (a depth limit is no longer "not valid JSON"); JSON-typed
/// parameters are read as their exact text, so their formatting is preserved. No identity
/// value changed.
/// 17: issue #97: an atomic envelope whose response exceeds the adapter's bound (`limit`) is
/// 500 `POLICYSQL_INTERNAL` instead of 413 `POLICYSQL_LIMIT_EXCEEDED` when a statement after the
/// first is a write: Hrana runs the rest of a pipeline after an error, and a later write could
/// have committed in autocommit after an error rolled the transaction back, so the outcome is
/// unknown, never a definite rejection (ADR 0007). No identity value changed.
/// 18: issue #85 path 1: a keyed `request` (engine) or `atomic` input (owner) whose compile
/// fails (including the envelope's `expected` check) is answered 500 `POLICYSQL_INTERNAL`
/// instead of the compile error. The request may be the retry of a write that committed under
/// an earlier policy, schema, or snapshot, so the compile error (a definite rejection) is
/// forbidden; the request is not looked up and a matching row is not replayed without the
/// authorization the compile would have given. An unkeyed request keeps its compile error. No
/// identity value changed.
/// 19: issue #145: the outcome class `constraint` on `executeFailed` (with the statement index, a
/// `constraint` name, and the `databaseCode`) answers 409 `POLICYSQL_CONSTRAINT_VIOLATION` at
/// `/statements/<i>` with `detail.constraint` and a fixed message per kind, for an atomic or an
/// interactive statement; the same database error was 503 `POLICYSQL_DATABASE_UNAVAILABLE`
/// (class `unavailable`). On the idempotency lookup or insert, a callback query, COMMIT, and any
/// event other than `executeFailed`, the class is 500 `POLICYSQL_INTERNAL`. An error reply may
/// carry `detail`; a forwarded owner reply is read with it and checked against the code. The
/// machine writes the log event `database_constraint_violation`. No identity value changed.
/// 20: issue #145 pull request B: a policy `check` that is not SQL TRUE for a changed row
/// answers 403 `POLICYSQL_CHECK_FAILED` at `/statements/<i>` (was 422 `POLICYSQL_SCHEMA_MISMATCH`),
/// and a keyed atomic execute that does not compile answers 500 `POLICYSQL_OUTCOME_UNKNOWN` with
/// `detail.cause` (`code`, `path`) (was `POLICYSQL_INTERNAL`). No identity value changed.
/// 21: issue #145 pull request C: the compile and result-validation errors carry `error.detail`
/// where the public table has a row (`feature`, `span`, `reason`, `complexity`,
/// `expectation`), a keyed `POLICYSQL_OUTCOME_UNKNOWN`'s `cause` gains `detail`, a database
/// complexity refusal names its `complexity`, `compile_json`'s error envelope may carry a `log`
/// record, and the machine writes the log event `rejection_reason`. No identity value changed.
/// 22: issue #145 pull request D: the client's SQL is bound against the resources the role has a
/// policy on, so a resource without one and a name that does not exist are both 403
/// `POLICYSQL_MISSING_POLICY` with the message "No policy permits this operation, or the resource
/// does not exist." (a name that does not exist was `POLICYSQL_FORBIDDEN_OPERATION`); a CTE named
/// like a resource the role cannot use is no longer refused. No identity value changed.
/// 23: issue #145 pull request E: the outcome class `refused` on `executeFailed` (the database
/// refused a statement for neither complexity nor a constraint, including a reply that ended the
/// stream) answers 500 `POLICYSQL_DATABASE_ERROR` (was 503 `POLICYSQL_DATABASE_UNAVAILABLE`,
/// class `unavailable`); `POLICYSQL_COMMIT_CHECK_REJECTED` carries `detail.reason` (`denied`,
/// `unavailable`, `limit`, `unconfigured`, `callback`); a forwarded owner reply is checked against
/// that row. No identity value changed.
/// 24: issue #145 pull request F: `POLICYSQL_LIMIT_EXCEEDED`, `POLICYSQL_REQUEST_TOO_LARGE`, and
/// `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED` carry `detail.limit`, the Capabilities key of the limit
/// (`limits.<name>`, or `transactions.<name>` for the transaction code), where the failing place
/// checks that limit itself; a derived or fixed bound and the adapter class `limit` carry none;
/// `check_body_json` and `begin_body_json` errors may carry `detail`; a forwarded owner reply is
/// checked against those rows. No identity value changed.
/// 25: issue #162: `compile_json` takes a fourth argument, the request context JSON
/// `{"nowMs": <integer>}`, and a preset may be `{ now: {} }` (the compile's time, ADR 0031);
/// the machine's `Compiler::compile` takes the step's `now_ms`. No identity value changed.
const ABI_VERSION: u32 = 25;
/// The fixed JSON levels the machine adds when it wraps an interactive command in the
/// one-statement envelope `{"statements":[{"sql":...,"params":...}]}`: the envelope object and
/// the statement object. A client command at [`policysql_transaction::strict::MAX_DEPTH`] must
/// still compile, so the internal envelope check allows those two server-added levels; the
/// client body limit stays [`policysql_transaction::strict::MAX_DEPTH`].
const COMPILE_ENVELOPE_DEPTH: usize = 2;
const PROFILE_ID: &str = "sqlite-turso-v1";
const MAX_CONFIGURATION_BYTES: usize = 1_048_576;
const MAX_ACTIVE_EXECUTIONS: usize = 64;

mod limits;
mod result_budget;
mod session;
mod step;

#[cfg(test)]
mod bytes_tests;
#[cfg(test)]
mod detail_tests;
#[cfg(test)]
mod now_tests;
#[cfg(test)]
mod nullable_tests;
#[cfg(test)]
mod resource_tests;
#[cfg(test)]
mod result_budget_tests;
#[cfg(test)]
mod step_tests;
#[cfg(test)]
mod value_limit_tests;

/// Compiler-resolved client parameter contracts (type and NULL proof), by name.
type ParameterTypes = BTreeMap<ClientParameterName, policysql_sqlite::ClientParameterContract>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogManifest {
    version: u32,
    resources: BTreeMap<String, CatalogResource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogResource {
    source: CatalogSource,
    columns: BTreeMap<String, CatalogColumn>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogSource {
    table: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogColumn {
    #[serde(rename = "type")]
    logical_type: Option<String>,
    representation: Option<String>,
    storage: Option<String>,
    nullable: Option<bool>,
    format: Option<String>,
    #[serde(default)]
    constraints: Option<serde_yaml::Value>,
    #[serde(rename = "jsonSchema", default)]
    json_schema: Option<serde_yaml::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PhysicalSchema {
    tables: BTreeMap<String, PhysicalTable>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PhysicalTable {
    columns: BTreeMap<String, PhysicalColumn>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhysicalColumn {
    declared_type: String,
    nullable: bool,
}

/// The engine's request context (`compile_json`'s fourth argument, ADR 0031). #163 adds
/// `entropy`; any other member is refused.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompileContextInput {
    now_ms: u64,
}

/// The longest context JSON read; the engine's own value is far shorter.
const MAX_CONTEXT_JSON_BYTES: usize = 256;

fn parse_compile_context(context_json: &str) -> Option<CompileContext> {
    if context_json.len() > MAX_CONTEXT_JSON_BYTES {
        return None;
    }
    let input: CompileContextInput = serde_json::from_str(context_json).ok()?;
    CompileContext::new(input.now_ms)
}

/// The context the runtime tests compile with: 2026-10-30T13:14:56.789Z.
#[cfg(test)]
pub(crate) const TEST_CONTEXT: &str = r#"{"nowMs":1793366096789}"#;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AtomicRequest {
    expected: Option<ExpectedSnapshot>,
    statements: Vec<RequestStatement>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedSnapshot {
    schema_version: String,
    policy_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestStatement {
    sql: String,
    /// Exact text per parameter: a JSON-typed parameter is kept as its input text instead of a
    /// tree (ADR 0027 pull request 7); the strict body check already validated it.
    params: BTreeMap<String, Box<serde_json::value::RawValue>>,
    expect: Option<RequestExpectation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestExpectation {
    affected_rows: Option<u64>,
    row_count: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileResponse {
    abi_version: u32,
    profile: &'static str,
    schema_version: String,
    policy_version: String,
    snapshot: String,
    transaction_mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_handle: Option<u64>,
    statements: Vec<CompiledStatementDto>,
    commit_checks: Vec<CommitCheckDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitCheckDto {
    id: String,
    triggered_by: Vec<String>,
    role: Option<String>,
    timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawExecuteResult {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    affected_rows: u64,
}

/// The byte length the raw result would have as JSON, without building the text: the same
/// `{"columns":...,"rows":...,"affectedRows":...}` serialization the bound was measured on
/// (ADR 0027 pull request 7).
fn raw_result_bytes(raw: &policysql_transaction::machine::RawResult) -> u64 {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RawResultWire<'a> {
        columns: &'a [String],
        rows: &'a [Vec<serde_json::Value>],
        affected_rows: u64,
    }

    struct Counter(u64);
    impl std::io::Write for Counter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .saturating_add(u64::try_from(buffer.len()).unwrap_or(u64::MAX));
            Ok(buffer.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let wire = RawResultWire {
        columns: &raw.columns,
        rows: &raw.rows,
        affected_rows: raw.affected_rows,
    };
    let mut counter = Counter(0);
    match serde_json::to_writer(&mut counter, &wire) {
        Ok(()) => counter.0,
        // A `serde_json::Value` always serializes; treating an impossible failure as over
        // every bound keeps it a result-size rejection rather than an internal error.
        Err(_) => u64::MAX,
    }
}

/// The strict body check's success (`check_body_json`); the text itself is checked and dropped.
#[derive(Serialize)]
struct BodyOk {
    ok: bool,
}

/// A body check's client-facing error. The code is one the public table documents: the engine
/// maps it to an `EngineError` and never invents one.
#[derive(Serialize)]
struct BodyErrorEnvelope {
    error: BodyErrorBody,
}

#[derive(Serialize)]
struct BodyErrorBody {
    code: &'static str,
    message: &'static str,
    /// The Capabilities key of the body limit that was crossed (#145 pull request F).
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Box<ErrorDetail>>,
}

fn body_error(error: BodyErrorBody) -> String {
    serialize_or_internal(&BodyErrorEnvelope { error })
}

/// `begin_body_json`'s success: what the engine used to read from `JSON.parse` (ADR 0027 pull
/// request 7). `expected` is omitted when the body has none, exactly as the engine treats it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BeginBodyResponse {
    ok: bool,
    mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected: Option<serde_json::Value>,
}

/// The begin body's shape, checked after the strict parse. `deny_unknown_fields` and the
/// required `mode` reproduce the engine's checks; `expected`, when the member is present, must
/// be an object with exactly the two names the engine compares. `deserialize_present` keeps a
/// present `null` distinct from an absent member (both used to be checked differently).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BeginBody {
    mode: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    expected: Option<serde_json::Value>,
}

fn deserialize_present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}

/// Private ABI value: preserves physical BLOB identity independently of the
/// expected descriptor. Public bytes parameters are strings, never this object.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBlob {
    #[serde(rename = "type")]
    storage_type: String,
    base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatedExecuteResult {
    /// Bytes of raw result text and raw values this result consumed (ADR 0027); the step
    /// machine's cumulative budgets, not part of the public shape.
    #[serde(skip)]
    raw_bytes: u64,
    #[serde(skip)]
    values: u64,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    redactions: Vec<Vec<bool>>,
    affected_rows: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompiledStatementDto {
    operation: &'static str,
    resource: Option<String>,
    operation_check: bool,
    protected_sql: String,
    cost_explain_sql: String,
    client_parameters: BTreeMap<String, serde_json::Value>,
    client_parameter_types: BTreeMap<String, &'static str>,
    client_parameter_nullable: BTreeMap<String, bool>,
    server_parameters: BTreeMap<String, serde_json::Value>,
    result: Vec<ResultColumnDto>,
    limits: LimitsDto,
    expected_affected_rows: Option<u64>,
    expected_result_rows: Option<u64>,
    explain: ExplainDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultColumnDto {
    name: String,
    logical_type: serde_json::Value,
    representation: &'static str,
    nullable: bool,
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraints: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    json_schema: Option<serde_json::Value>,
    redacted_on_null: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LimitsDto {
    max_rows: u64,
    max_result_bytes: u64,
    timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplainDto {
    resource: Option<u64>,
    resources: Vec<u64>,
    resource_names: Vec<String>,
    public_resources: Vec<ExplainResourceDto>,
    applied_policies: Vec<u64>,
    policy_limit: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ExplainResourceDto {
    name: String,
    columns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogResponse {
    schema_version: String,
    policy_version: String,
    role: String,
    resources: Vec<CatalogResourceDto>,
}

#[derive(Debug, Serialize)]
struct CatalogResourceDto {
    name: String,
    operations: CatalogOperationsDto,
}

#[derive(Debug, Serialize)]
struct CatalogOperationsDto {
    select: CatalogSelectDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    insert: Option<CatalogInsertDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    update: Option<CatalogUpdateDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delete: Option<CatalogDeleteDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSelectDto {
    columns: Vec<CatalogColumnDto>,
    allow_aggregations: bool,
    allow_windows: bool,
    max_rows: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogColumnDto {
    name: String,
    #[serde(rename = "type")]
    logical_type: &'static str,
    representation: &'static str,
    nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraints: Option<serde_json::Value>,
    nullable_on_denied: bool,
    usage: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct CatalogInsertDto {
    columns: Vec<CatalogInsertColumnDto>,
    returning: CatalogReturningDto,
}

#[derive(Debug, Serialize)]
struct CatalogUpdateDto {
    columns: Vec<CatalogDescriptorDto>,
    returning: CatalogReturningDto,
}

#[derive(Debug, Serialize)]
struct CatalogDeleteDto {
    returning: CatalogReturningDto,
}

#[derive(Debug, Serialize)]
struct CatalogReturningDto {
    columns: Vec<CatalogColumnDto>,
}

#[derive(Debug, Serialize)]
struct CatalogInsertColumnDto {
    #[serde(flatten)]
    descriptor: CatalogDescriptorDto,
    required: bool,
}

#[derive(Debug, Serialize)]
struct CatalogDescriptorDto {
    name: String,
    #[serde(rename = "type")]
    logical_type: &'static str,
    representation: &'static str,
    nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraints: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
    /// The `rejection_reason` record of a compile error: private to the ABI, read by the
    /// engine for an operation that runs no step machine (Explain), and never part of a
    /// response.
    #[serde(skip_serializing_if = "Option::is_none")]
    log: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct AuthorizedEnvelope {
    auth: session::AuthorizedSession,
}

#[derive(Debug, Serialize)]
struct SessionFaultEnvelope {
    error: ErrorBody,
    fault: session::SessionFault,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<ErrorDetail>,
}

#[wasm_bindgen]
#[derive(Debug)]
pub struct PolicySqlRuntime {
    gateway: Gateway,
    catalog: Catalog,
    policies: PolicyBundle,
    schema_version: String,
    policy_version: String,
    snapshot: SnapshotId,
    limits: limits::RuntimeLimits,
    plans: RefCell<BTreeMap<u64, policysql_gateway::CompiledEnvelope>>,
    next_handle: Cell<u64>,
}

fn build_runtime(
    catalog_yaml: &str,
    policy_yaml: &str,
    schema_version: &str,
    policy_version: &str,
    limits_json: &str,
    physical_schema: Option<&PhysicalSchema>,
) -> Result<PolicySqlRuntime, JsValue> {
    if catalog_yaml.len().saturating_add(policy_yaml.len()) > MAX_CONFIGURATION_BYTES {
        return Err(js_error("configuration exceeds deployment limit"));
    }
    let snapshot_text = format!("{PROFILE_ID}:{schema_version}:{policy_version}:abi-{ABI_VERSION}");
    let snapshot =
        SnapshotId::new(snapshot_text).map_err(|_| js_error("deployment snapshot is invalid"))?;
    let catalog = activate_catalog_with_schema(catalog_yaml, snapshot.clone(), physical_schema)
        .map_err(|_| js_error("Catalog activation failed"))?;
    let limits = limits::parse(
        limits_json,
        &limits::FixedLimits {
            max_commit_checks: policysql_policy::MAX_COMMIT_CHECKS,
            max_hook_duration_ms: policysql_policy::MAX_COMMIT_CHECK_TIMEOUT_MS,
        },
    )
    .map_err(|message| js_error(&message))?;
    // A bytes preset over the configured per-value limit is a configuration error, like every
    // other value the limit bounds.
    let policies = PolicyBundle::activate_with_value_limit(
        policy_yaml,
        &catalog,
        snapshot.clone(),
        value_limit(&limits),
    )
    .map_err(|error| match error {
        policysql_policy::PolicyError::BytesPresetTooLarge => js_error(
            "runtime limits are invalid: `max_bytes_per_value` is smaller than a bytes preset in the policy",
        ),
        _ => js_error("policy activation failed"),
    })?;
    let max_statements = usize::try_from(limits.max_statements)
        .map_err(|_| js_error("runtime limits are invalid: `max_statements` is too large"))?;
    // ADR 0024 "Bounds": a transaction record holds the last statement's reply and one
    // mutation per statement, so these limits must keep it within the durable bound.
    let longest_resource_name = catalog
        .resources()
        .map(|resource| resource.name.as_str().len())
        .max()
        .unwrap_or(0);
    if !policysql_transaction::machine::durable_bound_holds(
        snapshot.as_str().len() * 2 + schema_version.len() + policy_version.len(),
        limits.max_transaction_statements,
        limits.max_transaction_result_bytes,
        longest_resource_name,
    ) {
        return Err(js_error(
            "runtime limits are invalid: `max_transaction_statements` and `max_transaction_result_bytes` could make a transaction record exceed its bound",
        ));
    }
    Ok(PolicySqlRuntime {
        gateway: Gateway::new(
            catalog.clone(),
            policies.clone(),
            snapshot.clone(),
            ExecutionLimits {
                max_rows: limits.max_rows,
                max_result_bytes: limits.max_result_bytes,
                timeout_ms: limits.timeout_ms,
                max_bytes_per_value: value_limit(&limits),
            },
            max_statements,
        )
        .with_binding_limits(binding_limits(&limits)),
        catalog,
        policies,
        schema_version: schema_version.to_owned(),
        policy_version: policy_version.to_owned(),
        snapshot,
        limits,
        plans: RefCell::new(BTreeMap::new()),
        next_handle: Cell::new(1),
    })
}

#[wasm_bindgen]
impl PolicySqlRuntime {
    /// Activates one immutable deployment snapshot.
    ///
    /// # Errors
    ///
    /// Returns a safe JavaScript error when configuration is malformed or inconsistent.
    #[wasm_bindgen(constructor)]
    pub fn new(
        catalog_yaml: &str,
        policy_yaml: &str,
        schema_version: &str,
        policy_version: &str,
        limits_json: &str,
    ) -> Result<Self, JsValue> {
        build_runtime(
            catalog_yaml,
            policy_yaml,
            schema_version,
            policy_version,
            limits_json,
            None,
        )
    }

    /// Activates a snapshot after comparing the manifest with trusted `SQLite`
    /// introspection captured by the deployment Catalog builder.
    ///
    /// # Errors
    ///
    /// Fails closed when a table, column, storage affinity, or nullability does
    /// not match, or when an omitted basic type cannot be derived.
    #[wasm_bindgen(js_name = newWithPhysicalSchema)]
    pub fn new_with_physical_schema(
        catalog_yaml: &str,
        policy_yaml: &str,
        schema_version: &str,
        policy_version: &str,
        limits_json: &str,
        physical_schema_json: &str,
    ) -> Result<Self, JsValue> {
        let physical_schema: PhysicalSchema = serde_json::from_str(physical_schema_json)
            .map_err(|_| js_error("physical schema is invalid"))?;
        build_runtime(
            catalog_yaml,
            policy_yaml,
            schema_version,
            policy_version,
            limits_json,
            Some(&physical_schema),
        )
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn abi_version(&self) -> u32 {
        ABI_VERSION
    }

    /// The effective limits of this runtime as a JSON object with camelCase keys: the
    /// configured ones (defaults filled) and the fixed protocol constants core enforces. The
    /// engine enforces and advertises exactly these values; it holds no copy of its own
    /// (ADR 0024, "One place for limits").
    ///
    /// Every limit of ADR 0027 is a field here, including the per-value limit that used to
    /// be a getter; the engine reads them all from this one report.
    #[must_use]
    pub fn limits_json(&self) -> String {
        serialize_or_internal(&self.limits)
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn profile(&self) -> String {
        PROFILE_ID.to_owned()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn snapshot(&self) -> String {
        self.snapshot.as_str().to_owned()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn commit_checks_enabled(&self) -> bool {
        !self.policies.commit_checks().is_empty()
    }

    /// Compiles an authenticated atomic request into profile-verified statements.
    #[must_use]
    pub fn compile_json(
        &self,
        verified_auth_json: &str,
        request_json: &str,
        permission: &str,
        context_json: &str,
    ) -> String {
        // The context is the engine's own value, never the client's: a malformed one is a 500.
        let Some(context) = parse_compile_context(context_json) else {
            return serialize_or_internal(&ErrorEnvelope {
                error: error_body(RuntimeError::Internal),
                log: None,
            });
        };
        match self.compile(verified_auth_json, request_json, permission, &context) {
            Ok((mut response, compiled)) => {
                if let Some(compiled) = compiled {
                    match self.store_plan(compiled) {
                        Ok(handle) => response.execution_handle = Some(handle),
                        Err(error) => {
                            return serialize_or_internal(&ErrorEnvelope {
                                error: error_body(error),
                                log: None,
                            });
                        }
                    }
                }
                serialize_or_internal(&response)
            }
            Err(error) => serialize_or_internal(&ErrorEnvelope {
                log: Some(refusal_log(self, &error)),
                error: error_body(error),
            }),
        }
    }

    /// Validates a raw remote result against a previously sealed statement.
    #[must_use]
    pub fn validate_result_json(&self, handle: u64, index: usize, raw_result_json: &str) -> String {
        match self.validate_result(handle, index, raw_result_json) {
            Ok(response) => serialize_or_internal(&response),
            Err(error) => serialize_or_internal(&ErrorEnvelope {
                error: error_body(error.at_statement(index)),
                log: None,
            }),
        }
    }

    /// Releases a sealed envelope after commit, rollback, or transport failure.
    pub fn release_execution(&self, handle: u64) -> bool {
        self.plans.borrow_mut().remove(&handle).is_some()
    }

    /// The strict check of an operation's body text (ADR 0027 pull request 7, #60, #66).
    ///
    /// This is the only strict JSON parse of a body: syntax, Unicode escapes (including escaped
    /// lone surrogates), duplicate object keys after escape decoding, `maxJsonValues` (every
    /// value and every member name), and nesting depth ([`policysql_transaction::strict::MAX_DEPTH`]).
    /// The text's UTF-8 byte length is checked against `maxRequestBytes` too, because the engine
    /// no longer encodes the JavaScript string to measure it. Returns `{"ok":true}` or
    /// `{"error":{"code":...,"message":...}}` with a code from the public status table.
    #[must_use]
    pub fn check_body_json(&self, body_text: &str) -> String {
        let limits = self.machine_limits();
        match check_body(body_text, &limits) {
            Ok(()) => serialize_or_internal(&BodyOk { ok: true }),
            Err(error) => body_error(error),
        }
    }

    /// The strict check and typed read of an interactive `begin` body, in one call: returns
    /// `{"ok":true,"mode":"read"|"write","expected":{...}}` or the same error envelope as
    /// [`Self::check_body_json`]. The shape rules are the engine's (ADR 0024): exactly `mode`
    /// and optionally `expected`, which has exactly `schemaVersion` and `policyVersion`.
    #[must_use]
    pub fn begin_body_json(&self, body_text: &str) -> String {
        let limits = self.machine_limits();
        if let Err(error) = check_body(body_text, &limits) {
            return body_error(error);
        }
        let Ok(body) = serde_json::from_str::<BeginBody>(body_text) else {
            return body_error(invalid_request_body());
        };
        let mode = match body.mode.as_str() {
            "read" => "read",
            "write" => "write",
            _ => return body_error(invalid_request_body()),
        };
        let expected = match body.expected {
            None => None,
            Some(serde_json::Value::Object(members))
                if members.len() == 2
                    && members.contains_key("schemaVersion")
                    && members.contains_key("policyVersion") =>
            {
                Some(serde_json::Value::Object(members))
            }
            Some(_) => return body_error(invalid_request_body()),
        };
        serialize_or_internal(&BeginBodyResponse {
            ok: true,
            mode,
            expected,
        })
    }

    /// Validates a wrapper-supplied trusted session, selects the role named by the
    /// `PolicySQL-Role` header (or `defaultRole` when absent), and checks the endpoint's
    /// required access. This is the only place these rules exist.
    ///
    /// Returns `{"auth": {...}}` with the canonical result that `compile_json` and
    /// `catalog_json` accept, `{"error": {"code": "POLICYSQL_FORBIDDEN_ACCESS", ...}}`
    /// for a client-caused denial, or `{"error": {"code": "POLICYSQL_INTERNAL", ...},
    /// "fault": "<part>"}` when the session itself violates the contract. `fault` names
    /// the malformed part and never contains a session value.
    #[must_use]
    #[allow(clippy::unused_self, clippy::needless_pass_by_value)]
    pub fn authorize_session_json(
        &self,
        session_json: &str,
        requested_role: Option<String>,
        required_access: &str,
    ) -> String {
        let Some(required) = session::parse_access(required_access) else {
            return serialize_or_internal(&ErrorEnvelope {
                error: error_body(RuntimeError::Internal),
                log: None,
            });
        };
        let outcome = if session_json.len() > policysql_transaction::bounds::SESSION_INPUT_BYTES {
            Err(session::SessionError::Malformed(
                session::SessionFault::Shape,
            ))
        } else {
            serde_json::from_str::<session::SessionInput>(session_json)
                .map_err(|_| session::SessionError::Malformed(session::SessionFault::Shape))
                .and_then(|input| {
                    session::authorize_session(input, requested_role.as_deref(), required)
                })
        };
        match outcome {
            Ok((auth, _)) => serialize_or_internal(&AuthorizedEnvelope { auth }),
            Err(session::SessionError::Malformed(fault)) => {
                serialize_or_internal(&SessionFaultEnvelope {
                    error: error_body(RuntimeError::Session),
                    fault,
                })
            }
            Err(session::SessionError::Forbidden) => serialize_or_internal(&ErrorEnvelope {
                error: error_body(RuntimeError::Access),
                log: None,
            }),
        }
    }

    /// Computes a request identity, fingerprint, or command digest with core's canonical
    /// JSON and SHA-256 (ADR 0024 pull request 2, ADR 0025). The input and output contract is
    /// [`policysql_transaction::identity_json`]; bodies are passed as their exact text.
    ///
    /// ADR 0025 made core's canonical form the only definition, which changes this method's
    /// values for some inputs, so it bumped `ABI_VERSION` to 5. `keyHash`, the auth and start
    /// fingerprints, and the `{sequence}` digests are unchanged
    /// (`tests/fixtures/identity-goldens.json`). Removing the binding's `snapshot` from the
    /// request fingerprint (#80) changed its values again and bumped `ABI_VERSION` to 9. The key syntax of #65 (`+ / =` accepted,
    /// a malformed key answered `POLICYSQL_IDEMPOTENCY_KEY_INVALID`) bumped it to 10; `keyHash` and
    /// every golden are unchanged.
    #[must_use]
    #[allow(clippy::unused_self)]
    pub fn identity_json(&self, input_json: &str) -> String {
        policysql_transaction::identity_json(
            input_json,
            self.machine_limits().max_hash_input_bytes(),
        )
    }

    /// One step of the transaction machine (ADR 0024): the current durable and volatile state
    /// (the JSON texts a previous step returned, or `None`), one event, and the host facts.
    /// Returns `{"durable": string|null, "volatile": string|null, "effects": [...]}`; the engine
    /// keeps both texts verbatim, writes `durable` when an effect says `persist`, and passes
    /// both back with the next event. Invalid host facts or an unreadable event give
    /// `{"error":{"code":"POLICYSQL_INTERNAL",...}}` and no state. The contract is
    /// [`policysql_transaction::machine`].
    ///
    /// Adding this method bumped `ABI_VERSION` to 6; commit checks and callbacks (pull request
    /// 5) changed what it returns for some inputs and bumped it to 7; atomic execution (pull
    /// request 6: an `atomic` input is executed instead of answered `POLICYSQL_INTERNAL`, the
    /// `request` event, `Execute.trace`, and the `Observe` context) bumped it to 8. Production
    /// owners call it for interactive transactions since ADR 0024 pull request 7, and the
    /// engine and owners for atomic execution since pull request 8. Pull request 8 added the
    /// outcome class `limit` without a bump: every input this method read before is answered
    /// byte for byte as before (the transcripts replay unchanged), only an `executeFailed` it
    /// rejected as unreadable is now read, and keeping the snapshot is what keeps keyed atomic
    /// retries replaying across that deployment. #65 changed what an atomic `request` with a
    /// malformed key is answered (`POLICYSQL_IDEMPOTENCY_KEY_INVALID`, a new message) and which keys
    /// it accepts (`+ / =`), and bumped `ABI_VERSION` to 10. #85 changed what an owner answers
    /// when the Worker's snapshot is not its own for an `atomic` input
    /// (`POLICYSQL_INTERNAL`, the version-skew answer, instead of
    /// `POLICYSQL_TRANSACTION_CONFLICT`, which a client takes as a rejection), and bumped
    /// `ABI_VERSION` to 11; no identity value changed. #54 changed what a commit whose adapter
    /// proved that no COMMIT was sent (`commitFailed` with class `not_committed`) answers:
    /// `POLICYSQL_TRANSACTION_UNAVAILABLE` (a definite rejection) for an atomic execution (was
    /// `POLICYSQL_INTERNAL`) and for an interactive commit (was a 200 with status `failed`), and
    /// bumped `ABI_VERSION` to 12; no identity value changed. #145 added the outcome class
    /// `constraint` and `error.detail` (409 `POLICYSQL_CONSTRAINT_VIOLATION`) and bumped
    /// `ABI_VERSION` to 19; no identity value changed. #145 pull request B changed the answer
    /// to a failed policy `check` (403 `POLICYSQL_CHECK_FAILED`, was 422
    /// `POLICYSQL_SCHEMA_MISMATCH`) and to a keyed compile failure (500
    /// `POLICYSQL_OUTCOME_UNKNOWN` with `error.detail.cause`, was `POLICYSQL_INTERNAL`), and
    /// bumped `ABI_VERSION` to 20; no identity value changed.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)]
    pub fn step_json(
        &self,
        durable_json: Option<String>,
        volatile_json: Option<String>,
        event_json: &str,
        host_json: &str,
    ) -> String {
        policysql_transaction::machine::step_json(
            &step::RuntimeCompiler(self),
            &self.machine_limits(),
            durable_json.as_deref(),
            volatile_json.as_deref(),
            event_json,
            host_json,
        )
    }

    /// Evaluates the cost of one envelope from the `EXPLAIN QUERY PLAN` results an `Observe`
    /// effect's statements returned and the wrapper's cost catalog (ADR 0024 "Cost"). The
    /// engine only logs the result: cost admits or rejects nothing. The contract is
    /// [`policysql_transaction::cost`].
    #[must_use]
    pub fn cost_estimate_json(&self, input_json: &str) -> String {
        policysql_transaction::cost_estimate_json(
            input_json,
            self.machine_limits().max_hash_input_bytes(),
        )
    }

    /// Returns the activated, role-visible logical Catalog.
    #[must_use]
    pub fn catalog_json(&self, verified_auth_json: &str) -> String {
        match self.catalog(verified_auth_json) {
            Ok(response) => serialize_or_internal(&response),
            Err(error) => serialize_or_internal(&ErrorEnvelope {
                error: error_body(error),
                log: None,
            }),
        }
    }
}

/// The per-value bytes limit as the codecs take it. Construction bounds it by the hard maximum,
/// which fits `usize` on every target.
fn value_limit(limits: &limits::RuntimeLimits) -> usize {
    usize::try_from(limits.max_bytes_per_value).unwrap_or(usize::MAX)
}

/// The strict check before the compiler's typed read (ADR 0027 pull request 7). The engine
/// checked the client body, but compile is also reachable from a host that skipped that check:
/// syntax, duplicates, and depth are re-checked, and the value count stays the body's own limit,
/// enforced there. The typed read never sees text this check rejected, so a duplicate key cannot
/// silently keep its last value.
///
/// An interactive command arrives wrapped in the machine envelope (two fixed levels of server
/// JSON); those levels are not client nesting, so they may not turn a body that passed the
/// client limit into an envelope error. Atomic request envelopes are already wrapped by the
/// client, so the allowance is unused for them.
fn check_compile_input(request_json: &str) -> Result<(), RuntimeError> {
    policysql_transaction::strict::check_with_max_depth(
        request_json,
        None,
        policysql_transaction::strict::MAX_DEPTH + COMPILE_ENVELOPE_DEPTH,
    )
    .map_err(|_| RuntimeError::Envelope)
}

/// The body check shared by `check_body_json` and `begin_body_json` (ADR 0027 pull request 7).
fn check_body(
    body_text: &str,
    limits: &policysql_transaction::machine::Limits,
) -> Result<(), BodyErrorBody> {
    if body_text.len() > limits.max_request_bytes() {
        return Err(BodyErrorBody {
            code: "POLICYSQL_REQUEST_TOO_LARGE",
            message: "Request body exceeds the size limit.",
            detail: Some(Box::new(ErrorDetail::limit(
                LimitName::MaxRequestBytes.name(),
            ))),
        });
    }
    let max_values = usize::try_from(limits.max_json_values).unwrap_or(usize::MAX);
    match policysql_transaction::strict::check(body_text, Some(max_values)) {
        Ok(()) => Ok(()),
        Err(policysql_transaction::StrictError::TooManyValues) => Err(BodyErrorBody {
            code: "POLICYSQL_REQUEST_TOO_LARGE",
            message: "Request body has too many JSON values.",
            detail: Some(Box::new(ErrorDetail::limit(
                LimitName::MaxJsonValues.name(),
            ))),
        }),
        Err(policysql_transaction::StrictError::TooDeep) => Err(BodyErrorBody {
            code: "POLICYSQL_JSON_TOO_DEEP",
            message: "Request body nests too deeply.",
            detail: None,
        }),
        Err(policysql_transaction::StrictError::LoneSurrogate) => Err(BodyErrorBody {
            code: "POLICYSQL_INVALID_REQUEST",
            message: "Request body is not valid UTF-8.",
            detail: None,
        }),
        Err(
            policysql_transaction::StrictError::Syntax
            | policysql_transaction::StrictError::DuplicateKey,
        ) => Err(BodyErrorBody {
            code: "POLICYSQL_INVALID_REQUEST",
            message: "Request body is not valid JSON.",
            detail: None,
        }),
    }
}

/// The engine's `invalidRequest()` answer for a begin body of the wrong shape (not JSON
/// syntax: a JSON document whose members are not `mode`/`expected` as ADR 0024 defines them).
fn invalid_request_body() -> BodyErrorBody {
    BodyErrorBody {
        code: "POLICYSQL_INVALID_REQUEST",
        message: "The request is invalid.",
        detail: None,
    }
}

fn binding_limits(limits: &limits::RuntimeLimits) -> policysql_parser::BindingLimits {
    policysql_parser::BindingLimits {
        max_expression_depth: usize::try_from(limits.max_expression_depth).unwrap_or(usize::MAX),
        max_parameters: usize::try_from(limits.max_parameters).unwrap_or(usize::MAX),
        max_projections: usize::try_from(limits.max_projections).unwrap_or(usize::MAX),
        max_joins: usize::try_from(limits.max_joins).unwrap_or(usize::MAX),
    }
}

impl PolicySqlRuntime {
    /// The input-side limits of the binder, from the runtime's configured limits.
    fn binding_limits(&self) -> policysql_parser::BindingLimits {
        binding_limits(&self.limits)
    }

    fn store_plan(
        &self,
        compiled: policysql_gateway::CompiledEnvelope,
    ) -> Result<u64, RuntimeError> {
        let mut plans = self.plans.borrow_mut();
        if plans.len() >= MAX_ACTIVE_EXECUTIONS {
            return Err(RuntimeError::Busy);
        }
        let handle = self.next_handle.get();
        let next = handle.checked_add(1).ok_or(RuntimeError::Busy)?;
        self.next_handle.set(next);
        plans.insert(handle, compiled);
        Ok(handle)
    }

    /// The raw result bound of a sealed envelope (ADR 0027 "Derived internal bounds"), computed
    /// from the compiled statements: `2P + 64·C + Σ 512 + M + 1,024`.
    fn raw_result_bound(&self, handle: u64) -> Result<u64, RuntimeError> {
        let plans = self.plans.borrow();
        let envelope = plans.get(&handle).ok_or(RuntimeError::Internal)?;
        let mut statements = Vec::with_capacity(envelope.statements.len());
        let mut metadata_bytes = 0_u64;
        for statement in &envelope.statements {
            let plan = &statement.plan;
            let emitted = plan.result().len()
                + plan
                    .result()
                    .iter()
                    .filter(|column| column.visibility_column.is_some())
                    .count()
                + usize::from(plan.operation_check_column().is_some());
            statements.push((
                plan.limits().max_rows,
                u64::try_from(emitted).unwrap_or(u64::MAX),
            ));
            metadata_bytes = metadata_bytes.saturating_add(plan.column_metadata_bytes());
        }
        Ok(policysql_transaction::bounds::raw_result_bound(
            self.limits.max_result_bytes,
            self.limits.max_json_values,
            &statements,
            metadata_bytes,
        ))
    }

    /// The whole result budget of one statement: its envelope's raw bound and the value limit.
    fn statement_result_budget(
        &self,
        handle: u64,
    ) -> Result<policysql_transaction::machine::ResultBudget, RuntimeError> {
        Ok(policysql_transaction::machine::ResultBudget {
            raw_bytes: self.raw_result_bound(handle)?,
            values: self.limits.max_json_values,
            result_bytes: u64::MAX,
        })
    }

    fn validate_result(
        &self,
        handle: u64,
        index: usize,
        raw_result_json: &str,
    ) -> Result<ValidatedExecuteResult, RuntimeError> {
        let budget = self
            .statement_result_budget(handle)
            .map_err(|_| RuntimeError::RemoteResult)?;
        self.validate_result_within(handle, index, raw_result_json, budget)
    }

    #[allow(clippy::too_many_lines)]
    fn validate_result_within(
        &self,
        handle: u64,
        index: usize,
        raw_result_json: &str,
        budget: policysql_transaction::machine::ResultBudget,
    ) -> Result<ValidatedExecuteResult, RuntimeError> {
        // The raw result is database output, not a client envelope: exceeding the
        // result-side bound is a result-size limit (413), never an invalid request. It is
        // checked before a byte is parsed, against what the earlier statements left.
        let raw_bytes = u64::try_from(raw_result_json.len()).unwrap_or(u64::MAX);
        if raw_bytes > budget.raw_bytes {
            // The raw bound is derived from several limits: no `detail.limit`.
            return Err(rejected(RejectionKind::LimitExceeded, "result.RawBytes"));
        }
        let raw: RawExecuteResult =
            serde_json::from_str(raw_result_json).map_err(|_| RuntimeError::RemoteResult)?;
        self.validate_result_parts(
            handle,
            index,
            raw.columns,
            raw.rows,
            raw.affected_rows,
            raw_bytes,
            budget,
        )
    }

    /// Validates the step machine's typed raw result without turning it back into JSON text
    /// (ADR 0027 pull request 7): the machine had the rows already, and the previous
    /// re-serialization parsed a second full copy. `raw_bytes` is the same length the old
    /// serialization had, measured by writing it to a counter instead of a string.
    fn validate_raw_result_within(
        &self,
        handle: u64,
        index: usize,
        raw: policysql_transaction::machine::RawResult,
        budget: policysql_transaction::machine::ResultBudget,
    ) -> Result<ValidatedExecuteResult, RuntimeError> {
        let raw_bytes = raw_result_bytes(&raw);
        if raw_bytes > budget.raw_bytes {
            // The raw bound is derived from several limits: no `detail.limit`.
            return Err(rejected(RejectionKind::LimitExceeded, "result.RawBytes"));
        }
        self.validate_result_parts(
            handle,
            index,
            raw.columns,
            raw.rows,
            raw.affected_rows,
            raw_bytes,
            budget,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn validate_result_parts(
        &self,
        handle: u64,
        index: usize,
        columns: Vec<String>,
        rows: Vec<Vec<serde_json::Value>>,
        affected_rows: u64,
        raw_bytes: u64,
        budget: policysql_transaction::machine::ResultBudget,
    ) -> Result<ValidatedExecuteResult, RuntimeError> {
        let plans = self.plans.borrow();
        let statement = plans
            .get(&handle)
            .and_then(|envelope| envelope.statements.get(index))
            .ok_or(RuntimeError::RemoteResult)?;
        let mut expected_types = statement
            .plan
            .result()
            .iter()
            .flat_map(|column| {
                std::iter::once(column.possible_types.clone()).chain(
                    column
                        .visibility_column
                        .iter()
                        .map(|_| vec![LogicalType::Boolean]),
                )
            })
            .collect::<Vec<_>>();
        if statement.plan.operation_check_column().is_some() {
            expected_types.push(vec![LogicalType::Boolean]);
        }
        // Raw values, counted from the descriptors on and stopping at the first row over the
        // limit (ADR 0027): the column descriptors, every cell, and every value inside a
        // JSON-typed cell.
        let values_limit = budget.values;
        let mut values = u64::try_from(columns.len()).unwrap_or(u64::MAX);
        let over_limit = || limit_exceeded(LimitName::MaxJsonValues, "result.Values");
        if values > values_limit {
            return Err(over_limit());
        }
        let mut converted_rows = Vec::with_capacity(rows.len());
        for row in rows {
            values = values.saturating_add(u64::try_from(row.len()).unwrap_or(u64::MAX));
            if values > values_limit {
                return Err(over_limit());
            }
            let mut converted = Vec::with_capacity(row.len());
            for (column, value) in row.into_iter().enumerate() {
                let expected = expected_types
                    .get(column)
                    .ok_or(RuntimeError::RemoteResult)?;
                if expected.contains(&LogicalType::Json)
                    && let serde_json::Value::String(text) = &value
                {
                    let inside = result_budget::count_json_values(text, values_limit - values)
                        .ok_or_else(over_limit)?;
                    values += inside;
                }
                converted.push(logical_result_value(
                    value_limit(&self.limits),
                    value,
                    expected,
                )?);
            }
            converted_rows.push(converted);
        }
        let mut result = policysql_turso::ExecuteResult {
            columns,
            rows: converted_rows,
            redactions: Vec::new(),
            affected_rows,
        };
        policysql_turso::validate_sealed_result_within(
            &statement.plan,
            &mut result,
            budget.result_bytes,
        )
        .map_err(|error| match error {
            policysql_turso::AdapterError::ExpectationFailed(kind) => {
                RuntimeError::Rejected(Rejection {
                    kind: RejectionKind::ExpectationFailed,
                    detail: Some(RejectionDetail::Expectation(kind)),
                    reason: match kind {
                        ExpectationKind::AffectedRows => "result.AffectedRows",
                        ExpectationKind::RowCount => "result.RowCount",
                    },
                    shape: None,
                })
            }
            policysql_turso::AdapterError::LimitExceeded(limit) => {
                limit_exceeded(limit, "result.Limit")
            }
            policysql_turso::AdapterError::CheckFailed => RuntimeError::CheckFailedAt(index),
            _ => RuntimeError::RemoteResult,
        })?;
        Ok(ValidatedExecuteResult {
            raw_bytes,
            values,
            columns: result.columns,
            rows: result
                .rows
                .iter()
                .map(|row| {
                    row.iter()
                        .map(encode_result_value)
                        .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, _>>()?,
            redactions: result.redactions,
            affected_rows: result.affected_rows,
        })
    }

    fn catalog(&self, verified_auth_json: &str) -> Result<CatalogResponse, RuntimeError> {
        // The auth comes from `authorize_session_json`, never from the client: one over its
        // derived bound is the engine's or wrapper's inconsistency (500), not a bad request.
        if verified_auth_json.len() > policysql_transaction::bounds::AUTH_BYTES {
            return Err(RuntimeError::AuthTooLarge);
        }
        let auth = activate_auth(verified_auth_json, EndpointPermission::Catalog)?;
        let role = auth.session().role();
        let resources =
            self.catalog
                .resources()
                .filter_map(|resource| {
                    let access = self.policies.select_access(resource.id, role)?;
                    let columns = resource
                        .columns()
                        .filter_map(|column| {
                            let regular = access.regular_columns.contains(&column.id);
                            let conditional = access.conditional_columns.contains(&column.id);
                            (regular || conditional).then(|| CatalogColumnDto {
                                name: column.name.as_str().to_owned(),
                                logical_type: logical_type_name(column.value.logical_type),
                                representation: catalog_representation_name(
                                    column.value.representation,
                                ),
                                nullable: column.value.nullable,
                                format: column.value.format.clone(),
                                constraints: constraints_json(column.value.constraints.as_ref()),
                                nullable_on_denied: conditional,
                                usage: select_column_usage(
                                    conditional,
                                    access.allow_aggregations,
                                    access.allow_windows,
                                ),
                            })
                        })
                        .collect();
                    Some(CatalogResourceDto {
                        name: resource.name.as_str().to_owned(),
                        operations: CatalogOperationsDto {
                            select: CatalogSelectDto {
                                columns,
                                allow_aggregations: access.allow_aggregations,
                                allow_windows: access.allow_windows,
                                max_rows: access.max_rows.unwrap_or(self.gateway.limits().max_rows),
                            },
                            insert: self.policies.insert_access(resource.id, role).map(
                                |mutation| CatalogInsertDto {
                                    columns: mutation
                                        .columns
                                        .iter()
                                        .filter_map(|id| resource.column_by_id(*id))
                                        .map(|column| CatalogInsertColumnDto {
                                            required: !column.value.nullable,
                                            descriptor: catalog_descriptor(column),
                                        })
                                        .collect(),
                                    returning: CatalogReturningDto {
                                        columns: returning_columns(resource, &mutation.returning),
                                    },
                                },
                            ),
                            update: self.policies.update_access(resource.id, role).map(
                                |mutation| CatalogUpdateDto {
                                    columns: mutation
                                        .columns
                                        .iter()
                                        .filter_map(|id| resource.column_by_id(*id))
                                        .map(catalog_descriptor)
                                        .collect(),
                                    returning: CatalogReturningDto {
                                        columns: returning_columns(resource, &mutation.returning),
                                    },
                                },
                            ),
                            delete: self.policies.delete_access(resource.id, role).map(
                                |mutation| CatalogDeleteDto {
                                    returning: CatalogReturningDto {
                                        columns: returning_columns(resource, &mutation.returning),
                                    },
                                },
                            ),
                        },
                    })
                })
                .collect();
        Ok(CatalogResponse {
            schema_version: self.schema_version.clone(),
            policy_version: self.policy_version.clone(),
            role: role.as_str().to_owned(),
            resources,
        })
    }

    #[allow(clippy::too_many_lines)]
    fn compile(
        &self,
        verified_auth_json: &str,
        request_json: &str,
        permission: &str,
        context: &CompileContext,
    ) -> Result<(CompileResponse, Option<policysql_gateway::CompiledEnvelope>), RuntimeError> {
        // The derived bounds of ADR 0027. The auth is our own value (see `catalog`): over its
        // bound is a 500. The body is the client's: the engine already enforced
        // `max_request_bytes`, and over the derived bound is the configured limit's 413.
        let max_request_bytes = self.machine_limits().max_request_bytes();
        if verified_auth_json.len() > policysql_transaction::bounds::AUTH_BYTES {
            return Err(RuntimeError::AuthTooLarge);
        }
        // The envelope the engine or an owner builds around a body (an interactive command is
        // wrapped as a one-statement envelope) can be a few bytes longer than the body, so the
        // bound is the derived compile input, not `max_request_bytes` itself.
        if verified_auth_json.len().saturating_add(request_json.len())
            > policysql_transaction::bounds::compile_input_bytes(max_request_bytes)
        {
            // Derived from `max_request_bytes` (and the auth's bound): no `detail.limit`.
            return Err(RuntimeError::RequestTooLarge);
        }
        let endpoint = endpoint_permission(permission)?;
        let auth = activate_auth(verified_auth_json, endpoint)?;
        check_compile_input(request_json)?;
        let raw_request: AtomicRequest =
            serde_json::from_str(request_json).map_err(|_| RuntimeError::Envelope)?;
        if raw_request.expected.as_ref().is_some_and(|expected| {
            expected.schema_version != self.schema_version
                || expected.policy_version != self.policy_version
        }) {
            return Err(RuntimeError::Snapshot);
        }
        // More statements than `max_statements` is the configured limit's 413, before any statement
        // is read (an empty envelope stays an invalid request, in the gateway).
        if u64::try_from(raw_request.statements.len()).unwrap_or(u64::MAX)
            > self.limits.max_statements
        {
            return Err(limit_exceeded(
                LimitName::MaxStatements,
                "request.StatementLimit",
            ));
        }
        // Before any statement is parsed: a statement over `max_sql_bytes` costs nothing more.
        if let Some(index) = raw_request.statements.iter().position(|statement| {
            statement.sql.len() > usize::try_from(self.limits.max_sql_bytes).unwrap_or(usize::MAX)
        }) {
            return Err(RuntimeError::SqlTooLargeAt(index));
        }
        // The client's SQL is bound against the resources the role has a policy on: a resource
        // without one is a name that does not exist (#145 pull request D). Only the code after
        // the policy (`compiled_statement`, `publicResources`) reads the whole Catalog.
        let binding = self.gateway.binding_catalog(auth.session().role());
        validate_deployment_surface(&raw_request.statements, binding, self.binding_limits())?;
        let requests = raw_request
            .statements
            .into_iter()
            .enumerate()
            .map(|(index, statement)| {
                statement_request(
                    statement,
                    endpoint,
                    binding,
                    self.binding_limits(),
                    value_limit(&self.limits),
                )
                .map_err(|error| error.at_statement(index))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let compiled = self
            .gateway
            .compile_envelope(&auth, endpoint, Some(&self.snapshot), &requests, context)
            .map_err(runtime_gateway_error)?;
        let transaction_mode =
            if compiled.statements.iter().all(|statement| {
                statement.plan.operation() == policysql_core::OperationKind::Select
            }) {
                "read"
            } else {
                "write"
            };
        let statements = compiled
            .statements
            .iter()
            .map(|statement| compiled_statement(statement, &self.catalog))
            .collect::<Result<Vec<_>, _>>()?;
        let commit_checks = self
            .policies
            .commit_checks()
            .iter()
            .map(|check| CommitCheckDto {
                id: check.id.clone(),
                triggered_by: check
                    .triggered_by
                    .iter()
                    .filter_map(|resource| self.catalog.resource_by_id(*resource))
                    .map(|resource| resource.name.as_str().to_owned())
                    .collect(),
                role: check.role.as_ref().map(|role| role.as_str().to_owned()),
                timeout_ms: check.timeout_ms,
            })
            .collect();
        let retain = (endpoint == EndpointPermission::Execute).then(|| compiled.clone());
        Ok((
            CompileResponse {
                abi_version: ABI_VERSION,
                profile: PROFILE_ID,
                schema_version: self.schema_version.clone(),
                policy_version: self.policy_version.clone(),
                snapshot: self.snapshot.as_str().to_owned(),
                transaction_mode,
                execution_handle: None,
                statements,
                commit_checks,
            },
            retain,
        ))
    }
}

fn catalog_descriptor(column: &policysql_catalog::ColumnDescriptor) -> CatalogDescriptorDto {
    CatalogDescriptorDto {
        name: column.name.as_str().to_owned(),
        logical_type: logical_type_name(column.value.logical_type),
        representation: catalog_representation_name(column.value.representation),
        nullable: column.value.nullable,
        format: column.value.format.clone(),
        constraints: constraints_json(column.value.constraints.as_ref()),
    }
}

fn constraints_json(constraints: Option<&ValueConstraints>) -> Option<serde_json::Value> {
    let constraints = constraints?;
    let mut object = serde_json::Map::new();
    if !constraints.allowed.is_empty() {
        object.insert(
            "enum".to_owned(),
            serde_json::Value::Array(
                constraints
                    .allowed
                    .iter()
                    .map(|value| match value {
                        ConstraintScalar::String(value) => serde_json::Value::String(value.clone()),
                        ConstraintScalar::Boolean(value) => serde_json::Value::Bool(*value),
                        ConstraintScalar::Number(value) => value
                            .parse::<serde_json::Number>()
                            .map_or(serde_json::Value::Null, serde_json::Value::Number),
                    })
                    .collect(),
            ),
        );
    }
    for (name, value) in [
        ("minimum", constraints.minimum.as_deref()),
        ("maximum", constraints.maximum.as_deref()),
    ] {
        if let Some(value) = value.and_then(|value| value.parse::<serde_json::Number>().ok()) {
            object.insert(name.to_owned(), serde_json::Value::Number(value));
        }
    }
    if let Some(value) = constraints.min_length {
        object.insert("minLength".to_owned(), serde_json::Value::from(value));
    }
    if let Some(value) = constraints.max_length {
        object.insert("maxLength".to_owned(), serde_json::Value::from(value));
    }
    if let Some(value) = &constraints.pattern {
        object.insert(
            "pattern".to_owned(),
            serde_json::Value::String(value.clone()),
        );
    }
    Some(serde_json::Value::Object(object))
}

fn json_schema_json(schema: &JsonValueSchema) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    let names = schema
        .types
        .iter()
        .map(|value| {
            serde_json::Value::String(
                match value {
                    JsonSchemaType::Null => "null",
                    JsonSchemaType::Boolean => "boolean",
                    JsonSchemaType::Integer => "integer",
                    JsonSchemaType::Number => "number",
                    JsonSchemaType::String => "string",
                    JsonSchemaType::Array => "array",
                    JsonSchemaType::Object => "object",
                }
                .to_owned(),
            )
        })
        .collect::<Vec<_>>();
    if names.len() == 1 {
        object.insert("type".to_owned(), names[0].clone());
    } else if !names.is_empty() {
        object.insert("type".to_owned(), serde_json::Value::Array(names));
    }
    if !schema.properties.is_empty() {
        object.insert(
            "properties".to_owned(),
            serde_json::Value::Object(
                schema
                    .properties
                    .iter()
                    .map(|(name, value)| (name.clone(), json_schema_json(value)))
                    .collect(),
            ),
        );
    }
    if let Some(items) = &schema.items {
        object.insert("items".to_owned(), json_schema_json(items));
    }
    if !schema.required.is_empty() {
        object.insert(
            "required".to_owned(),
            serde_json::Value::Array(
                schema
                    .required
                    .iter()
                    .cloned()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
    }
    object.insert(
        "additionalProperties".to_owned(),
        serde_json::Value::Bool(schema.additional_properties),
    );
    if !schema.any_of.is_empty() {
        object.insert(
            "anyOf".to_owned(),
            serde_json::Value::Array(schema.any_of.iter().map(json_schema_json).collect()),
        );
    }
    serde_json::Value::Object(object)
}

fn returning_columns(
    resource: &ResourceDescriptor,
    columns: &BTreeSet<policysql_core::ColumnId>,
) -> Vec<CatalogColumnDto> {
    resource
        .columns()
        .filter(|column| columns.contains(&column.id))
        .map(|column| CatalogColumnDto {
            name: column.name.as_str().to_owned(),
            logical_type: logical_type_name(column.value.logical_type),
            representation: catalog_representation_name(column.value.representation),
            nullable: column.value.nullable,
            format: column.value.format.clone(),
            constraints: constraints_json(column.value.constraints.as_ref()),
            nullable_on_denied: false,
            usage: vec!["projection"],
        })
        .collect()
}

fn select_column_usage(
    conditional: bool,
    allow_aggregations: bool,
    allow_windows: bool,
) -> Vec<&'static str> {
    if conditional {
        return vec!["projection"];
    }
    let mut usage = vec!["projection", "predicate", "join", "order"];
    if allow_aggregations {
        usage.extend(["group", "aggregate"]);
    }
    if allow_windows {
        usage.push("window");
    }
    usage
}

fn validate_deployment_surface(
    requests: &[RequestStatement],
    catalog: BindingCatalog<'_>,
    binding_limits: policysql_parser::BindingLimits,
) -> Result<(), RuntimeError> {
    let frontend = SqliteFrontend::new(binding_limits);
    for (index, request) in requests.iter().enumerate() {
        let statement = frontend
            .bind(&request.sql, catalog.get())
            .map_err(|error| RuntimeError::RejectedAt(classify_bind_error(&error), index))?;
        let accepted = match statement {
            BoundStatement::Select(select) => supported_select(&select),
            BoundStatement::ConstantSelect(select) => !select.projections.is_empty(),
            BoundStatement::JsonCollectionSelect(select) => {
                basic_expression(&select.path)
                    && select.predicate.as_ref().is_none_or(basic_expression)
            }
            BoundStatement::Insert(insert) => {
                insert
                    .rows
                    .iter()
                    .flatten()
                    .all(|assignment| basic_expression(&assignment.value))
                    && insert
                        .returning
                        .iter()
                        .all(|projection| basic_expression(&projection.expression))
            }
            BoundStatement::Update(update) => {
                update
                    .assignments
                    .iter()
                    .all(|assignment| basic_expression(&assignment.value))
                    && update.predicate.as_ref().is_none_or(basic_expression)
                    && update
                        .returning
                        .iter()
                        .all(|projection| basic_expression(&projection.expression))
            }
            BoundStatement::Delete(delete) => {
                delete.predicate.as_ref().is_none_or(basic_expression)
                    && delete
                        .returning
                        .iter()
                        .all(|projection| basic_expression(&projection.expression))
            }
        };
        if !accepted {
            return Err(RuntimeError::RejectedAt(
                Rejection::with_detail(
                    RejectionKind::UnsupportedSql,
                    RejectionDetail::Feature(UnsupportedFeature::WindowFunction),
                    "request.Surface",
                ),
                index,
            ));
        }
    }
    Ok(())
}

fn supported_select(select: &BoundSelect) -> bool {
    select.joins.iter().all(|join| basic_expression(&join.on))
        && select
            .projections
            .iter()
            .all(|projection| basic_expression(&projection.expression))
        && select.predicate.as_ref().is_none_or(basic_expression)
        && select.having.as_ref().is_none_or(basic_expression)
        && select.limit.as_ref().is_none_or(basic_expression)
        && select.offset.as_ref().is_none_or(basic_expression)
}

fn basic_expression(expression: &BoundExpr) -> bool {
    match expression {
        BoundExpr::Column(_)
        | BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_) => true,
        BoundExpr::Equal(left, right)
        | BoundExpr::NotEqual(left, right)
        | BoundExpr::Less(left, right)
        | BoundExpr::LessEqual(left, right)
        | BoundExpr::Greater(left, right)
        | BoundExpr::GreaterEqual(left, right)
        | BoundExpr::And(left, right)
        | BoundExpr::Or(left, right)
        | BoundExpr::Like(left, right)
        | BoundExpr::Glob(left, right)
        | BoundExpr::Least(left, right)
        | BoundExpr::Concat(left, right) => basic_expression(left) && basic_expression(right),
        BoundExpr::Not(value) | BoundExpr::IsNull(value) | BoundExpr::CastText(value) => {
            basic_expression(value)
        }
        BoundExpr::In {
            expression, values, ..
        } => basic_expression(expression) && values.iter().all(basic_expression),
        BoundExpr::ConditionalOutput { value, visible_if } => {
            basic_expression(value) && basic_expression(visible_if)
        }
        BoundExpr::Exists(select) => supported_select(select),
        BoundExpr::ScalarFunction { arguments, .. } => arguments.iter().all(basic_expression),
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            branches
                .iter()
                .all(|(condition, value)| basic_expression(condition) && basic_expression(value))
                && else_expression.as_deref().is_none_or(basic_expression)
        }
        BoundExpr::RowNumber { order_by, .. } => !order_by.is_empty(),
    }
}

#[derive(Clone, Copy, Debug)]
enum RuntimeError {
    /// A trusted session that violates the contract: a wrapper or engine fault.
    Session,
    Access,
    Snapshot,
    Envelope,
    EnvelopeAt(usize),
    /// The body, or what is derived from it, is over `max_request_bytes` (413).
    RequestTooLarge,
    /// Statement `n`'s SQL is over `max_sql_bytes` (413, path `/statements/<n>/sql`).
    SqlTooLargeAt(usize),
    Rejected(Rejection),
    RejectedAt(Rejection, usize),
    /// The emitted statement `n` reached a downstream complexity limit (400, ADR 0027).
    TooComplexAt(ComplexityCause, usize),
    /// The emitted SQL of statement `n` did not parse again (500; an emitter bug).
    EmittedSqlInvalidAt(usize),
    Internal,
    /// The trusted auth is over its derived bound: a wrapper fault, answered as `INTERNAL`.
    AuthTooLarge,
    Busy,
    RemoteResult,
    RemoteResultAt(usize),
    /// Statement `n`'s post-state `check` is not SQL TRUE for some changed row (403).
    CheckFailedAt(usize),
}

impl RuntimeError {
    /// The statement the error points at, when it does.
    pub(crate) const fn statement_index(&self) -> Option<usize> {
        match self {
            Self::EnvelopeAt(index)
            | Self::SqlTooLargeAt(index)
            | Self::RejectedAt(_, index)
            | Self::TooComplexAt(_, index)
            | Self::EmittedSqlInvalidAt(index)
            | Self::RemoteResultAt(index)
            | Self::CheckFailedAt(index) => Some(*index),
            Self::Session
            | Self::Access
            | Self::Snapshot
            | Self::Envelope
            | Self::RequestTooLarge
            | Self::Rejected(_)
            | Self::Internal
            | Self::AuthTooLarge
            | Self::Busy
            | Self::RemoteResult => None,
        }
    }

    /// The fixed internal reason of the error, `<stage>.<name>`: logged as `rejection_reason`
    /// and never returned to a client. Never a name, SQL text, or a payload.
    const fn reason(&self) -> &'static str {
        match self {
            Self::Session => "auth.Session",
            Self::Access => "auth.Access",
            Self::Snapshot => "request.Stale",
            Self::Envelope | Self::EnvelopeAt(_) => "request.Envelope",
            Self::RequestTooLarge => "request.TooLarge",
            Self::SqlTooLargeAt(_) => "request.SqlTooLarge",
            Self::AuthTooLarge => "request.AuthTooLarge",
            Self::Rejected(rejection) | Self::RejectedAt(rejection, _) => rejection.reason,
            // Logged by their own events (`sql_too_complex`, `emitted_sql_reparse_failed`).
            Self::TooComplexAt(..) => "compile.TooComplex",
            Self::EmittedSqlInvalidAt(_) => "emit.ReparseFailed",
            Self::Internal => "runtime.Internal",
            Self::Busy => "runtime.Busy",
            Self::RemoteResult | Self::RemoteResultAt(_) => "result.Invalid",
            Self::CheckFailedAt(_) => "result.CheckFailed",
        }
    }

    const fn at_statement(self, index: usize) -> Self {
        match self {
            Self::Envelope => Self::EnvelopeAt(index),
            Self::Rejected(rejection) => Self::RejectedAt(rejection, index),
            Self::RemoteResult => Self::RemoteResultAt(index),
            other => other,
        }
    }
}

#[cfg(test)]
fn activate_catalog(yaml: &str, snapshot: SnapshotId) -> Result<Catalog, RuntimeError> {
    activate_catalog_with_schema(yaml, snapshot, None)
}

#[allow(clippy::too_many_lines)]
fn activate_catalog_with_schema(
    yaml: &str,
    snapshot: SnapshotId,
    physical_schema: Option<&PhysicalSchema>,
) -> Result<Catalog, RuntimeError> {
    let manifest: CatalogManifest = serde_yaml::from_str(yaml)
        .map_err(|_| rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?;
    if manifest.version != 1 || manifest.resources.is_empty() {
        return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
    }
    let resources = manifest
        .resources
        .into_iter()
        .enumerate()
        .map(|(index, (name, resource))| {
            if resource.columns.is_empty() {
                return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
            }
            let physical_table = physical_schema
                .map(|schema| {
                    schema
                        .tables
                        .get(&resource.source.table)
                        .ok_or(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))
                })
                .transpose()?;
            let id = u64::try_from(index + 1)
                .map_err(|_| rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?;
            let columns = resource
                .columns
                .into_iter()
                .map(|(column_name, column)| {
                    let physical_column = physical_table
                        .map(|table| {
                            table
                                .columns
                                .get(&column_name)
                                .ok_or(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))
                        })
                        .transpose()?;
                    let derived_storage = physical_column
                        .map(|column| declared_storage(&column.declared_type))
                        .transpose()?;
                    let (logical_type, default_representation) = if column.logical_type.is_some() {
                        logical_type(column.logical_type.as_deref())?
                    } else {
                        derived_storage
                            .map(derived_logical_type)
                            .ok_or(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?
                    };
                    let representation =
                        representation(column.representation.as_deref(), default_representation)?;
                    if logical_type == LogicalType::Bytes
                        && !matches!(
                            representation,
                            ValueRepresentation::Base64 | ValueRepresentation::String
                        )
                    {
                        return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
                    }
                    validate_format(logical_type, column.format.as_deref())?;
                    let constraints = column
                        .constraints
                        .as_ref()
                        .map(|value| parse_constraints(value, logical_type))
                        .transpose()?;
                    let json_schema = if let Some(schema) = &column.json_schema {
                        if logical_type != LogicalType::Json
                            || representation != ValueRepresentation::Json
                            || !valid_json_value_schema(schema, 0)
                        {
                            return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
                        }
                        Some(parse_json_value_schema(schema)?)
                    } else {
                        None
                    };
                    let storage = column
                        .storage
                        .as_deref()
                        .map(storage_class)
                        .transpose()?
                        .or(derived_storage);
                    if column
                        .storage
                        .as_deref()
                        .map(storage_class)
                        .transpose()?
                        .zip(derived_storage)
                        .is_some_and(|(declared, derived)| declared != derived)
                    {
                        return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
                    }
                    validate_storage(logical_type, storage)?;
                    let nullable = column
                        .nullable
                        .or_else(|| physical_column.map(|column| column.nullable))
                        .unwrap_or(false);
                    if column
                        .nullable
                        .zip(physical_column.map(|column| column.nullable))
                        .is_some_and(|(manifest, physical)| manifest != physical)
                    {
                        return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
                    }
                    let declared_type_bytes =
                        physical_column.map_or(0, |column| column.declared_type.len());
                    Ok((
                        ColumnName::new(column_name).map_err(|_| {
                            rejected(RejectionKind::InvalidRequest, "runtime.Catalog")
                        })?,
                        declared_type_bytes,
                        ValueDescriptor {
                            logical_type,
                            representation,
                            nullable,
                            format: column.format.or_else(|| {
                                (logical_type == LogicalType::Bytes).then(|| "base64".to_owned())
                            }),
                            storage,
                            constraints,
                            json_schema,
                        },
                    ))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let declared = columns
                .iter()
                .map(|(name, bytes, _)| (name.as_str().to_owned(), *bytes))
                .collect::<Vec<_>>();
            let descriptor = ResourceDescriptor::new_with_source(
                ResourceId::new(id)
                    .map_err(|_| rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?,
                ResourceName::new(name)
                    .map_err(|_| rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?,
                ResourceName::new(resource.source.table)
                    .map_err(|_| rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?,
                columns.into_iter().map(|(name, _, value)| (name, value)),
            )
            .map_err(|_| rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?;
            Ok(declared
                .into_iter()
                .fold(descriptor, |descriptor, (column, bytes)| {
                    descriptor.with_declared_type_bytes(&column, bytes)
                }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Catalog::new(snapshot, resources)
        .map_err(|_| rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))
}

fn valid_json_value_schema(value: &serde_yaml::Value, depth: usize) -> bool {
    const KEYS: [&str; 7] = [
        "$schema",
        "type",
        "properties",
        "items",
        "required",
        "additionalProperties",
        "anyOf",
    ];
    if depth > 32 {
        return false;
    }
    let Some(object) = value.as_mapping() else {
        return false;
    };
    if object.is_empty() {
        return false;
    }
    if object
        .keys()
        .any(|key| key.as_str().is_none_or(|key| !KEYS.contains(&key)))
    {
        return false;
    }
    if object.get("$schema").is_some_and(|schema| {
        schema.as_str() != Some("https://json-schema.org/draft/2020-12/schema")
    }) {
        return false;
    }
    if object
        .get("additionalProperties")
        .is_some_and(|value| value.as_bool() != Some(false))
    {
        return false;
    }
    if object
        .get("type")
        .is_some_and(|value| !valid_json_schema_type(value))
    {
        return false;
    }
    let properties = object
        .get("properties")
        .and_then(serde_yaml::Value::as_mapping);
    if object.contains_key("properties")
        && properties.is_none_or(|properties| {
            properties.iter().any(|(name, schema)| {
                name.as_str().is_none_or(str::is_empty)
                    || !valid_json_value_schema(schema, depth + 1)
            })
        })
    {
        return false;
    }
    if object
        .get("items")
        .is_some_and(|items| !valid_json_value_schema(items, depth + 1))
    {
        return false;
    }
    if object.get("required").is_some_and(|required| {
        let Some(required) = required.as_sequence() else {
            return true;
        };
        let mut names = BTreeSet::new();
        required.iter().any(|name| {
            name.as_str().is_none_or(str::is_empty)
                || !names.insert(name.as_str().unwrap_or_default())
                || properties.is_none_or(|properties| !properties.contains_key(name))
        })
    }) {
        return false;
    }
    if object.get("anyOf").is_some_and(|branches| {
        branches.as_sequence().is_none_or(|branches| {
            branches.len() < 2
                || branches
                    .iter()
                    .any(|branch| !valid_json_value_schema(branch, depth + 1))
        })
    }) {
        return false;
    }
    object.contains_key("type") || object.contains_key("anyOf")
}

fn valid_json_schema_type(value: &serde_yaml::Value) -> bool {
    const TYPES: [&str; 7] = [
        "null", "boolean", "integer", "number", "string", "array", "object",
    ];
    if let Some(value) = value.as_str() {
        return TYPES.contains(&value);
    }
    let Some(values) = value.as_sequence() else {
        return false;
    };
    if values.len() < 2 {
        return false;
    }
    let mut unique = BTreeSet::new();
    values.iter().all(|value| {
        value
            .as_str()
            .is_some_and(|value| TYPES.contains(&value) && unique.insert(value))
    })
}

fn parse_json_value_schema(value: &serde_yaml::Value) -> Result<JsonValueSchema, RuntimeError> {
    let object = value
        .as_mapping()
        .ok_or(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?;
    let types = object
        .get("type")
        .map(json_schema_types)
        .transpose()?
        .unwrap_or_default();
    let properties = object
        .get("properties")
        .and_then(serde_yaml::Value::as_mapping)
        .map(|properties| {
            properties
                .iter()
                .map(|(name, schema)| {
                    Ok((
                        name.as_str()
                            .ok_or(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?
                            .to_owned(),
                        parse_json_value_schema(schema)?,
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, RuntimeError>>()
        })
        .transpose()?
        .unwrap_or_default();
    let items = object
        .get("items")
        .map(parse_json_value_schema)
        .transpose()?
        .map(Box::new);
    let required = object
        .get("required")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let any_of = object
        .get("anyOf")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|branches| {
            branches
                .iter()
                .map(parse_json_value_schema)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(JsonValueSchema {
        types,
        properties,
        items,
        required,
        additional_properties: false,
        any_of,
    })
}

fn json_schema_types(value: &serde_yaml::Value) -> Result<Vec<JsonSchemaType>, RuntimeError> {
    let values = value
        .as_sequence()
        .map_or_else(|| vec![value], |values| values.iter().collect());
    values
        .into_iter()
        .map(|value| match value.as_str() {
            Some("null") => Ok(JsonSchemaType::Null),
            Some("boolean") => Ok(JsonSchemaType::Boolean),
            Some("integer") => Ok(JsonSchemaType::Integer),
            Some("number") => Ok(JsonSchemaType::Number),
            Some("string") => Ok(JsonSchemaType::String),
            Some("array") => Ok(JsonSchemaType::Array),
            Some("object") => Ok(JsonSchemaType::Object),
            _ => Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog")),
        })
        .collect()
}

fn parse_constraints(
    value: &serde_yaml::Value,
    logical_type: LogicalType,
) -> Result<ValueConstraints, RuntimeError> {
    let object = value
        .as_mapping()
        .ok_or(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?;
    let allowed = object
        .get("enum")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|values| {
            values
                .iter()
                .map(constraint_scalar)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let minimum = object.get("minimum").map(canonical_number).transpose()?;
    let maximum = object.get("maximum").map(canonical_number).transpose()?;
    let min_length = object.get("minLength").map(nonnegative_usize).transpose()?;
    let max_length = object.get("maxLength").map(nonnegative_usize).transpose()?;
    let pattern = object
        .get("pattern")
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_owned);
    if minimum
        .as_deref()
        .zip(maximum.as_deref())
        .is_some_and(|(minimum, maximum)| {
            minimum
                .parse::<f64>()
                .ok()
                .zip(maximum.parse::<f64>().ok())
                .is_none_or(|(minimum, maximum)| minimum > maximum)
        })
        || min_length
            .zip(max_length)
            .is_some_and(|(minimum, maximum)| minimum > maximum)
    {
        return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
    }
    let numeric = matches!(
        logical_type,
        LogicalType::Integer | LogicalType::Int64 | LogicalType::Number
    );
    let string = matches!(
        logical_type,
        LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant
    );
    if (!numeric && (minimum.is_some() || maximum.is_some()))
        || (!string && (min_length.is_some() || max_length.is_some() || pattern.is_some()))
        || allowed
            .iter()
            .any(|value| !constraint_matches_type(value, logical_type))
    {
        return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
    }
    if let Some(pattern) = &pattern {
        if pattern.len() > 256 || regex_lite::Regex::new(pattern).is_err() {
            return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
        }
    }
    Ok(ValueConstraints {
        allowed,
        minimum,
        maximum,
        min_length,
        max_length,
        pattern,
    })
}

fn canonical_number(value: &serde_yaml::Value) -> Result<String, RuntimeError> {
    let value = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))?;
    Ok(value.to_string())
}

fn nonnegative_usize(value: &serde_yaml::Value) -> Result<usize, RuntimeError> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))
}

fn constraint_scalar(value: &serde_yaml::Value) -> Result<ConstraintScalar, RuntimeError> {
    if let Some(value) = value.as_str() {
        return Ok(ConstraintScalar::String(value.to_owned()));
    }
    if let Some(value) = value.as_bool() {
        return Ok(ConstraintScalar::Boolean(value));
    }
    canonical_number(value).map(ConstraintScalar::Number)
}

fn constraint_matches_type(value: &ConstraintScalar, logical_type: LogicalType) -> bool {
    matches!(
        (value, logical_type),
        (
            ConstraintScalar::String(_),
            LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant
        ) | (ConstraintScalar::Boolean(_), LogicalType::Boolean)
            | (
                ConstraintScalar::Number(_),
                LogicalType::Integer | LogicalType::Int64 | LogicalType::Number
            )
    )
}

fn storage_class(value: &str) -> Result<StorageClass, RuntimeError> {
    match value {
        "integer" => Ok(StorageClass::Integer),
        "real" => Ok(StorageClass::Real),
        "text" => Ok(StorageClass::Text),
        "blob" => Ok(StorageClass::Blob),
        _ => Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog")),
    }
}

fn declared_storage(value: &str) -> Result<StorageClass, RuntimeError> {
    let value = value.trim().to_ascii_uppercase();
    if value.contains("INT") {
        Ok(StorageClass::Integer)
    } else if value.contains("CHAR") || value.contains("CLOB") || value.contains("TEXT") {
        Ok(StorageClass::Text)
    } else if value.contains("BLOB") {
        Ok(StorageClass::Blob)
    } else if value.contains("REAL") || value.contains("FLOA") || value.contains("DOUB") {
        Ok(StorageClass::Real)
    } else {
        Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))
    }
}

const fn derived_logical_type(storage: StorageClass) -> (LogicalType, ValueRepresentation) {
    match storage {
        StorageClass::Integer => (LogicalType::Int64, ValueRepresentation::String),
        StorageClass::Real => (LogicalType::Number, ValueRepresentation::Number),
        StorageClass::Text => (LogicalType::String, ValueRepresentation::String),
        StorageClass::Blob => (LogicalType::Bytes, ValueRepresentation::Base64),
    }
}

fn validate_storage(
    logical_type: LogicalType,
    storage: Option<StorageClass>,
) -> Result<(), RuntimeError> {
    if storage.is_some_and(|storage| {
        !matches!(
            (logical_type, storage),
            (
                LogicalType::String
                    | LogicalType::Date
                    | LogicalType::DateTime
                    | LogicalType::Instant
                    | LogicalType::Json,
                StorageClass::Text
            ) | (
                LogicalType::Integer | LogicalType::Int64 | LogicalType::Boolean,
                StorageClass::Integer
            ) | (
                LogicalType::Number,
                StorageClass::Real | StorageClass::Integer
            ) | (LogicalType::Bytes, StorageClass::Blob)
        )
    }) {
        return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"));
    }
    Ok(())
}

fn validate_format(logical_type: LogicalType, format: Option<&str>) -> Result<(), RuntimeError> {
    let valid = matches!(
        (logical_type, format),
        (LogicalType::String, None | Some("uuid" | "email"))
            | (
                LogicalType::Integer
                    | LogicalType::Number
                    | LogicalType::Boolean
                    | LogicalType::Json,
                None,
            )
            | (LogicalType::Int64, None | Some("int64"))
            | (LogicalType::Bytes, None | Some("base64"))
            | (LogicalType::Date, Some("iso-date"))
            | (LogicalType::DateTime, Some("sqlite-datetime"))
            | (LogicalType::Instant, Some("rfc3339"))
    );
    if valid {
        Ok(())
    } else {
        Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog"))
    }
}

fn logical_type(value: Option<&str>) -> Result<(LogicalType, ValueRepresentation), RuntimeError> {
    match value {
        Some("string") => Ok((LogicalType::String, ValueRepresentation::String)),
        Some("integer") => Ok((LogicalType::Integer, ValueRepresentation::Number)),
        Some("boolean") => Ok((LogicalType::Boolean, ValueRepresentation::Boolean)),
        Some("int64") => Ok((LogicalType::Int64, ValueRepresentation::String)),
        Some("number") => Ok((LogicalType::Number, ValueRepresentation::Number)),
        Some("bytes") => Ok((LogicalType::Bytes, ValueRepresentation::Base64)),
        Some("date") => Ok((LogicalType::Date, ValueRepresentation::String)),
        Some("datetime") => Ok((LogicalType::DateTime, ValueRepresentation::String)),
        Some("instant") => Ok((LogicalType::Instant, ValueRepresentation::String)),
        Some("json") => Ok((LogicalType::Json, ValueRepresentation::Json)),
        _ => Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog")),
    }
}

fn representation(
    value: Option<&str>,
    default: ValueRepresentation,
) -> Result<ValueRepresentation, RuntimeError> {
    let output = match value {
        None => default,
        Some("string") => ValueRepresentation::String,
        Some("number") => ValueRepresentation::Number,
        Some("boolean") => ValueRepresentation::Boolean,
        Some("object" | "array") => ValueRepresentation::Json,
        _ => return Err(rejected(RejectionKind::InvalidRequest, "runtime.Catalog")),
    };
    Ok(output)
}

fn endpoint_permission(value: &str) -> Result<EndpointPermission, RuntimeError> {
    session::parse_access(value).ok_or(RuntimeError::Access)
}

/// Activates the canonical result of `authorize_session_json` through the same rules.
fn activate_auth(
    authorized_json: &str,
    requested: EndpointPermission,
) -> Result<AuthContext, RuntimeError> {
    let canonical: session::AuthorizedSession =
        serde_json::from_str(authorized_json).map_err(|_| RuntimeError::Session)?;
    session::activate_authorized(canonical, requested).map_err(RuntimeError::from)
}

impl From<session::SessionError> for RuntimeError {
    fn from(error: session::SessionError) -> Self {
        match error {
            session::SessionError::Malformed(_) => Self::Session,
            session::SessionError::Forbidden => Self::Access,
        }
    }
}

fn statement_request(
    raw: RequestStatement,
    endpoint: EndpointPermission,
    catalog: BindingCatalog<'_>,
    binding_limits: policysql_parser::BindingLimits,
    max_bytes_per_value: usize,
) -> Result<StatementRequest, RuntimeError> {
    // The length limit is checked by `compile` before any statement is parsed.
    if raw.sql.is_empty() {
        return Err(RuntimeError::Envelope);
    }
    let expectation = raw.expect.unwrap_or(RequestExpectation {
        affected_rows: None,
        row_count: None,
    });
    let statement = SqliteFrontend::new(binding_limits)
        .bind(&raw.sql, catalog.get())
        .map_err(|error| RuntimeError::Rejected(classify_bind_error(&error)))?;
    let parameter_types = statement_parameter_types(&statement, catalog.get())?;
    let mut parameters = raw
        .params
        .into_iter()
        .map(|(name, value)| {
            let name = ClientParameterName::new(name)
                .map_err(|_| parameter_error(ParameterReason::Name, "parameter.Name"))?;
            let value = logical_parameter_value(
                max_bytes_per_value,
                &value,
                parameter_types
                    .get(&name)
                    .map(policysql_sqlite::ClientParameterContract::logical_type),
            )?;
            Ok((name, value))
        })
        .collect::<Result<BTreeMap<_, _>, RuntimeError>>()?;
    if endpoint == EndpointPermission::Explain {
        for (name, contract) in &parameter_types {
            parameters
                .entry(name.clone())
                .or_insert_with(|| placeholder_value(contract));
        }
    }
    Ok(StatementRequest {
        sql: raw.sql,
        parameters,
        expected_affected_rows: expectation.affected_rows,
        expected_row_count: expectation.row_count,
    })
}

/// Explain fills omitted parameters for type discovery. A proven-nullable
/// parameter uses SQL NULL, which every one of its column contracts accepts;
/// others use a non-NULL value of the compiled type.
fn placeholder_value(contract: &policysql_sqlite::ClientParameterContract) -> LogicalValue {
    if contract.nullable() {
        return LogicalValue::Null;
    }
    match contract.logical_type() {
        LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant => {
            LogicalValue::String(String::new())
        }
        LogicalType::Boolean => LogicalValue::Boolean(false),
        LogicalType::Integer | LogicalType::Int64 => LogicalValue::Int64(0),
        LogicalType::Number => LogicalValue::Number(0.0),
        LogicalType::Bytes => LogicalValue::Bytes(Vec::new()),
        LogicalType::Json => LogicalValue::Json("null".to_owned()),
    }
}

fn statement_parameter_types(
    statement: &BoundStatement,
    catalog: &Catalog,
) -> Result<ParameterTypes, RuntimeError> {
    // The shared compiler pass is the only client-parameter walker.
    policysql_sqlite::analyze_client_parameters(statement, catalog)
        .contracts()
        .cloned()
        .map_err(|_| rejected(RejectionKind::AmbiguousParameterType, "parameter.Types"))
}

/// A client parameter from its exact body text (ADR 0027 pull request 7). An array or object
/// for a JSON-typed parameter is kept as its text instead of a tree; every other value is the
/// scalar the body held, read once.
fn logical_parameter_value(
    max_bytes: usize,
    raw: &serde_json::value::RawValue,
    expected: Option<LogicalType>,
) -> Result<LogicalValue, RuntimeError> {
    let text = raw.get();
    if matches!(text.as_bytes().first(), Some(b'{' | b'[')) {
        // The strict body check made the text valid JSON; only a JSON-typed parameter may be
        // an array or object (the scalar rules below reject one for every other type).
        return if expected == Some(LogicalType::Json) {
            Ok(LogicalValue::Json(text.to_owned()))
        } else {
            Err(invalid_parameter("parameter.Container"))
        };
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| invalid_parameter("parameter.Text"))?;
    logical_value(max_bytes, value, expected)
}

fn logical_value(
    max_bytes: usize,
    value: serde_json::Value,
    expected: Option<LogicalType>,
) -> Result<LogicalValue, RuntimeError> {
    if expected == Some(LogicalType::Bytes) {
        // JSON null decodes to SQL NULL for every type, bytes included; the shared
        // compiler accepts it only for a proven nullable assignment (#20).
        return match value {
            serde_json::Value::Null => Ok(LogicalValue::Null),
            serde_json::Value::String(value) => policysql_core::bytes::decode(&value, max_bytes)
                .map(LogicalValue::Bytes)
                .map_err(|error| match error {
                    policysql_core::bytes::DecodeError::TooLarge => {
                        limit_exceeded(LimitName::MaxBytesPerValue, "parameter.BytesTooLarge")
                    }
                    policysql_core::bytes::DecodeError::InvalidEncoding => {
                        invalid_parameter("parameter.BytesEncoding")
                    }
                }),
            _ => Err(invalid_parameter("parameter.BytesType")),
        };
    }
    match value {
        serde_json::Value::Null => Ok(LogicalValue::Null),
        serde_json::Value::Bool(value) => Ok(LogicalValue::Boolean(value)),
        serde_json::Value::Number(value) => value.as_i64().map_or_else(
            || {
                value
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .map(LogicalValue::Number)
                    .ok_or_else(|| invalid_parameter("parameter.NonFinite"))
            },
            |value| Ok(LogicalValue::Int64(value)),
        ),
        serde_json::Value::String(value) => Ok(LogicalValue::String(value)),
        value @ (serde_json::Value::Array(_) | serde_json::Value::Object(_))
            if expected == Some(LogicalType::Json) =>
        {
            serde_json::to_string(&value)
                .map(LogicalValue::Json)
                .map_err(|_| invalid_parameter("parameter.JsonEncode"))
        }
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            Err(invalid_parameter("parameter.Container"))
        }
    }
}

/// A rejection with no public detail, for the internal `reason` that is only logged.
const fn rejected(kind: RejectionKind, reason: &'static str) -> RuntimeError {
    RuntimeError::Rejected(Rejection::plain(kind, reason))
}

/// A `LIMIT_EXCEEDED` whose public detail names the configured limit (#145 pull request F).
const fn limit_exceeded(limit: LimitName, reason: &'static str) -> RuntimeError {
    RuntimeError::Rejected(Rejection::with_detail(
        RejectionKind::LimitExceeded,
        RejectionDetail::Limit(limit),
        reason,
    ))
}

/// An `INVALID_PARAMETER` whose public detail is `reason`.
const fn parameter_error(reason: ParameterReason, internal: &'static str) -> RuntimeError {
    RuntimeError::Rejected(Rejection::with_detail(
        RejectionKind::InvalidParameter,
        RejectionDetail::Parameter(reason),
        internal,
    ))
}

/// A supplied value that does not fit its parameter (`reason: value`).
const fn invalid_parameter(internal: &'static str) -> RuntimeError {
    parameter_error(ParameterReason::Value, internal)
}

fn logical_result_value(
    max_bytes: usize,
    value: serde_json::Value,
    expected: &[LogicalType],
) -> Result<LogicalValue, RuntimeError> {
    if value.is_object() {
        if !expected.contains(&LogicalType::Bytes) {
            return Err(RuntimeError::RemoteResult);
        }
        let blob: RawBlob =
            serde_json::from_value(value).map_err(|_| RuntimeError::RemoteResult)?;
        if blob.storage_type != "blob" {
            return Err(RuntimeError::RemoteResult);
        }
        // Hosts classify oversized physical BLOBs first; the private ABI boundary
        // independently applies the same category rather than trusting the host.
        return policysql_core::bytes::decode(&blob.base64, max_bytes)
            .map(LogicalValue::Bytes)
            .map_err(|error| match error {
                policysql_core::bytes::DecodeError::TooLarge => {
                    limit_exceeded(LimitName::MaxBytesPerValue, "result.BytesTooLarge")
                }
                policysql_core::bytes::DecodeError::InvalidEncoding => RuntimeError::RemoteResult,
            });
    }
    if expected.contains(&LogicalType::Boolean) {
        return match value {
            serde_json::Value::Bool(value) => Ok(LogicalValue::Boolean(value)),
            serde_json::Value::Number(value) if value.as_i64() == Some(0) => {
                Ok(LogicalValue::Boolean(false))
            }
            serde_json::Value::Number(value) if value.as_i64() == Some(1) => {
                Ok(LogicalValue::Boolean(true))
            }
            serde_json::Value::Null => Ok(LogicalValue::Null),
            value if expected.len() > 1 => {
                logical_result_value_without_boolean(max_bytes, value, expected)
            }
            _ => Err(RuntimeError::RemoteResult),
        };
    }
    logical_result_value_without_boolean(max_bytes, value, expected)
}

fn logical_result_value_without_boolean(
    max_bytes: usize,
    value: serde_json::Value,
    expected: &[LogicalType],
) -> Result<LogicalValue, RuntimeError> {
    if expected.contains(&LogicalType::Json) {
        return match value {
            serde_json::Value::String(value)
                if serde_json::from_str::<serde_json::Value>(&value).is_ok() =>
            {
                Ok(LogicalValue::Json(value))
            }
            serde_json::Value::Null => Ok(LogicalValue::Null),
            value if expected.len() > 1 => logical_result_value_scalar(max_bytes, value, expected),
            _ => Err(RuntimeError::RemoteResult),
        };
    }
    logical_result_value_scalar(max_bytes, value, expected)
}

#[allow(clippy::needless_pass_by_value)]
fn logical_result_value_scalar(
    max_bytes: usize,
    value: serde_json::Value,
    expected: &[LogicalType],
) -> Result<LogicalValue, RuntimeError> {
    if value.is_null() {
        return Ok(LogicalValue::Null);
    }
    for logical_type in expected {
        // A physical TEXT value cannot become BLOB by applying the public input codec.
        if *logical_type == LogicalType::Bytes {
            continue;
        }
        if let Ok(value) = logical_value(max_bytes, value.clone(), Some(*logical_type)) {
            return Ok(value);
        }
    }
    Err(RuntimeError::RemoteResult)
}

fn compiled_statement(
    statement: &policysql_gateway::CompiledStatement,
    catalog: &Catalog,
) -> Result<CompiledStatementDto, RuntimeError> {
    let plan = &statement.plan;
    let limits = plan.limits();
    Ok(CompiledStatementDto {
        operation: operation(plan.operation()),
        resource: statement
            .explain
            .resource
            .and_then(|resource| catalog.resource_by_id(resource))
            .map(|resource| resource.name.as_str().to_owned()),
        operation_check: plan.operation_check_column().is_some(),
        protected_sql: plan.protected_sql().to_owned(),
        cost_explain_sql: policysql_sqlite::explain_query_plan_sql(plan.protected_sql())
            .map_err(|_| RuntimeError::Internal)?,
        client_parameters: encode_parameters(plan.client_parameters()),
        // Both maps come from the contracts the gateway validated the supplied
        // values against, so Explain advertises NULL exactly where execute accepts it.
        client_parameter_types: statement
            .client_parameters
            .iter()
            .map(|(name, contract)| {
                (
                    name.as_str().to_owned(),
                    logical_type_name(contract.logical_type()),
                )
            })
            .collect(),
        client_parameter_nullable: statement
            .client_parameters
            .iter()
            .map(|(name, contract)| (name.as_str().to_owned(), contract.nullable()))
            .collect(),
        server_parameters: encode_parameters(plan.server_parameters()),
        result: plan
            .result()
            .iter()
            .map(|column| ResultColumnDto {
                name: column.name.as_str().to_owned(),
                logical_type: logical_types_json(&column.possible_types),
                representation: representation_name(column.value.representation),
                nullable: column.value.nullable,
                format: column.value.format.clone(),
                constraints: constraints_json(column.value.constraints.as_ref()),
                json_schema: column.value.json_schema.as_ref().map(json_schema_json),
                redacted_on_null: column.redacted_on_null,
            })
            .collect(),
        limits: LimitsDto {
            max_rows: limits.max_rows,
            max_result_bytes: limits.max_result_bytes,
            timeout_ms: limits.timeout_ms,
        },
        expected_affected_rows: plan.expected_affected_rows(),
        expected_result_rows: plan.expected_result_rows(),
        explain: ExplainDto {
            resource: statement
                .explain
                .resource
                .map(policysql_core::ResourceId::get),
            resources: statement
                .explain
                .resources
                .iter()
                .map(|resource| resource.get())
                .collect(),
            resource_names: statement
                .explain
                .resources
                .iter()
                .filter_map(|resource| catalog.resource_by_id(*resource))
                .map(|resource| resource.name.as_str().to_owned())
                .collect(),
            public_resources: statement
                .explain
                .resources
                .iter()
                .filter_map(|resource_id| {
                    let resource = catalog.resource_by_id(*resource_id)?;
                    let columns = statement
                        .explain
                        .referenced_columns
                        .get(resource_id)
                        .into_iter()
                        .flatten()
                        .filter_map(|column_id| resource.column_by_id(*column_id))
                        .map(|column| column.name.as_str().to_owned())
                        .collect();
                    Some(ExplainResourceDto {
                        name: resource.name.as_str().to_owned(),
                        columns,
                    })
                })
                .collect(),
            applied_policies: statement
                .explain
                .applied_policies
                .iter()
                .map(|policy| policy.get())
                .collect(),
            policy_limit: statement.explain.policy_limit,
        },
    })
}

fn encode_parameters<Name>(
    parameters: &BTreeMap<Name, LogicalValue>,
) -> BTreeMap<String, serde_json::Value>
where
    Name: Ord + ParameterName,
{
    parameters
        .iter()
        .map(|(name, value)| (name.name().to_owned(), encode_parameter_value(value)))
        .collect()
}

trait ParameterName {
    fn name(&self) -> &str;
}

impl ParameterName for ClientParameterName {
    fn name(&self) -> &str {
        self.as_str()
    }
}

impl ParameterName for policysql_core::ServerParameterName {
    fn name(&self) -> &str {
        self.as_str()
    }
}

fn encode_parameter_value(value: &LogicalValue) -> serde_json::Value {
    match value {
        LogicalValue::Null => serde_json::Value::Null,
        LogicalValue::String(value) | LogicalValue::Json(value) => {
            serde_json::Value::String(value.clone())
        }
        LogicalValue::Boolean(value) => serde_json::Value::Bool(*value),
        LogicalValue::Int64(value) => serde_json::Value::Number((*value).into()),
        LogicalValue::Number(value) => serde_json::Number::from_f64(*value)
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        LogicalValue::Bytes(value) => {
            serde_json::json!({"type": "blob", "base64": policysql_core::bytes::encode(value)})
        }
    }
}

fn encode_result_value(value: &LogicalValue) -> Result<serde_json::Value, RuntimeError> {
    if let LogicalValue::Bytes(value) = value {
        return Ok(serde_json::Value::String(policysql_core::bytes::encode(
            value,
        )));
    }
    if let LogicalValue::Json(value) = value {
        return serde_json::from_str(value).map_err(|_| RuntimeError::RemoteResult);
    }
    Ok(encode_parameter_value(value))
}

const fn operation(value: policysql_core::OperationKind) -> &'static str {
    match value {
        policysql_core::OperationKind::Select => "select",
        policysql_core::OperationKind::Insert => "insert",
        policysql_core::OperationKind::Update => "update",
        policysql_core::OperationKind::Delete => "delete",
    }
}

const fn logical_type_name(value: LogicalType) -> &'static str {
    match value {
        LogicalType::String => "string",
        LogicalType::Integer => "integer",
        LogicalType::Boolean => "boolean",
        LogicalType::Int64 => "int64",
        LogicalType::Number => "number",
        LogicalType::Bytes => "bytes",
        LogicalType::Date => "date",
        LogicalType::DateTime => "datetime",
        LogicalType::Instant => "instant",
        LogicalType::Json => "json",
    }
}

fn logical_types_json(values: &[LogicalType]) -> serde_json::Value {
    if let [value] = values {
        serde_json::Value::String(logical_type_name(*value).to_owned())
    } else {
        serde_json::Value::Array(
            values
                .iter()
                .map(|value| serde_json::Value::String(logical_type_name(*value).to_owned()))
                .collect(),
        )
    }
}

const fn representation_name(value: ValueRepresentation) -> &'static str {
    match value {
        ValueRepresentation::String => "string",
        ValueRepresentation::Boolean => "boolean",
        ValueRepresentation::Number => "number",
        ValueRepresentation::Base64 => "base64",
        ValueRepresentation::Json => "json",
    }
}

const fn catalog_representation_name(value: ValueRepresentation) -> &'static str {
    match value {
        ValueRepresentation::String | ValueRepresentation::Base64 => "string",
        ValueRepresentation::Boolean => "boolean",
        ValueRepresentation::Number => "number",
        ValueRepresentation::Json => "object",
    }
}

fn runtime_gateway_error(error: GatewayError) -> RuntimeError {
    match error {
        GatewayError::AccessDenied => RuntimeError::Access,
        GatewayError::SnapshotMismatch => RuntimeError::Snapshot,
        GatewayError::EnvelopeLimit => RuntimeError::Envelope,
        GatewayError::Rejected { rejection, index } => RuntimeError::RejectedAt(rejection, index),
        GatewayError::TooComplex { cause, index } => RuntimeError::TooComplexAt(cause, index),
        GatewayError::EmittedSqlInvalid { index } => RuntimeError::EmittedSqlInvalidAt(index),
        GatewayError::TransactionRequired => rejected(
            RejectionKind::ForbiddenOperation,
            "gateway.TransactionRequired",
        ),
        GatewayError::ExecutionFailed => RuntimeError::Internal,
    }
}

/// The log record of a refused compile or result validation, without the request id; the
/// step machine adds it and the engine adds it for Explain. A complexity refusal and the
/// emitter's re-parse failure keep their own events (`sql_too_complex`,
/// `emitted_sql_reparse_failed`: the statement, the versions, and a fixed cause name); every
/// other refusal writes `rejection_reason` (ADR 0027 and ADR 0030 amendments): the statement, the
/// code, the fixed internal reason, and the versions. Never SQL text, a name, a value, the
/// parser's or the database's text, or a payload.
fn refusal_log(runtime: &PolicySqlRuntime, error: &RuntimeError) -> serde_json::Value {
    let named = match error {
        RuntimeError::TooComplexAt(cause, index) => Some(("sql_too_complex", *index, cause.name())),
        RuntimeError::EmittedSqlInvalidAt(index) => {
            Some(("emitted_sql_reparse_failed", *index, "reparse"))
        }
        _ => None,
    };
    if let Some((event, index, cause)) = named {
        return serde_json::json!({
            "event": event,
            "statementIndex": index,
            "schemaVersion": runtime.schema_version,
            "policyVersion": runtime.policy_version,
            "abiVersion": ABI_VERSION,
            "cause": cause,
        });
    }
    let shape = match error {
        RuntimeError::Rejected(rejection) | RuntimeError::RejectedAt(rejection, _) => {
            rejection.shape
        }
        _ => None,
    };
    let code = error_body(*error).code;
    serde_json::json!({
        "event": "rejection_reason",
        "statementIndex": error.statement_index(),
        "code": code,
        "reason": error.reason(),
        "shape": shape,
        "schemaVersion": runtime.schema_version,
        "policyVersion": runtime.policy_version,
        "abiVersion": ABI_VERSION,
    })
}

fn error_body(runtime_error: RuntimeError) -> ErrorBody {
    match runtime_error {
        RuntimeError::Access => error(
            "POLICYSQL_FORBIDDEN_ACCESS",
            "The authenticated session cannot use this endpoint.",
            None,
        ),
        RuntimeError::Snapshot => error(
            "POLICYSQL_STALE_OPERATION",
            "The operation was compiled for a different active snapshot.",
            None,
        ),
        RuntimeError::Envelope => error(
            "POLICYSQL_INVALID_REQUEST",
            "Request envelope is invalid.",
            None,
        ),
        RuntimeError::EnvelopeAt(index) => error(
            "POLICYSQL_INVALID_REQUEST",
            "Request envelope is invalid.",
            Some(index),
        ),
        RuntimeError::RequestTooLarge => error(
            "POLICYSQL_REQUEST_TOO_LARGE",
            "Request body exceeds the size limit.",
            None,
        ),
        RuntimeError::SqlTooLargeAt(index) => ErrorBody {
            code: "POLICYSQL_REQUEST_TOO_LARGE",
            message: "A statement's SQL exceeds the size limit.",
            path: Some(format!("/statements/{index}/sql")),
            detail: Some(ErrorDetail::limit(LimitName::MaxSqlBytes.name())),
        },
        RuntimeError::Rejected(rejection) => rejection_body(rejection, None),
        RuntimeError::RejectedAt(rejection, index) => rejection_body(rejection, Some(index)),
        RuntimeError::TooComplexAt(cause, index) => ErrorBody {
            detail: Some(ErrorDetail::complexity(cause.name())),
            ..error(
                "POLICYSQL_SQL_TOO_COMPLEX",
                "The statement is too complex to run under the active policy.",
                Some(index),
            )
        },
        RuntimeError::Session
        | RuntimeError::Internal
        | RuntimeError::AuthTooLarge
        | RuntimeError::EmittedSqlInvalidAt(_) => error(
            "POLICYSQL_INTERNAL",
            "The request could not be completed.",
            None,
        ),
        RuntimeError::Busy => error(
            "POLICYSQL_DATABASE_UNAVAILABLE",
            "The database adapter is temporarily unavailable.",
            None,
        ),
        RuntimeError::RemoteResult => error(
            "POLICYSQL_SCHEMA_MISMATCH",
            "The database result does not match the compiled logical contract.",
            None,
        ),
        RuntimeError::RemoteResultAt(index) => error(
            "POLICYSQL_SCHEMA_MISMATCH",
            "The database result does not match the compiled logical contract.",
            Some(index),
        ),
        RuntimeError::CheckFailedAt(index) => error(
            "POLICYSQL_CHECK_FAILED",
            "A changed row does not satisfy the policy check.",
            Some(index),
        ),
    }
}

fn error(code: &'static str, message: &'static str, index: Option<usize>) -> ErrorBody {
    ErrorBody {
        code,
        message,
        path: index.map(|index| format!("/statements/{index}")),
        detail: None,
    }
}

/// The public `error.detail` of a rejection. A span past the checked ceiling is left out: the
/// detail is optional for `INVALID_SQL`, and a value the table would refuse must not be sent.
fn rejection_detail(detail: RejectionDetail) -> Option<ErrorDetail> {
    match detail {
        RejectionDetail::Feature(feature) => Some(ErrorDetail::feature(feature.name())),
        RejectionDetail::Span(span) => {
            let start = u64::try_from(span.start).ok()?;
            let end = u64::try_from(span.end).ok()?;
            (start <= end && end <= policysql_transaction::machine::io::MAX_SPAN_OFFSET)
                .then(|| ErrorDetail::span(start, end))
        }
        RejectionDetail::Parameter(reason) => Some(ErrorDetail::reason(reason.name())),
        RejectionDetail::Expectation(kind) => Some(ErrorDetail::expectation(kind.name())),
        RejectionDetail::Limit(limit) => Some(ErrorDetail::limit(limit.name())),
    }
}

fn rejection_body(rejection: Rejection, index: Option<usize>) -> ErrorBody {
    let (code, message) = match rejection.kind {
        RejectionKind::InvalidRequest => ("POLICYSQL_INVALID_REQUEST", "The request is invalid."),
        RejectionKind::InvalidSql => (
            "POLICYSQL_INVALID_SQL",
            "The SQL statement cannot be parsed.",
        ),
        RejectionKind::MultipleStatements => (
            "POLICYSQL_MULTIPLE_STATEMENTS",
            "Exactly one SQL statement is required.",
        ),
        RejectionKind::UnsupportedSql => (
            "POLICYSQL_UNSUPPORTED_SQL",
            "The SQL statement uses an unsupported form.",
        ),
        RejectionKind::MissingPolicy => (
            "POLICYSQL_MISSING_POLICY",
            "No policy permits this operation, or the resource does not exist.",
        ),
        RejectionKind::ForbiddenOperation => (
            "POLICYSQL_FORBIDDEN_OPERATION",
            "The operation is not available.",
        ),
        RejectionKind::ForbiddenColumn => (
            "POLICYSQL_FORBIDDEN_COLUMN",
            "The statement references a column that is not available for this operation.",
        ),
        RejectionKind::ForbiddenColumnContext => (
            "POLICYSQL_FORBIDDEN_COLUMN_CONTEXT",
            "The statement uses a column in a context that is not available.",
        ),
        RejectionKind::DuplicateResultColumn => (
            "POLICYSQL_DUPLICATE_RESULT_COLUMN",
            "Result column names must be unique.",
        ),
        RejectionKind::InvalidParameter => (
            "POLICYSQL_INVALID_PARAMETER",
            "A statement parameter is missing or invalid.",
        ),
        RejectionKind::AmbiguousParameterType => (
            "POLICYSQL_AMBIGUOUS_PARAMETER_TYPE",
            "A parameter type cannot be proven.",
        ),
        RejectionKind::ReservedParameter => (
            "POLICYSQL_RESERVED_PARAMETER",
            "A parameter uses the server-owned namespace.",
        ),
        RejectionKind::PresetColumn => (
            "POLICYSQL_PRESET_COLUMN",
            "A server-owned preset column cannot be supplied by the client.",
        ),
        RejectionKind::LimitExceeded => (
            "POLICYSQL_LIMIT_EXCEEDED",
            "The request or result exceeded a configured limit.",
        ),
        RejectionKind::ExpectationFailed => (
            "POLICYSQL_EXPECTATION_FAILED",
            "The operation did not satisfy its declared expectation.",
        ),
    };
    ErrorBody {
        detail: rejection.detail.and_then(rejection_detail),
        ..error(code, message, index)
    }
}

fn serialize_or_internal(value: &impl Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| {
        "{\"error\":{\"code\":\"POLICYSQL_INTERNAL\",\"message\":\"The request could not be completed.\"}}"
            .to_owned()
    })
}

fn js_error(message: &str) -> JsValue {
    JsValue::from_str(message)
}

#[cfg(test)]
mod tests {
    use super::{
        LogicalType, LogicalValue, PhysicalSchema, PolicySqlRuntime, SnapshotId, activate_catalog,
        activate_catalog_with_schema, encode_parameter_value, encode_result_value,
        logical_result_value,
    };

    #[test]
    fn decimal_parameters_read_as_the_correctly_rounded_double() {
        // ADR 0025: compile and core's canonical form read a decimal as the same, correctly
        // rounded double (`float_roundtrip`); serde_json's default read these one unit off.
        for (text, expected) in [
            ("9007199254740991.0", 9_007_199_254_740_991.0_f64),
            ("4503599627370495.5", 4_503_599_627_370_495.5),
            ("0.1", 0.1),
        ] {
            let value: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
            assert!(
                matches!(super::logical_value(policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE, value, None), Ok(LogicalValue::Number(number)) if number.to_bits() == expected.to_bits()),
                "{text}"
            );
        }
    }

    const CATALOG: &str = r"
version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      name: { type: string }
      status: { type: string }
";

    const POLICY: &str = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, name, status]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, name, status]
          presets:
            tenant_id: { session: tenant_id }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name, status] }
";

    fn runtime() -> PolicySqlRuntime {
        PolicySqlRuntime::new(
            CATALOG,
            POLICY,
            "schema_test",
            "policy_test",
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":4}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"))
    }

    #[test]
    fn runtime_reports_its_configured_limits_and_the_constants_core_enforces() {
        let limits: serde_json::Value = serde_json::from_str(&runtime().limits_json())
            .unwrap_or_else(|error| unreachable!("{error}"));
        assert_eq!(limits["maxRows"], 100);
        assert_eq!(limits["maxResultBytes"], 10_000);
        assert_eq!(limits["maxStatements"], 4);
        assert_eq!(
            limits["transactionMs"], 4_000,
            "default of an omitted field"
        );
        assert_eq!(limits["maxSqlBytes"], 65_536);
        assert_eq!(limits["maxRequestBytes"], 1_048_576);
        assert_eq!(limits["maxJsonValues"], 65_536);
        assert_eq!(
            limits["maxBytesPerValue"],
            policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE
        );
        assert_eq!(limits["maxParameters"], 1_024);
        assert_eq!(limits["maxExpressionDepth"], 32);
        assert_eq!(limits["maxProjections"], 128);
        assert_eq!(limits["maxResponseBytes"], 10_000 + 65_536);
        assert_eq!(
            limits["maxJoins"],
            policysql_parser::BindingLimits::default().max_joins
        );
        assert_eq!(
            limits["maxCommitChecks"],
            policysql_policy::MAX_COMMIT_CHECKS
        );
        assert_eq!(
            limits["maxHookDurationMs"],
            policysql_policy::MAX_COMMIT_CHECK_TIMEOUT_MS
        );
        let configured = PolicySqlRuntime::new(
            CATALOG,
            POLICY,
            "schema_test",
            "policy_test",
            r#"{"max_rows":5,"max_result_bytes":6,"timeout_ms":7,"max_statements":2,"transaction_ms":900,"max_callback_rows":3}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        let limits: serde_json::Value = serde_json::from_str(&configured.limits_json())
            .unwrap_or_else(|error| unreachable!("{error}"));
        assert_eq!(limits["transactionMs"], 900);
        assert_eq!(limits["maxCallbackRows"], 3);
        assert_eq!(limits["maxStatements"], 2);
        assert_eq!(
            configured.snapshot(),
            runtime().snapshot(),
            "limits are not part of the snapshot"
        );
    }

    #[test]
    fn catalog_activation_accepts_only_the_documented_json_schema_subset() {
        let valid = CATALOG.replace(
            "      status: { type: string }",
            r"      status: { type: string }
      metadata:
        type: json
        representation: object
        jsonSchema:
          $schema: https://json-schema.org/draft/2020-12/schema
          type: object
          additionalProperties: false
          properties:
            score:
              anyOf:
                - { type: integer }
                - { type: 'null' }",
        );
        let snapshot = SnapshotId::new("schema_json")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        assert!(activate_catalog(&valid, snapshot.clone()).is_ok());

        let invalid = CATALOG.replace(
            "      status: { type: string }",
            r"      status: { type: string }
      metadata:
        type: json
        jsonSchema:
          $ref: https://example.com/remote-schema.json",
        );
        assert!(activate_catalog(&invalid, snapshot).is_err());
    }

    #[test]
    fn catalog_retains_storage_format_constraints_and_json_schema() {
        let manifest = CATALOG.replace(
            "      status: { type: string }",
            r"      status:
        type: string
        storage: text
        format: uuid
        constraints:
          minLength: 36
          maxLength: 36
          pattern: '^[0-9a-f-]+$'
      metadata:
        type: json
        storage: text
        representation: object
        jsonSchema:
          type: object
          additionalProperties: false
          required: [score]
          properties:
            score: { type: integer }",
        );
        let snapshot = SnapshotId::new("schema_contract")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = activate_catalog(&manifest, snapshot)
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error:?}"));
        let resource = catalog
            .resource("projects")
            .unwrap_or_else(|| unreachable!("resource exists"));
        let status = resource
            .column("status")
            .unwrap_or_else(|| unreachable!("column exists"));
        assert!(status.value.storage.is_some());
        assert_eq!(status.value.format.as_deref(), Some("uuid"));
        assert_eq!(
            status
                .value
                .constraints
                .as_ref()
                .and_then(|constraints| constraints.min_length),
            Some(36)
        );
        assert!(
            resource
                .column("metadata")
                .is_some_and(|column| column.value.json_schema.is_some())
        );

        let invalid_format = CATALOG.replace(
            "      status: { type: string }",
            "      status: { type: string, format: rfc3339 }",
        );
        let snapshot = SnapshotId::new("schema_invalid_format")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        assert!(activate_catalog(&invalid_format, snapshot).is_err());
    }

    #[test]
    fn gateway_revalidates_catalog_constraints_on_client_parameters() {
        let catalog = CATALOG.replace(
            "      status: { type: string }",
            "      status:\n        type: string\n        constraints: { enum: [active, archived] }",
        );
        let runtime = PolicySqlRuntime::new(
            &catalog,
            POLICY,
            "schema_constraints",
            "policy_constraints",
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":2}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        let auth = r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#;
        let accepted = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE status = :status","params":{"status":"active"}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        assert!(!accepted.contains("\"error\""), "{accepted}");
        let rejected = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE status = :status","params":{"status":"deleted"}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        assert!(
            rejected.contains("POLICYSQL_INVALID_PARAMETER"),
            "{rejected}"
        );
    }

    #[test]
    fn catalog_build_derives_basic_types_and_rejects_physical_drift() {
        let manifest = r"
version: 1
resources:
  projects:
    source: { table: physical_projects }
    columns:
      id: {}
      title: {}
      score: {}
      payload: {}
";
        let physical: PhysicalSchema = serde_json::from_str(
            r#"{"tables":{"physical_projects":{"columns":{"id":{"declaredType":"INTEGER","nullable":false},"title":{"declaredType":"TEXT","nullable":true},"score":{"declaredType":"REAL","nullable":false},"payload":{"declaredType":"BLOB","nullable":false}}}}}"#,
        )
        .unwrap_or_else(|error| unreachable!("valid physical schema: {error}"));
        let snapshot = SnapshotId::new("schema_introspection")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = activate_catalog_with_schema(manifest, snapshot.clone(), Some(&physical))
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error:?}"));
        let resource = catalog
            .resource("projects")
            .unwrap_or_else(|| unreachable!("resource exists"));
        assert_eq!(resource.source.as_str(), "physical_projects");
        assert_eq!(
            resource
                .column("id")
                .map(|column| column.value.logical_type),
            Some(LogicalType::Int64)
        );
        assert!(
            resource
                .column("title")
                .is_some_and(|column| column.value.nullable)
        );

        let drifted = manifest.replace("      payload: {}", "      missing: {}\n");
        assert!(activate_catalog_with_schema(&drifted, snapshot, Some(&physical)).is_err());
    }

    #[test]
    fn compiles_only_authenticated_policy_protected_sql() {
        let output = runtime().compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"expected":{"schemaVersion":"schema_test","policyVersion":"policy_test"},"statements":[{"sql":"SELECT id, name FROM projects WHERE status = :status","params":{"status":"active"}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        let value: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        assert_eq!(value["profile"], "sqlite-turso-v1");
        assert_eq!(value["transactionMode"], "read");
        assert_eq!(
            value["statements"][0]["explain"]["resourceNames"],
            serde_json::json!(["projects"])
        );
        let protected = value["statements"][0]["protectedSql"]
            .as_str()
            .unwrap_or_default();
        assert!(protected.contains("__policysql_session_tenant_id"));
    }

    #[test]
    fn constant_select_is_typed_without_catalog_resource_access() {
        let output = runtime().compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT 1 AS value","params":{}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        let value: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        assert!(value.get("error").is_none(), "{output}");
        assert_eq!(
            value["statements"][0]["result"][0]["logicalType"],
            "integer"
        );
        assert_eq!(
            value["statements"][0]["explain"]["resourceNames"],
            serde_json::json!([])
        );
        assert!(
            value["statements"][0]["protectedSql"]
                .as_str()
                .is_some_and(|sql| { sql == "SELECT 1 AS \"value\"" }),
            "{output}"
        );
    }

    #[test]
    fn compile_exports_activated_commit_check_and_mutation_resource() {
        let policy = format!(
            "{POLICY}\ncommit_checks:\n  project_consistency:\n    triggered_by: [projects]\n    role: member\n    hook:\n      timeout_ms: 1000\n"
        );
        let runtime = PolicySqlRuntime::new(
            CATALOG,
            &policy,
            "schema_commit",
            "policy_commit",
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":4}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        assert!(runtime.commit_checks_enabled());
        let output = runtime.compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"INSERT INTO projects (id, name, status) VALUES (:id, :name, :status)","params":{"id":"p1","name":"one","status":"active"}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        let compiled: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid JSON: {error}"));
        assert_eq!(compiled["statements"][0]["resource"], "projects");
        assert_eq!(compiled["commitChecks"][0]["id"], "project_consistency");
        assert_eq!(compiled["commitChecks"][0]["triggeredBy"][0], "projects");
        assert_eq!(compiled["commitChecks"][0]["timeoutMs"], 1000);
        // Validator URL and secret are wrapper configuration keyed by check id (ADR 0021).
        assert!(compiled["commitChecks"][0].get("urlEnv").is_none());
        assert!(compiled["commitChecks"][0].get("hmacSecretEnv").is_none());
    }

    #[test]
    fn explain_infers_missing_runtime_parameter_values_from_bound_usage() {
        let output = runtime().compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE status = :status LIMIT :limit","params":{}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        let value: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        assert!(value.get("error").is_none(), "{output}");
        assert_eq!(value["statements"][0]["clientParameters"]["status"], "");
        assert_eq!(value["statements"][0]["clientParameters"]["limit"], 0);
    }

    #[test]
    fn authorize_session_abi_returns_canonical_auth_forbidden_or_fault() {
        let runtime = runtime();
        let session = r#"{"principal":"https://issuer.test:user_1","subject":"user_1","roles":["member"],"defaultRole":"member","access":["execute"],"session":{"tenant_id":"tenant_1"}}"#;
        let parse = |text: String| -> serde_json::Value {
            serde_json::from_str(&text).unwrap_or_else(|error| unreachable!("JSON: {error}"))
        };

        let accepted = parse(runtime.authorize_session_json(session, None, "execute"));
        assert_eq!(accepted["auth"]["role"], "member");
        assert_eq!(accepted["auth"]["principal"], "https://issuer.test:user_1");
        let canonical = accepted["auth"].to_string();
        let compiled = runtime.compile_json(
            &canonical,
            r#"{"statements":[{"sql":"SELECT id FROM projects","params":{}}]}"#,
            "execute",
            crate::TEST_CONTEXT,
        );
        assert!(!compiled.contains("\"error\""), "{compiled}");

        for (role, access) in [(Some("admin".to_owned()), "execute"), (None, "explain")] {
            let denied = parse(runtime.authorize_session_json(session, role, access));
            assert_eq!(denied["error"]["code"], "POLICYSQL_FORBIDDEN_ACCESS");
            assert!(denied.get("fault").is_none());
        }

        let reserved = session.replace("tenant_id", "subject_id");
        let oversized = format!(
            r#"{{"principal":"p","subject":"s","roles":["member"],"defaultRole":"member","access":["execute"],"session":{{"tenant_id":"{}"}}}}"#,
            "x".repeat(policysql_transaction::bounds::SESSION_INPUT_BYTES)
        );
        for (input, fault) in [
            ("not json", "shape"),
            (reserved.as_str(), "session"),
            (oversized.as_str(), "shape"),
        ] {
            let output = runtime.authorize_session_json(input, Some("admin".to_owned()), "execute");
            assert!(!output.contains("subject_id"), "{output}");
            let rejected = parse(output);
            assert_eq!(rejected["error"]["code"], "POLICYSQL_INTERNAL");
            assert_eq!(rejected["fault"], fault);
        }
        let unknown = parse(runtime.authorize_session_json(session, None, "admin"));
        assert_eq!(unknown["error"]["code"], "POLICYSQL_INTERNAL");

        // compile/catalog accept only the canonical result; a raw wrapper session or a
        // malformed canonical value is an internal fault, never 401.
        for auth in [session, "{}", reserved.as_str()] {
            let output = runtime.catalog_json(auth);
            assert!(output.contains("POLICYSQL_INTERNAL"), "{output}");
            assert!(!output.contains("UNAUTHENTICATED"), "{output}");
        }
    }

    #[test]
    fn rejects_access_and_snapshot_mismatch_without_exposing_detail() {
        let request = r#"{"statements":[{"sql":"SELECT id FROM projects","params":{}}]}"#;
        let debug = runtime().compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute","debug"],"session":{"tenant_id":"tenant_1"}}"#,
            request,
            "execute", crate::TEST_CONTEXT
        );
        assert!(!debug.contains("POLICYSQL_FORBIDDEN_ACCESS"), "{debug}");

        let denied = runtime().compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["catalog"],"session":{"tenant_id":"tenant_1"}}"#,
            request,
            "explain", crate::TEST_CONTEXT
        );
        assert!(denied.contains("POLICYSQL_FORBIDDEN_ACCESS"));

        let stale = runtime().compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"expected":{"schemaVersion":"stale","policyVersion":"policy_test"},"statements":[{"sql":"SELECT id FROM projects","params":{}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        assert!(stale.contains("POLICYSQL_STALE_OPERATION"));
    }

    #[test]
    fn classifies_public_sql_errors_without_exposing_catalog_detail() {
        let runtime = runtime();
        let auth = r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#;
        for (sql, params, code) in [
            ("SELECT", "{}", "POLICYSQL_INVALID_SQL"),
            (
                "SELECT id FROM projects; SELECT id FROM projects",
                "{}",
                "POLICYSQL_MULTIPLE_STATEMENTS",
            ),
            ("SELECT * FROM projects", "{}", "POLICYSQL_UNSUPPORTED_SQL"),
            (
                "SELECT tenant_id FROM projects",
                "{}",
                "POLICYSQL_FORBIDDEN_COLUMN",
            ),
            (
                "SELECT id FROM projects WHERE status = :status",
                "{}",
                "POLICYSQL_INVALID_PARAMETER",
            ),
            (
                "SELECT id FROM projects WHERE status = :__policysql_secret",
                r#"{"__policysql_secret":"active"}"#,
                "POLICYSQL_RESERVED_PARAMETER",
            ),
        ] {
            let request = format!(
                r#"{{"statements":[{{"sql":{},"params":{params}}}]}}"#,
                serde_json::to_string(sql)
                    .unwrap_or_else(|error| unreachable!("SQL string serializes: {error}"))
            );
            let output = runtime.compile_json(auth, &request, "execute", crate::TEST_CONTEXT);
            assert!(output.contains(code), "expected {code} for {sql}: {output}");
            assert!(output.contains(r#""path":"/statements/0""#));
            assert!(!output.contains("executionHandle"));
            assert!(!output.contains("tenant_id"));
        }

        let output = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects","params":{}},{"sql":"SELECT tenant_id FROM projects","params":{}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        let error: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|parse_error| unreachable!("safe error parses: {parse_error}"));
        assert_eq!(error["error"]["code"], "POLICYSQL_FORBIDDEN_COLUMN");
        assert_eq!(error["error"]["path"], "/statements/1");
    }

    #[test]
    fn execute_handle_validates_remote_columns_rows_and_limits() {
        let runtime = runtime();
        let compiled = runtime.compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT id, name FROM projects","params":{}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        let value: serde_json::Value = serde_json::from_str(&compiled)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        let handle = value["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("execute handle"));
        let valid = runtime.validate_result_json(
            handle,
            0,
            r#"{"columns":["id","name"],"rows":[["p1","Project"]],"affectedRows":0}"#,
        );
        assert!(!valid.contains("error"));
        let invalid = runtime.validate_result_json(
            handle,
            0,
            r#"{"columns":["name","id"],"rows":[["Project","p1"]],"affectedRows":0}"#,
        );
        assert!(invalid.contains("POLICYSQL_SCHEMA_MISMATCH"));
        assert!(runtime.release_execution(handle));
        assert!(!runtime.release_execution(handle));
    }

    #[test]
    fn execute_expectation_mismatch_has_its_public_error_code() {
        let runtime = runtime();
        let compiled = runtime.compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE id = :id","params":{"id":"p1"},"expect":{"rowCount":0}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        let value: serde_json::Value = serde_json::from_str(&compiled)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        let handle = value["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("execute handle"));
        let mismatch = runtime.validate_result_json(
            handle,
            0,
            r#"{"columns":["id"],"rows":[["p1"]],"affectedRows":0}"#,
        );
        assert!(mismatch.contains("POLICYSQL_EXPECTATION_FAILED"));
        assert!(runtime.release_execution(handle));
    }

    #[test]
    fn catalog_reports_only_policy_enabled_column_usage() {
        let output = runtime().catalog_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["catalog"],"session":{"tenant_id":"tenant_1"}}"#,
        );
        let catalog: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid catalog JSON: {error}"));
        let usage = catalog["resources"][0]["operations"]["select"]["columns"][0]["usage"]
            .as_array()
            .unwrap_or_else(|| unreachable!("column usage"));
        assert!(usage.iter().any(|value| value == "projection"));
        assert!(usage.iter().any(|value| value == "join"));
        assert!(!usage.iter().any(|value| value == "group"));
        assert!(!usage.iter().any(|value| value == "aggregate"));
        assert!(!usage.iter().any(|value| value == "window"));
    }

    #[test]
    fn deployment_surface_keeps_parser_structural_join_limits() {
        let output = runtime().compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT a.id FROM projects AS a JOIN projects AS b ON a.id = b.id","params":{}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        assert!(
            output.contains("POLICYSQL_UNSUPPORTED_SQL"),
            "unexpected safe error: {output}"
        );
        assert!(!output.contains("executionHandle"));
    }

    #[test]
    fn json_results_are_validated_and_emitted_as_json_values() {
        let encoded = logical_result_value(
            policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
            serde_json::Value::String(r#"{"tag":"first"}"#.to_owned()),
            &[LogicalType::Json],
        )
        .and_then(|value| encode_result_value(&value))
        .unwrap_or_else(|error| unreachable!("valid JSON result: {error:?}"));
        assert_eq!(encoded, serde_json::json!({"tag": "first"}));
        assert!(
            logical_result_value(
                policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
                serde_json::Value::String("not-json".to_owned()),
                &[LogicalType::Json],
            )
            .is_err()
        );
        assert_eq!(
            encode_parameter_value(&LogicalValue::Json(r#"{"tag":"first"}"#.to_owned())),
            serde_json::Value::String(r#"{"tag":"first"}"#.to_owned())
        );
    }

    #[test]
    fn json_parameters_are_accepted_only_from_catalog_typed_usage() {
        let catalog = CATALOG.replace(
            "      status: { type: string }",
            "      status: { type: string }\n      metadata: { type: json, representation: object }",
        );
        let policy = POLICY.replace(
            "columns: [id, name, status]",
            "columns: [id, name, status, metadata]",
        );
        let runtime = PolicySqlRuntime::new(
            &catalog,
            &policy,
            "schema_json_parameter",
            "policy_json_parameter",
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":4}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid JSON runtime"));
        let auth = r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#;
        let accepted = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE metadata = :metadata","params":{"metadata":{"tags":["safe"]}}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        let compiled: serde_json::Value = serde_json::from_str(&accepted)
            .unwrap_or_else(|error| unreachable!("compiled JSON parses: {error}"));
        assert_eq!(
            compiled["statements"][0]["clientParameters"]["metadata"],
            r#"{"tags":["safe"]}"#
        );
        let explained = runtime.compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE metadata = :metadata","params":{}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        let explained: serde_json::Value = serde_json::from_str(&explained)
            .unwrap_or_else(|error| unreachable!("Explain JSON parses: {error}"));
        assert_eq!(
            explained["statements"][0]["clientParameterTypes"]["metadata"],
            "json"
        );

        let rejected = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE status = :status","params":{"status":{"nested":true}}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        assert!(rejected.contains("POLICYSQL_INVALID_PARAMETER"));
        assert!(rejected.contains(r#""path":"/statements/0""#));
    }

    #[test]
    fn json_extract_uses_path_value_and_explain_uses_finite_schema_union() {
        let catalog = r"
version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      tenant_id: { type: string }
      metadata:
        type: json
        representation: object
        jsonSchema:
          type: object
          additionalProperties: false
          properties:
            score: { type: integer }
            label: { type: string }
";
        let policy = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [metadata]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 10
";
        let runtime = PolicySqlRuntime::new(
            catalog,
            policy,
            "schema_json_path",
            "policy_json_path",
            r#"{"max_rows":10,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":2}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        let auth = r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#;
        let execute = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT json_extract(metadata, :path) AS value FROM projects","params":{"path":"$.score"}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        let execute: serde_json::Value = serde_json::from_str(&execute)
            .unwrap_or_else(|error| unreachable!("valid JSON: {error}"));
        assert_eq!(
            execute["statements"][0]["result"][0]["logicalType"],
            "integer"
        );

        let explain = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT json_extract(metadata, :path) AS value FROM projects","params":{}}]}"#,
            "explain", crate::TEST_CONTEXT
        );
        let explain: serde_json::Value = serde_json::from_str(&explain)
            .unwrap_or_else(|error| unreachable!("valid JSON: {error}"));
        assert_eq!(
            explain["statements"][0]["result"][0]["logicalType"],
            serde_json::json!(["integer", "string", "json"])
        );
    }

    #[test]
    fn json_table_collection_is_policy_filtered_typed_and_sealed() {
        let catalog = r"
version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      metadata:
        type: json
        representation: object
        jsonSchema:
          type: object
          additionalProperties: false
          properties:
            score: { type: integer }
            label: { type: string }
";
        let policy = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, metadata]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          allow_aggregations: true
          limit: 10
";
        let runtime = PolicySqlRuntime::new(
            catalog,
            policy,
            "schema_json_collection",
            "policy_json_collection",
            r#"{"max_rows":10,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":2}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        let auth = r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#;
        let output = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.metadata, :path) AS j WHERE p.id = :id","params":{"path":"$","id":"p1"}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        let compiled: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid JSON: {error}"));
        assert!(compiled.get("error").is_none(), "{output}");
        assert_eq!(
            compiled["statements"][0]["result"][0]["logicalType"],
            "json"
        );
        assert_eq!(
            compiled["statements"][0]["result"][0]["jsonSchema"]["type"],
            "array"
        );
        assert_eq!(
            compiled["statements"][0]["expectedResultRows"],
            serde_json::json!(1)
        );
        let sql = compiled["statements"][0]["protectedSql"]
            .as_str()
            .unwrap_or_else(|| unreachable!("protected SQL"));
        assert!(sql.contains("JSON_EACH"));
        assert!(sql.contains(":__policysql_session_tenant_id"));

        let denied = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT json_group_array(j.key) AS items FROM projects AS p, json_each(p.metadata, :path) AS j","params":{"path":"$"}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        assert!(denied.contains("POLICYSQL_UNSUPPORTED_SQL"));
    }

    #[test]
    fn mutation_result_check_is_validated_before_handle_release() {
        let runtime = runtime();
        let output = runtime.compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"INSERT INTO projects (id, name, status) VALUES (:id, :name, :status) RETURNING id, name, status","params":{"id":"new_1","name":"New","status":"active"}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        let compiled: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        assert_eq!(compiled["statements"][0]["operationCheck"], true);
        let handle = compiled["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("mutation handle"));
        let raw = serde_json::json!({
            "columns": ["id", "name", "status", "__policysql_check"],
            "rows": [["new_1", "New", "active", 1]],
            "affectedRows": 1
        });
        let validated = runtime.validate_result_json(handle, 0, &raw.to_string());
        assert!(!validated.contains("error"));
        assert!(runtime.release_execution(handle));
    }

    /// Compiles an envelope of two policy-checked inserts and returns its handle.
    fn two_insert_handle(runtime: &PolicySqlRuntime) -> u64 {
        let output = runtime.compile_json(
            r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"INSERT INTO projects (id, name, status) VALUES (:id, :name, :status) RETURNING id, name, status","params":{"id":"new_1","name":"New","status":"active"}},{"sql":"INSERT INTO projects (id, name, status) VALUES (:id, :name, :status) RETURNING id, name, status","params":{"id":"new_2","name":"New","status":"active"}}]}"#,
            "execute", crate::TEST_CONTEXT
        );
        let compiled: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        compiled["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("mutation handle: {output}"))
    }

    /// #145 pull request B: a check column that is not SQL TRUE (FALSE, UNKNOWN, or any other
    /// value) is 403 `POLICYSQL_CHECK_FAILED` at the statement's index, with no `detail`; a
    /// value that does not match the logical type stays 422 `POLICYSQL_SCHEMA_MISMATCH`, also
    /// when a false check is in the same row (the conversion runs first).
    #[test]
    fn a_false_check_is_check_failed_and_a_type_mismatch_stays_schema_mismatch() {
        let runtime = runtime();
        let handle = two_insert_handle(&runtime);
        let validate = |index: usize, row: serde_json::Value| -> serde_json::Value {
            let raw = serde_json::json!({
                "columns": ["id", "name", "status", "__policysql_check"],
                "rows": [row],
                "affectedRows": 1
            });
            parse_json(&runtime.validate_result_json(handle, index, &raw.to_string()))
        };
        let good = serde_json::json!(["new_1", "New", "active", 1]);
        assert!(validate(0, good.clone()).get("error").is_none());
        for check in [serde_json::json!(0), serde_json::Value::Null] {
            for index in [0, 1] {
                let row = serde_json::json!(["new_1", "New", "active", check]);
                let answer = validate(index, row);
                assert_eq!(
                    answer["error"]["code"], "POLICYSQL_CHECK_FAILED",
                    "{answer}"
                );
                assert_eq!(
                    answer["error"]["path"],
                    format!("/statements/{index}"),
                    "{answer}"
                );
                assert!(answer["error"].get("detail").is_none(), "{answer}");
                assert_eq!(
                    answer["error"]["message"],
                    "A changed row does not satisfy the policy check."
                );
            }
        }
        // The value of the wrong type wins over the false check beside it.
        let mismatch = validate(1, serde_json::json!([{"x": 1}, "New", "active", 0]));
        assert_eq!(
            mismatch["error"]["code"], "POLICYSQL_SCHEMA_MISMATCH",
            "{mismatch}"
        );
        assert_eq!(mismatch["error"]["path"], "/statements/1");
        // A column list of another shape is a mismatch, not a check failure.
        let raw = serde_json::json!({"columns": ["id"], "rows": [["new_1"]], "affectedRows": 1});
        let answer = parse_json(&runtime.validate_result_json(handle, 0, &raw.to_string()));
        assert_eq!(
            answer["error"]["code"], "POLICYSQL_SCHEMA_MISMATCH",
            "{answer}"
        );
        assert!(runtime.release_execution(handle));
    }

    /// #145 pull request B: every code a keyed compile can answer is in the fixed cause list
    /// (`OUTCOME_CAUSE_CODES`) with a path of the fixed form; only the result validation's
    /// codes are outside it. A new `RuntimeError` or `RejectionKind` must be placed here.
    #[test]
    #[allow(clippy::too_many_lines)]
    fn every_compile_error_is_a_valid_outcome_cause_and_a_result_error_is_not() {
        use super::{
            ComplexityCause, ExpectationKind, ParameterReason, Rejection, RejectionDetail,
            RejectionKind, RuntimeError, UnsupportedFeature, error_body,
        };
        use policysql_transaction::machine::io::{ErrorDetail, OUTCOME_CAUSE_CODES, is_cause_path};

        let kinds = [
            RejectionKind::InvalidRequest,
            RejectionKind::InvalidSql,
            RejectionKind::MultipleStatements,
            RejectionKind::UnsupportedSql,
            RejectionKind::MissingPolicy,
            RejectionKind::ForbiddenOperation,
            RejectionKind::ForbiddenColumn,
            RejectionKind::ForbiddenColumnContext,
            RejectionKind::DuplicateResultColumn,
            RejectionKind::InvalidParameter,
            RejectionKind::AmbiguousParameterType,
            RejectionKind::ReservedParameter,
            RejectionKind::PresetColumn,
            RejectionKind::LimitExceeded,
            RejectionKind::ExpectationFailed,
        ];
        // Not a check of `kinds`' contents: the match fails to compile when a kind is added.
        for kind in kinds {
            match kind {
                RejectionKind::InvalidRequest
                | RejectionKind::InvalidSql
                | RejectionKind::MultipleStatements
                | RejectionKind::UnsupportedSql
                | RejectionKind::MissingPolicy
                | RejectionKind::ForbiddenOperation
                | RejectionKind::ForbiddenColumn
                | RejectionKind::ForbiddenColumnContext
                | RejectionKind::DuplicateResultColumn
                | RejectionKind::InvalidParameter
                | RejectionKind::AmbiguousParameterType
                | RejectionKind::ReservedParameter
                | RejectionKind::PresetColumn
                | RejectionKind::LimitExceeded
                | RejectionKind::ExpectationFailed => {}
            }
        }
        // A rejection as a real site builds it: the kinds with a row in the public detail table
        // carry the detail of that row.
        let representative = |kind: RejectionKind| Rejection {
            kind,
            detail: match kind {
                RejectionKind::UnsupportedSql => {
                    Some(RejectionDetail::Feature(UnsupportedFeature::Star))
                }
                RejectionKind::InvalidParameter => {
                    Some(RejectionDetail::Parameter(ParameterReason::Names))
                }
                RejectionKind::ExpectationFailed => {
                    Some(RejectionDetail::Expectation(ExpectationKind::RowCount))
                }
                RejectionKind::LimitExceeded => {
                    Some(RejectionDetail::Limit(policysql_core::LimitName::MaxJoins))
                }
                _ => None,
            },
            reason: "bind.Test",
            shape: None,
        };
        let mut errors = vec![
            RuntimeError::Session,
            RuntimeError::Access,
            RuntimeError::Snapshot,
            RuntimeError::Envelope,
            RuntimeError::RequestTooLarge,
            RuntimeError::AuthTooLarge,
            RuntimeError::Internal,
            RuntimeError::Busy,
            RuntimeError::RemoteResult,
        ];
        for index in [0, 7] {
            errors.extend([
                RuntimeError::EnvelopeAt(index),
                RuntimeError::SqlTooLargeAt(index),
                RuntimeError::TooComplexAt(ComplexityCause::Height, index),
                RuntimeError::EmittedSqlInvalidAt(index),
                RuntimeError::RemoteResultAt(index),
                RuntimeError::CheckFailedAt(index),
            ]);
            for kind in kinds {
                errors.push(RuntimeError::RejectedAt(representative(kind), index));
            }
        }
        errors.extend(kinds.map(|kind| RuntimeError::Rejected(representative(kind))));
        for error in errors {
            // Exhaustive: a new variant fails to compile until it is placed.
            let in_cause_list = match error {
                RuntimeError::Session
                | RuntimeError::Access
                | RuntimeError::Snapshot
                | RuntimeError::Envelope
                | RuntimeError::EnvelopeAt(_)
                | RuntimeError::RequestTooLarge
                | RuntimeError::SqlTooLargeAt(_)
                | RuntimeError::Rejected(_)
                | RuntimeError::RejectedAt(..)
                | RuntimeError::TooComplexAt(..)
                | RuntimeError::EmittedSqlInvalidAt(_)
                | RuntimeError::Internal
                | RuntimeError::AuthTooLarge
                | RuntimeError::Busy => true,
                RuntimeError::RemoteResult
                | RuntimeError::RemoteResultAt(_)
                | RuntimeError::CheckFailedAt(_) => false,
            };
            let body = error_body(error);
            assert_eq!(
                OUTCOME_CAUSE_CODES.contains(&body.code),
                in_cause_list,
                "{error:?} -> {}",
                body.code
            );
            // The detail is what the public table allows for the code: required for a code
            // with a row (`INVALID_SQL` excepted), absent for every other code.
            let detail = body
                .detail
                .as_ref()
                .map(|detail| serde_json::to_value(detail).unwrap_or_default());
            assert!(
                ErrorDetail::allowed(body.code, detail.as_ref()),
                "{error:?} -> {} {detail:?}",
                body.code
            );
            if in_cause_list {
                // A keyed unknown outcome carries the cause's detail, checked as the reply is.
                let cause = serde_json::json!({"cause": {
                    "code": body.code,
                    "path": body.path,
                    "detail": detail,
                }});
                assert!(
                    ErrorDetail::allowed("POLICYSQL_OUTCOME_UNKNOWN", Some(&cause)),
                    "{error:?} -> {cause}"
                );
            }
            if in_cause_list {
                assert!(
                    body.path.as_deref().is_none_or(is_cause_path),
                    "{error:?} -> {:?}",
                    body.path
                );
            }
        }
    }

    // ADR 0027 pull request 3: the request-side limits, derived bounds, and their codes.
    const AUTH: &str = r#"{"principal":"test:user","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#;

    fn runtime_with(limits: &str) -> PolicySqlRuntime {
        PolicySqlRuntime::new(CATALOG, POLICY, "schema_test", "policy_test", limits)
            .unwrap_or_else(|_| unreachable!("valid runtime"))
    }

    fn parse_json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap_or_else(|error| unreachable!("JSON: {error}"))
    }

    const REQUIRED: &str =
        r#""max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":4"#;

    #[test]
    fn sql_over_max_sql_bytes_is_413_with_its_path_before_it_is_parsed() {
        for max_sql in [1_024_usize, 65_536] {
            let runtime = runtime_with(&format!(r#"{{{REQUIRED},"max_sql_bytes":{max_sql}}}"#));
            let at_limit = format!(
                "SELECT id FROM projects /*{}*/",
                " ".repeat(max_sql - "SELECT id FROM projects /**/".len())
            );
            assert_eq!(at_limit.len(), max_sql);
            let request = |sql: &str| {
                serde_json::json!({"statements": [
                    {"sql": "SELECT id FROM projects", "params": {}},
                    {"sql": sql, "params": {}},
                ]})
                .to_string()
            };
            let accepted = parse_json(&runtime.compile_json(
                AUTH,
                &request(&at_limit),
                "execute",
                crate::TEST_CONTEXT,
            ));
            assert!(accepted.get("error").is_none(), "{accepted}");
            // One byte over, and not valid SQL: the length is judged first, so it is 413 and
            // never a parse error (400).
            let over = format!("{}x", "?".repeat(max_sql));
            let rejected = parse_json(&runtime.compile_json(
                AUTH,
                &request(&over),
                "execute",
                crate::TEST_CONTEXT,
            ));
            assert_eq!(rejected["error"]["code"], "POLICYSQL_REQUEST_TOO_LARGE");
            assert_eq!(rejected["error"]["path"], "/statements/1/sql");
            // The limit counts UTF-8 bytes, not characters.
            let multibyte = format!("{}{}", "SELECT 1 /*", "é".repeat(max_sql / 2));
            assert!(multibyte.len() > max_sql && multibyte.chars().count() <= max_sql);
            let rejected = parse_json(&runtime.compile_json(
                AUTH,
                &request(&multibyte),
                "execute",
                crate::TEST_CONTEXT,
            ));
            assert_eq!(rejected["error"]["code"], "POLICYSQL_REQUEST_TOO_LARGE");
        }
    }

    #[test]
    fn a_request_past_the_derived_compile_bound_is_413_and_one_at_the_limit_is_not() {
        let runtime = runtime_with(&format!(r#"{{{REQUIRED},"max_request_bytes":65536}}"#));
        let body = |len: usize| {
            let head = r#"{"statements":[{"sql":"SELECT id FROM projects WHERE name = :name","params":{"name":""#;
            let tail = r#""}}]}"#;
            format!("{head}{}{tail}", "x".repeat(len - head.len() - tail.len()))
        };
        let at_limit = body(65_536);
        assert_eq!(at_limit.len(), 65_536);
        let accepted =
            parse_json(&runtime.compile_json(AUTH, &at_limit, "execute", crate::TEST_CONTEXT));
        assert!(accepted.get("error").is_none(), "{accepted}");
        // The bound is the auth, the body limit, and 1,024 bytes of framing: the engine has
        // already refused a body over the limit, so core answers only for what no limit admits.
        let bound = policysql_transaction::bounds::compile_input_bytes(65_536) - AUTH.len();
        let rejected = parse_json(&runtime.compile_json(
            AUTH,
            &body(bound + 1),
            "execute",
            crate::TEST_CONTEXT,
        ));
        assert_eq!(rejected["error"]["code"], "POLICYSQL_REQUEST_TOO_LARGE");
        assert!(rejected["error"]["path"].is_null());
        let still_ok =
            parse_json(&runtime.compile_json(AUTH, &body(bound), "execute", crate::TEST_CONTEXT));
        assert!(still_ok.get("error").is_none(), "{still_ok}");
    }

    #[test]
    fn the_session_input_bound_is_65536_bytes() {
        let runtime = runtime();
        let session = |pad: usize| {
            format!(
                r#"{{"principal":"p","subject":"s","roles":["member"],"defaultRole":"member","access":["execute"],"session":{{"tenant_id":"{}"}}}}"#,
                "x".repeat(pad)
            )
        };
        let base = session(0).len();
        let at_limit = session(65_536 - base);
        assert_eq!(at_limit.len(), 65_536);
        let accepted = parse_json(&runtime.authorize_session_json(&at_limit, None, "execute"));
        assert!(accepted.get("error").is_none(), "{accepted}");
        let over =
            parse_json(&runtime.authorize_session_json(&session(65_537 - base), None, "execute"));
        assert_eq!(over["error"]["code"], "POLICYSQL_INTERNAL");
        assert_eq!(over["fault"], "shape");
    }

    /// The computed bounds never reject what the configured limits accept, at the defaults
    /// and at the hard maxima, with a body of JSON-escaped text (the worst case for the step
    /// event and the hash input) and the largest session and auth.
    #[test]
    fn computed_bounds_admit_everything_the_configured_limits_accept() {
        for max_request in [65_536_usize, 1_048_576, 2_097_152] {
            let runtime = runtime_with(&format!(
                r#"{{{REQUIRED},"max_request_bytes":{max_request}}}"#
            ));
            let limits = runtime.machine_limits();
            // A body of `max_request` bytes made of escaped quotes: embedded as a JSON string
            // it is twice as long (and `\` doubles the same way).
            let head = r#"{"statements":[{"sql":"SELECT id FROM projects WHERE name = :name","params":{"name":""#;
            let tail = r#""}}]}"#;
            let quotes = (max_request - head.len() - tail.len()) / 2;
            let body = format!("{head}{}{tail}", r#"\""#.repeat(quotes));
            assert!(body.len() <= max_request && body.len() >= max_request - 1);
            let escaped = serde_json::to_string(&body).unwrap_or_default();
            assert!(
                escaped.len() > body.len() * 3 / 2 && escaped.len() <= 2 * body.len() + 2,
                "the body about doubles, and never more, in the event"
            );
            // A session of the largest size the wrapper may pass, in the auth core emits.
            let session = format!(
                r#"{{"principal":"p","subject":"s","roles":["member"],"defaultRole":"member","access":["execute"],"session":{{"tenant_id":"t","pad":"{}"}}}}"#,
                "x".repeat(65_536 - 150)
            );
            let authorized = parse_json(&runtime.authorize_session_json(&session, None, "execute"));
            let auth = authorized["auth"].to_string();
            assert!(
                auth.len() <= policysql_transaction::bounds::AUTH_BYTES,
                "{}",
                auth.len()
            );
            // Compile: the auth and the body fit the derived compile bound.
            assert!(
                auth.len() + body.len()
                    <= policysql_transaction::bounds::compile_input_bytes(max_request)
            );
            // Identity (hash input): auth, binding, key, and the body embedded as a string.
            let binding = serde_json::json!({"version": 1, "scope": "tenant", "databaseId": "db_1", "generation": "1", "snapshot": "s"});
            let input = serde_json::json!({
                "op": "request", "endpoint": "execute", "auth": authorized["auth"],
                "binding": binding, "body": body, "key": "k".repeat(128),
            })
            .to_string();
            assert!(
                input.len() <= limits.max_hash_input_bytes(),
                "{max_request}"
            );
            let identity = parse_json(&runtime.identity_json(&input));
            assert!(identity["idempotency"]["keyHash"].is_string(), "{identity}");
            // The step event: the body text (escaped), the auth, the binding, and the largest
            // raw read (the envelope raw bound at its maximum, or the idempotency lookup).
            let event_floor = escaped.len()
                + auth.len()
                + binding.to_string().len()
                + policysql_transaction::bounds::LOOKUP_BYTES;
            assert!(event_floor <= limits.max_event_bytes(), "{max_request}");
        }
    }

    #[test]
    fn hash_input_over_its_bound_is_a_wrapper_fault_not_a_limit() {
        let runtime = runtime_with(&format!(r#"{{{REQUIRED},"max_request_bytes":65536}}"#));
        let bound = runtime.machine_limits().max_hash_input_bytes();
        let over = format!(r#"{{"op":"callback","command":"{}"}}"#, "x".repeat(bound));
        assert!(over.len() > bound);
        assert!(runtime.identity_json(&over).contains("POLICYSQL_INTERNAL"));
        assert!(
            runtime
                .cost_estimate_json(&over)
                .contains("POLICYSQL_COST_ADMISSION_UNAVAILABLE")
        );
    }

    /// The verified auth carries the selected role twice (`role` and inside `roles`), so a
    /// session of 40,146 bytes with a 40,000-byte role selected gives an auth of about 80 KB:
    /// every bound derived from the auth must admit it, at every request limit.
    #[test]
    fn a_long_selected_role_passes_every_auth_derived_bound() {
        let role = format!("r{}", "x".repeat(40_000));
        let session = serde_json::json!({
            "principal": "p", "subject": "s", "roles": ["member", role],
            "defaultRole": "member", "access": ["execute", "catalog"],
            "session": {"tenant_id": "t"},
        })
        .to_string();
        assert!(session.len() <= policysql_transaction::bounds::SESSION_INPUT_BYTES);
        for max_request in [65_536_usize, 1_048_576, 2_097_152] {
            let runtime = runtime_with(&format!(
                r#"{{{REQUIRED},"max_request_bytes":{max_request}}}"#
            ));
            let authorized = parse_json(&runtime.authorize_session_json(
                &session,
                Some(role.clone()),
                "execute",
            ));
            let auth = authorized["auth"].to_string();
            assert!(auth.len() > 80_000 - 200, "{}", auth.len());
            assert!(auth.len() <= policysql_transaction::bounds::AUTH_BYTES);
            let compiled = parse_json(&runtime.compile_json(
                &auth,
                r#"{"statements":[{"sql":"SELECT id FROM projects","params":{}}]}"#,
                "execute",
                crate::TEST_CONTEXT,
            ));
            // No policy for the long role: a policy answer, never a size or bound answer.
            for code in [
                "POLICYSQL_INTERNAL",
                "POLICYSQL_REQUEST_TOO_LARGE",
                "POLICYSQL_INVALID_REQUEST",
            ] {
                assert_ne!(compiled["error"]["code"], code, "{compiled}");
            }
            let catalog = parse_json(&runtime.catalog_json(&auth));
            for code in ["POLICYSQL_INTERNAL", "POLICYSQL_INVALID_REQUEST"] {
                assert_ne!(catalog["error"]["code"], code, "{catalog}");
            }
            // Keyed identity: auth, binding, a 128-byte key, and a body at the limit.
            let body = format!("\"{}\"", "\\\"".repeat(max_request / 2 - 1));
            let binding = serde_json::json!({"version": 1, "scope": "tenant", "databaseId": "db_1", "generation": "1", "snapshot": "s"});
            let input = serde_json::json!({
                "op": "request", "endpoint": "execute", "auth": authorized["auth"],
                "binding": binding, "body": body, "key": "k".repeat(128),
            })
            .to_string();
            assert!(input.len() <= runtime.machine_limits().max_hash_input_bytes());
            let identity = parse_json(&runtime.identity_json(&input));
            assert!(identity["idempotency"]["keyHash"].is_string(), "{identity}");
            // The step event embeds the auth and the escaped body.
            let event = auth.len()
                + serde_json::to_string(&body).unwrap_or_default().len()
                + binding.to_string().len();
            assert!(event <= runtime.machine_limits().max_event_bytes());
        }
    }

    #[test]
    fn an_auth_over_its_derived_bound_is_an_internal_fault_not_a_bad_request() {
        let runtime = runtime();
        let over = format!(
            r#"{{"principal":"p","subject":"s","role":"member","roles":["member"],"access":["execute"],"session":{{"tenant_id":"{}"}}}}"#,
            "x".repeat(policysql_transaction::bounds::AUTH_BYTES)
        );
        let compiled = parse_json(&runtime.compile_json(
            &over,
            r#"{"statements":[{"sql":"SELECT id FROM projects","params":{}}]}"#,
            "execute",
            crate::TEST_CONTEXT,
        ));
        assert_eq!(compiled["error"]["code"], "POLICYSQL_INTERNAL");
        let catalog = parse_json(&runtime.catalog_json(&over));
        assert_eq!(catalog["error"]["code"], "POLICYSQL_INTERNAL");
    }

    // ADR 0027 pull request 4: the emitted statement is measured, and the input-side limits
    // are the runtime's configured ones.

    fn code_of(output: &str) -> String {
        parse_json(output)["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    fn compile_one(runtime: &PolicySqlRuntime, sql: &str, params: &serde_json::Value) -> String {
        runtime.compile_json(
            AUTH,
            &serde_json::json!({"statements": [{"sql": sql, "params": params}]}).to_string(),
            "execute",
            crate::TEST_CONTEXT,
        )
    }

    #[test]
    fn the_input_side_limits_are_the_configured_ones_at_the_value_and_one_over() {
        let runtime = runtime_with(&format!(
            r#"{{{REQUIRED},"max_parameters":2,"max_expression_depth":3,"max_projections":2,"max_joins":1}}"#
        ));
        let none = serde_json::json!({});
        assert!(!compile_one(&runtime, "SELECT id, name FROM projects", &none).contains("error"));
        assert_eq!(
            code_of(&compile_one(
                &runtime,
                "SELECT id, name, status FROM projects",
                &none
            )),
            "POLICYSQL_LIMIT_EXCEEDED"
        );
        let two = serde_json::json!({"a": "x", "b": "y"});
        assert!(
            !compile_one(
                &runtime,
                "SELECT id FROM projects WHERE name = :a OR name = :b",
                &two
            )
            .contains("error")
        );
        let three = serde_json::json!({"a": "x", "b": "y", "c": "z"});
        assert_eq!(
            code_of(&compile_one(
                &runtime,
                "SELECT id FROM projects WHERE name = :a OR name = :b OR name = :c",
                &three
            )),
            "POLICYSQL_LIMIT_EXCEEDED"
        );
        let limits = parse_json(&runtime.limits_json());
        assert_eq!(limits["maxParameters"], 2);
        assert_eq!(limits["maxExpressionDepth"], 3);
        assert_eq!(limits["maxProjections"], 2);
        assert_eq!(limits["maxJoins"], 1);
    }

    #[test]
    fn a_bound_like_pattern_over_50000_bytes_is_too_complex_with_a_fixed_message() {
        let runtime = runtime_with(&format!("{{{REQUIRED}}}"));
        let like = |pattern: &str| {
            compile_one(
                &runtime,
                "SELECT id FROM projects WHERE name LIKE :q",
                &serde_json::json!({"q": pattern}),
            )
        };
        assert!(!like(&"a".repeat(50_000)).contains("error"));
        let refused = parse_json(&like(&"a".repeat(50_001)));
        assert_eq!(refused["error"]["code"], "POLICYSQL_SQL_TOO_COMPLEX");
        assert_eq!(
            refused["error"]["message"],
            "The statement is too complex to run under the active policy."
        );
        assert_eq!(refused["error"]["path"], "/statements/0");
        let text = refused.to_string();
        for internal in ["LIKE", "projects", "tenant_id", "__policysql", "aaaa"] {
            assert!(!text.contains(internal), "{internal}: {text}");
        }
    }

    #[test]
    fn the_projection_limit_maximum_is_2000_and_one_over_is_the_input_side_limit() {
        let runtime = runtime_with(&format!(r#"{{{REQUIRED},"max_projections":2000}}"#));
        let wide = |count: usize| {
            let columns = (0..count)
                .map(|index| format!("id AS c{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            compile_one(
                &runtime,
                &format!("SELECT {columns} FROM projects"),
                &serde_json::json!({}),
            )
        };
        assert!(!wide(2_000).contains("error"));
        // The input-side limit answers first; emitted columns beyond 2,000 need companion
        // columns (a conditional projection), which the HTTP tests exercise.
        assert_eq!(code_of(&wide(2_001)), "POLICYSQL_LIMIT_EXCEEDED");
    }

    #[test]
    fn the_column_metadata_of_an_envelope_is_guarded_at_one_mebibyte() {
        // Aliases are doubled for JSON escaping: three statements of a 200,000-byte alias are
        // 1,200,000 bytes of metadata, two are 800,000.
        let runtime = runtime_with(
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":8,"max_request_bytes":2097152,"max_sql_bytes":262144}"#,
        );
        let alias = "a".repeat(200_000);
        let request = |count: usize| {
            serde_json::json!({"statements": (0..count)
                .map(|_| serde_json::json!({"sql": format!("SELECT id AS \"{alias}\" FROM projects"), "params": {}}))
                .collect::<Vec<_>>()})
            .to_string()
        };
        assert!(
            !runtime
                .compile_json(AUTH, &request(2), "execute", crate::TEST_CONTEXT)
                .contains("error")
        );
        let refused =
            parse_json(&runtime.compile_json(AUTH, &request(3), "execute", crate::TEST_CONTEXT));
        assert_eq!(refused["error"]["code"], "POLICYSQL_SQL_TOO_COMPLEX");
        assert_eq!(refused["error"]["path"], "/statements/2");
    }
}
