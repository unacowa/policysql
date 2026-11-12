//! Events, host facts, effects, and replies as they cross the ABI (ADR 0024, "Events and host
//! facts", "Effects").

use super::state::{Binding, Mode};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

/// Everything nondeterministic or deployment-owned that core needs, supplied on every call.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostFacts {
    /// `Date.now()` when the engine took the event.
    pub now_ms: u64,
    /// 32 fresh random bytes as 64 lowercase hex digits; core uses them or not.
    pub entropy: String,
    /// The caller's request id or a fresh one (ADR 0023 rules).
    pub request_id: String,
    /// The owner running this step; `None` in the engine (the `request` kind and atomic
    /// execution with placement `direct`).
    pub owner: Option<String>,
    /// Check ids with an endpoint in `PolicySqlConfig`, empty when it has no `publicBaseUrl`
    /// (ADR 0021): a triggered check outside this list rejects the commit before any
    /// capability or validator call.
    #[serde(default)]
    pub configured_checks: Vec<String>,
}

/// The request id syntax of ADR 0023 (`REQUEST_ID` in `engine.ts`).
#[must_use]
pub fn valid_request_id(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

impl HostFacts {
    /// Host facts the machine can run with: an owner name or none (the engine), a time
    /// JavaScript holds exactly, 32 bytes of entropy.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        self.now_ms <= super::MAX_TIME_MS
            && super::state::hex64(&self.entropy)
            && valid_request_id(&self.request_id)
            && self.owner.as_deref().is_none_or(super::state::owner_name)
            && self.configured_checks.len() <= 64
            && self
                .configured_checks
                .iter()
                .all(|id| !id.is_empty() && id.len() <= 128)
    }

    /// The entropy bytes `range` (core takes disjoint slices for different uses).
    #[must_use]
    pub fn entropy_u64(&self, offset: usize) -> u64 {
        self.entropy
            .get(offset * 2..offset * 2 + 12)
            .and_then(|hex| u64::from_str_radix(hex, 16).ok())
            .unwrap_or(0)
    }

    /// The 16 entropy bytes 16..32 as 32 lowercase hex digits: the id of an unkeyed atomic
    /// owner (disjoint from the bytes that seed effect ids).
    #[must_use]
    pub fn entropy_id(&self) -> Option<&str> {
        self.entropy.get(32..64)
    }

    /// All 32 entropy bytes (the capability token).
    #[must_use]
    pub fn entropy_bytes(&self) -> Option<[u8; 32]> {
        let mut bytes = [0_u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            let hex = self.entropy.get(index * 2..index * 2 + 2)?;
            *byte = u8::from_str_radix(hex, 16).ok()?;
        }
        Some(bytes)
    }
}

/// The error classes an adapter reports for a failed effect. Core never sees a message.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Class {
    Timeout,
    Unavailable,
    Rejected,
    NotCommitted,
    Unknown,
    /// The database answered, but its answer exceeded a bound of the adapter's codec or
    /// transport (a BLOB over the per-value limit, a response over the transport's size
    /// bound), so it could not be carried as `executed`. Added by ADR 0024 pull request 8, for
    /// the `POLICYSQL_LIMIT_EXCEEDED` the TypeScript paths answered; only `executeFailed`
    /// carries it.
    Limit,
    /// The database refused the statement for complexity (ADR 0027): `code == SQLITE_ERROR` and
    /// a message on the allowlist of the `SQLITE_LIMIT_*` family, recognised by the adapter on
    /// a statement request and never on COMMIT. Only `executeFailed` carries it, with the index
    /// of the failed statement.
    Complex,
    /// The database refused the statement as a constraint violation (`SQLITE_CONSTRAINT`,
    /// ADR 0030). An adapter may report it only when the reply left the transaction open and
    /// it knows nothing after the failed statement ran (the conditional batch and the baton of
    /// #144). Only `executeFailed` carries it, with the index of the failed statement and a
    /// `constraint` name.
    Constraint,
}

/// The kind of a constraint violation (ADR 0030): one fixed value per refused statement.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintKind {
    Unique,
    NotNull,
    ForeignKey,
    Check,
    Other,
}

impl ConstraintKind {
    /// The kind an adapter named. An unknown name and no name are `Other`.
    #[must_use]
    pub fn from_name(name: Option<&str>) -> Self {
        match name {
            Some("unique") => Self::Unique,
            Some("not_null") => Self::NotNull,
            Some("foreign_key") => Self::ForeignKey,
            Some("check") => Self::Check,
            _ => Self::Other,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Unique => "unique",
            Self::NotNull => "not_null",
            Self::ForeignKey => "foreign_key",
            Self::Check => "check",
            Self::Other => "other",
        }
    }

    /// The fixed message of the kind. It never carries the database's own text.
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Unique => "The statement violates a unique constraint.",
            Self::NotNull => "The statement violates a NOT NULL constraint.",
            Self::ForeignKey => "The statement violates a foreign key constraint.",
            Self::Check => "The statement violates a CHECK constraint.",
            Self::Other => "The statement violates a database constraint.",
        }
    }
}

/// The causes an adapter may name for a database complexity refusal (ADR 0027).
pub const COMPLEXITY_CAUSES: [&str; 7] = [
    "columns",
    "parameters",
    "like_pattern",
    "database_expression_depth",
    "function_arguments",
    "compound_terms",
    "join_tables",
];

/// Usage a driver reported for one statement.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverUsage {
    pub rows_read: u64,
    pub rows_written: u64,
    pub query_duration_ms: f64,
}

/// One raw driver result. Row values went through the engine's codec: JSON scalars, BLOBs as
/// `{"type":"blob","base64":…}`, and a value the codec could not represent as
/// `{"type":"invalid","limit":bool}`, which core rejects (`limit`: a BLOB over the per-value
/// limit, else a schema mismatch).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: u64,
    pub usage: DriverUsage,
}

/// One event. Outcome events name the effect id they answer.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Event {
    /// A client operation the engine received (the `request` kind; pull request 6 implements
    /// `execute`). Its session and binding were validated by the engine; core validates the
    /// shape again.
    Request {
        operation: serde_json::Value,
    },
    /// What a `Forward` delivered to this owner: untrusted, validated field by field.
    Forwarded {
        input: serde_json::Value,
    },
    TimerFired,
    Opened {
        id: u64,
    },
    OpenFailed {
        id: u64,
        class: Class,
    },
    BindingChecked {
        id: u64,
        allowed: bool,
    },
    BindingCheckFailed {
        id: u64,
        class: Class,
    },
    Executed {
        id: u64,
        results: Vec<DriverResult>,
    },
    ExecuteFailed {
        id: u64,
        class: Class,
        /// The failed statement's index within the `execute` effect (class `complex`).
        #[serde(default)]
        statement: Option<u64>,
        /// The database's error code of a failure that no class names (the Hrana `code`),
        /// logged as `database_error_unclassified`. Never the message.
        #[serde(default, rename = "databaseCode")]
        database_code: Option<String>,
        /// Which complexity limit the database reached (class `complex`): one of the fixed
        /// names of [`COMPLEXITY_CAUSES`]; anything else is logged as `database`.
        #[serde(default)]
        cause: Option<String>,
        /// The kind of a constraint violation (class `constraint`): one of the names of
        /// [`ConstraintKind`]; anything else, and no name, is `other`.
        #[serde(default)]
        constraint: Option<String>,
    },
    Committed {
        id: u64,
    },
    CommitFailed {
        id: u64,
        class: Class,
    },
    RolledBack {
        id: u64,
    },
    RollbackFailed {
        id: u64,
        class: Class,
    },
    Persisted {
        id: u64,
    },
    PersistFailed {
        id: u64,
    },
    TimerSet {
        id: u64,
    },
    TimerFailed {
        id: u64,
    },
    /// The validator answered: whether its HTTP status was 2xx, and its JSON body (`null`
    /// when it was not JSON). Untrusted: core checks the decision's exact shape.
    ValidatorReplied {
        id: u64,
        ok: bool,
        decision: serde_json::Value,
    },
    /// No answer arrived (transport error, timeout, redirect, or a configuration the hook
    /// adapter refused at the exit).
    ValidatorFailed {
        id: u64,
        class: Class,
    },
    /// The owner's reply to a `Forward` (untrusted: core checks its shape).
    OwnerReplied {
        id: u64,
        reply: serde_json::Value,
    },
    /// The owner could not be reached or did not reply.
    ForwardFailed {
        id: u64,
        class: Class,
    },
    /// The engine is discarding volatile state (owner shutdown, unexpected engine error).
    Abandon,
}

impl Event {
    /// The effect id an outcome event answers.
    #[must_use]
    pub const fn outcome_id(&self) -> Option<u64> {
        match self {
            Self::Opened { id }
            | Self::OpenFailed { id, .. }
            | Self::BindingChecked { id, .. }
            | Self::BindingCheckFailed { id, .. }
            | Self::Executed { id, .. }
            | Self::ExecuteFailed { id, .. }
            | Self::Committed { id }
            | Self::CommitFailed { id, .. }
            | Self::RolledBack { id }
            | Self::RollbackFailed { id, .. }
            | Self::Persisted { id }
            | Self::PersistFailed { id }
            | Self::TimerSet { id }
            | Self::TimerFailed { id }
            | Self::ValidatorReplied { id, .. }
            | Self::ValidatorFailed { id, .. }
            | Self::OwnerReplied { id, .. }
            | Self::ForwardFailed { id, .. } => Some(*id),
            Self::Request { .. } | Self::Forwarded { .. } | Self::TimerFired | Self::Abandon => {
                None
            }
        }
    }

    /// The awaited effect an outcome event answers.
    #[must_use]
    pub const fn answers(&self) -> Option<super::state::Awaited> {
        use super::state::Awaited;
        match self {
            Self::Opened { .. } | Self::OpenFailed { .. } => Some(Awaited::Open),
            Self::BindingChecked { .. } | Self::BindingCheckFailed { .. } => {
                Some(Awaited::CheckBinding)
            }
            Self::Executed { .. } | Self::ExecuteFailed { .. } => Some(Awaited::Execute),
            Self::Committed { .. } | Self::CommitFailed { .. } => Some(Awaited::Commit),
            Self::RolledBack { .. } | Self::RollbackFailed { .. } => Some(Awaited::Rollback),
            Self::Persisted { .. } | Self::PersistFailed { .. } => Some(Awaited::Persist),
            Self::TimerSet { .. } | Self::TimerFailed { .. } => Some(Awaited::SetTimer),
            Self::ValidatorReplied { .. } | Self::ValidatorFailed { .. } => {
                Some(Awaited::CallValidator)
            }
            Self::OwnerReplied { .. } | Self::ForwardFailed { .. } => Some(Awaited::Forward),
            Self::Request { .. } | Self::Forwarded { .. } | Self::TimerFired | Self::Abandon => {
                None
            }
        }
    }
}

/// A statement as the database port takes it.
#[derive(Clone, Debug, Serialize)]
pub struct DriverCall {
    pub sql: String,
    pub args: BTreeMap<String, serde_json::Value>,
}

/// The context `Observe` carries to the background cost observation: every statement of the
/// envelope, in order (the `statements` input of `cost_estimate_json`); `Observe.statements`
/// holds the cost statements of the non-insert ones, in the same order.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveContext {
    pub request_id: String,
    /// The pinned binding the cost connection uses (ADR 0014).
    pub binding: Binding,
    pub statements: Vec<ObservedStatement>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedStatement {
    pub operation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub explain_resource: Option<u64>,
}

/// One effect. Awaited effects carry an id that their outcome event repeats; a batch holds any
/// number of immediate effects followed by at most one awaited effect.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Effect {
    /// Delivers `input` to the owner `owner` on `lane` (ADR 0022); its reply comes back as
    /// `OwnerReplied`.
    Forward {
        id: u64,
        owner: String,
        lane: &'static str,
        input: Box<RawValue>,
    },
    #[serde(rename_all = "camelCase")]
    Open {
        id: u64,
        /// The pinned binding to connect to (ADR 0014).
        binding: Binding,
        mode: Mode,
        timeout_ms: u64,
        deadline_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    CheckBinding {
        id: u64,
        binding: Binding,
        #[serde(skip_serializing_if = "Option::is_none")]
        deadline_ms: Option<u64>,
    },
    /// `trace`, when present, is the execution trace (`turso.ts` `executionTrace`) the engine
    /// publishes to its sink before it runs the statements. `max_response_bytes` is the read cap
    /// of the database's reply to these statements (ADR 0027): the compiled raw result bound, the
    /// idempotency lookup bound, or the fixed bound of a statement with no result data.
    #[serde(rename_all = "camelCase")]
    Execute {
        id: u64,
        statements: Vec<DriverCall>,
        trace: Option<Box<RawValue>>,
        max_response_bytes: u64,
    },
    Commit {
        id: u64,
    },
    Rollback {
        id: u64,
    },
    #[serde(rename_all = "camelCase")]
    SetTimer {
        id: u64,
        at_ms: u64,
    },
    /// Writes the durable state returned by the step that emitted it.
    Persist {
        id: u64,
    },
    /// Calls the validator of `check` (ADR 0007). The hook adapter looks up the endpoint and
    /// secret by the check id in the validated configuration, adds the `query` block (the
    /// capability token, the callback URL for `payload.validationId`, and the expiry) to
    /// `payload`, signs, and sends; secrets never enter core.
    #[serde(rename_all = "camelCase")]
    CallValidator {
        id: u64,
        check: String,
        /// The hook body without `query`, in its wire key order.
        payload: Box<RawValue>,
        capability: CapabilityGrant,
        timeout_ms: u64,
    },
    /// `lane` is `client` or `callback`.
    Respond {
        lane: &'static str,
        reply: Box<RawValue>,
    },
    #[serde(rename_all = "camelCase")]
    Observe {
        statements: Vec<DriverCall>,
        context: ObserveContext,
        /// The read cap of the cost statements' reply (the envelope's raw result bound).
        max_response_bytes: u64,
    },
    Log {
        record: Box<RawValue>,
    },
    /// Drop in-memory state; the next event starts from the store with no volatile part.
    Reset,
}

impl Effect {
    /// The id of an awaited effect.
    #[must_use]
    pub const fn id(&self) -> Option<u64> {
        match self {
            Self::Forward { id, .. }
            | Self::Open { id, .. }
            | Self::CheckBinding { id, .. }
            | Self::Execute { id, .. }
            | Self::Commit { id }
            | Self::Rollback { id }
            | Self::SetTimer { id, .. }
            | Self::Persist { id }
            | Self::CallValidator { id, .. } => Some(*id),
            Self::Respond { .. } | Self::Observe { .. } | Self::Log { .. } | Self::Reset => None,
        }
    }

    #[must_use]
    pub const fn is_awaited(&self) -> bool {
        matches!(
            self,
            Self::Forward { .. }
                | Self::Open { .. }
                | Self::CheckBinding { .. }
                | Self::Execute { .. }
                | Self::Commit { .. }
                | Self::Rollback { .. }
                | Self::SetTimer { .. }
                | Self::Persist { .. }
                | Self::CallValidator { .. }
        )
    }
}

/// The callback capability handed to one validator: the opaque token (32 random bytes,
/// base64url) and its expiry. Core keeps only the token's SHA-256, in volatile state.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrant {
    pub token: String,
    pub expires_at_ms: u64,
}

/// The client-facing errors the machine returns itself; compile and validation errors pass
/// through as the compiler reports them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Code {
    Invalid,
    Conflict,
    Unavailable,
    Internal,
    OutcomeUnknown,
    TransactionLimit,
    ModeViolation,
    CheckRejected,
    Stale,
    BindingRejected,
    DatabaseTimeout,
    DatabaseUnavailable,
    SchemaMismatch,
    LimitExceeded,
    IdempotencyConflict,
    KeyInvalid,
    Timeout,
    SqlTooComplex,
    /// The database refused a statement as a constraint violation (ADR 0030, #145).
    ConstraintViolation,
    /// Request JSON nests deeper than the documented depth (ADR 0027 pull request 7, #66).
    JsonTooDeep,
}

impl Code {
    #[must_use]
    pub const fn parts(self) -> (&'static str, &'static str) {
        match self {
            Self::Invalid => ("POLICYSQL_INVALID_REQUEST", "The request is invalid."),
            Self::Conflict => (
                "POLICYSQL_TRANSACTION_CONFLICT",
                "The transaction command conflicts with its current state.",
            ),
            Self::Unavailable => (
                "POLICYSQL_TRANSACTION_UNAVAILABLE",
                "The transaction is no longer active.",
            ),
            Self::Internal => ("POLICYSQL_INTERNAL", "The request could not be completed."),
            Self::OutcomeUnknown => (
                "POLICYSQL_COMMIT_OUTCOME_UNKNOWN",
                "The commit outcome is unknown.",
            ),
            Self::TransactionLimit => (
                "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED",
                "The transaction limit was exceeded.",
            ),
            Self::ModeViolation => (
                "POLICYSQL_TRANSACTION_MODE_VIOLATION",
                "A read transaction cannot execute a mutation.",
            ),
            Self::CheckRejected => (
                "POLICYSQL_COMMIT_CHECK_REJECTED",
                "A commit check rejected the transaction.",
            ),
            Self::Stale => (
                "POLICYSQL_STALE_OPERATION",
                "The operation was compiled for a different active snapshot.",
            ),
            Self::BindingRejected => (
                "POLICYSQL_DATABASE_BINDING_REJECTED",
                "The database binding is not permitted.",
            ),
            Self::DatabaseTimeout => (
                "POLICYSQL_DATABASE_TIMEOUT",
                "The database operation timed out.",
            ),
            Self::DatabaseUnavailable => (
                "POLICYSQL_DATABASE_UNAVAILABLE",
                "The database is temporarily unavailable.",
            ),
            Self::SchemaMismatch => (
                "POLICYSQL_SCHEMA_MISMATCH",
                "The database result does not match the compiled logical contract.",
            ),
            Self::LimitExceeded => (
                "POLICYSQL_LIMIT_EXCEEDED",
                "The request or result exceeded a configured limit.",
            ),
            Self::IdempotencyConflict => (
                "POLICYSQL_IDEMPOTENCY_CONFLICT",
                "The idempotency key is already bound to a different request.",
            ),
            Self::KeyInvalid => (
                "POLICYSQL_IDEMPOTENCY_KEY_INVALID",
                "Idempotency-Key must be 16-128 characters from letters, digits, and . _ : - + / = when provided.",
            ),
            Self::Timeout => ("POLICYSQL_TIMEOUT", "The database operation timed out."),
            Self::SqlTooComplex => (
                "POLICYSQL_SQL_TOO_COMPLEX",
                "The statement is too complex to run under the active policy.",
            ),
            Self::ConstraintViolation => (
                "POLICYSQL_CONSTRAINT_VIOLATION",
                "The statement violates a database constraint.",
            ),
            Self::JsonTooDeep => (
                "POLICYSQL_JSON_TOO_DEEP",
                "The request JSON nests too deeply.",
            ),
        }
    }

    /// The code an adapter class maps to for a database or provider failure (as today:
    /// `turso.ts` `remoteFailure` and `database.ts`).
    #[must_use]
    pub const fn for_class(class: Class) -> Self {
        match class {
            Class::Timeout => Self::DatabaseTimeout,
            Class::Unavailable => Self::DatabaseUnavailable,
            Class::Rejected => Self::BindingRejected,
            // A constraint class on any event but a statement's `executeFailed` is an adapter
            // bug, so the outcome is unknown (ADR 0030).
            Class::NotCommitted | Class::Unknown | Class::Constraint => Self::Internal,
            Class::Limit => Self::LimitExceeded,
            Class::Complex => Self::SqlTooComplex,
        }
    }

    /// The code for a failed statement execution: the only place a constraint violation is a
    /// definite refusal (ADR 0030). Every other class maps as [`Code::for_class`] does.
    #[must_use]
    pub const fn for_execute(class: Class) -> Self {
        match class {
            Class::Constraint => Self::ConstraintViolation,
            other => Self::for_class(other),
        }
    }
}

/// `error.detail`: values fixed per code, enumerations and numbers only (ADR 0030). A later
/// change adds a field and a row to [`ErrorDetail::allowed`].
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorDetail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraint: Option<ConstraintKind>,
}

impl ErrorDetail {
    /// Whether `detail` is what `code` allows. A code in the table requires its detail; a code
    /// outside the table has none.
    #[must_use]
    pub fn allowed(code: &str, detail: Option<&serde_json::Value>) -> bool {
        match code {
            // A struct also reads from a JSON array, so the shape is checked first.
            "POLICYSQL_CONSTRAINT_VIOLATION" => detail
                .filter(|value| value.is_object())
                .and_then(|value| Self::deserialize(value).ok())
                .is_some_and(|detail| detail.constraint.is_some()),
            _ => detail.is_none(),
        }
    }
}

#[derive(Serialize)]
struct ErrorReply<'a> {
    ok: bool,
    error: ErrorBody<'a>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a ErrorDetail>,
}

#[derive(Serialize)]
struct ValueReply<'a> {
    ok: bool,
    value: &'a RawValue,
}

pub(crate) fn raw(text: String) -> Box<RawValue> {
    RawValue::from_string(text).unwrap_or_else(|_| null_raw())
}

pub(crate) fn null_raw() -> Box<RawValue> {
    // `null` is valid JSON, so this never falls back further.
    RawValue::from_string("null".to_owned()).unwrap_or_else(|_| Box::default())
}

pub(crate) fn to_raw(value: &impl Serialize) -> Box<RawValue> {
    serde_json::to_string(value).map_or_else(|_| null_raw(), raw)
}

/// `{"ok":false,"error":{…}}` for one of the machine's own codes.
#[must_use]
pub fn error_reply(code: Code) -> Box<RawValue> {
    let (code, message) = code.parts();
    to_raw(&ErrorReply {
        ok: false,
        error: ErrorBody {
            code,
            message,
            path: None,
            detail: None,
        },
    })
}

/// `{"ok":false,"error":{…}}` for one of the machine's own codes, pointing at statement
/// `index` of the request.
#[must_use]
pub fn error_reply_at(code: Code, index: u64) -> Box<RawValue> {
    let (code, message) = code.parts();
    let path = format!("/statements/{index}");
    to_raw(&ErrorReply {
        ok: false,
        error: ErrorBody {
            code,
            message,
            path: Some(&path),
            detail: None,
        },
    })
}

/// 409 `POLICYSQL_CONSTRAINT_VIOLATION` at `/statements/{index}`, with the fixed message and
/// `detail` of the kind (ADR 0030).
#[must_use]
pub fn constraint_reply(kind: ConstraintKind, index: u64) -> Box<RawValue> {
    let (code, _) = Code::ConstraintViolation.parts();
    let path = format!("/statements/{index}");
    to_raw(&ErrorReply {
        ok: false,
        error: ErrorBody {
            code,
            message: kind.message(),
            path: Some(&path),
            detail: Some(&ErrorDetail {
                constraint: Some(kind),
            }),
        },
    })
}

/// `{"ok":false,"error":{…}}` for a compiler error.
#[must_use]
pub fn core_error_reply(error: &super::compiler::CoreError) -> Box<RawValue> {
    to_raw(&ErrorReply {
        ok: false,
        error: ErrorBody {
            code: &error.code,
            message: &error.message,
            path: error.path.as_deref(),
            detail: None,
        },
    })
}

/// `{"ok":true,"value":…}`.
#[must_use]
pub fn value_reply(value: &RawValue) -> Box<RawValue> {
    to_raw(&ValueReply { ok: true, value })
}

#[cfg(test)]
mod tests {
    use super::{Class, Code, ConstraintKind, ErrorDetail, constraint_reply};
    use serde_json::{Value, json};

    #[test]
    fn a_kind_is_named_by_the_adapter_and_anything_else_is_other() {
        for (name, kind) in [
            ("unique", ConstraintKind::Unique),
            ("not_null", ConstraintKind::NotNull),
            ("foreign_key", ConstraintKind::ForeignKey),
            ("check", ConstraintKind::Check),
            ("other", ConstraintKind::Other),
        ] {
            assert_eq!(ConstraintKind::from_name(Some(name)), kind);
            assert_eq!(kind.name(), name);
            assert!(kind.message().starts_with("The statement violates a"));
        }
        for name in ["", "UNIQUE", "primary_key", "unique ", "notnull"] {
            assert_eq!(ConstraintKind::from_name(Some(name)), ConstraintKind::Other);
        }
        assert_eq!(ConstraintKind::from_name(None), ConstraintKind::Other);
        assert_eq!(
            Code::ConstraintViolation.parts().1,
            ConstraintKind::Other.message(),
            "the code's own message is the `other` one"
        );
    }

    #[test]
    fn only_an_execute_failure_maps_a_constraint_to_the_conflict_code() {
        assert_eq!(
            Code::for_execute(Class::Constraint),
            Code::ConstraintViolation
        );
        assert_eq!(Code::for_class(Class::Constraint), Code::Internal);
        for class in [
            Class::Timeout,
            Class::Unavailable,
            Class::Rejected,
            Class::NotCommitted,
            Class::Unknown,
            Class::Limit,
            Class::Complex,
        ] {
            assert_eq!(Code::for_execute(class), Code::for_class(class));
        }
    }

    #[test]
    fn the_detail_table_has_one_row_and_every_other_code_has_no_detail() {
        let allowed =
            |code: &str, detail: Option<Value>| ErrorDetail::allowed(code, detail.as_ref());
        let violation = "POLICYSQL_CONSTRAINT_VIOLATION";
        for kind in ["unique", "not_null", "foreign_key", "check", "other"] {
            assert!(
                allowed(violation, Some(json!({"constraint": kind}))),
                "{kind}"
            );
        }
        for detail in [
            None,
            Some(json!({})),
            Some(json!({"constraint": "unique", "column": "x"})),
            Some(json!({"constraint": "primary_key"})),
            Some(json!({"constraint": null})),
            Some(json!({"constraint": 1})),
            Some(json!(["unique"])),
            Some(json!("unique")),
            Some(json!(1)),
            Some(Value::Null),
        ] {
            assert!(!allowed(violation, detail.clone()), "{detail:?}");
        }
        for code in ["POLICYSQL_FORBIDDEN_COLUMN", "POLICYSQL_INTERNAL"] {
            assert!(allowed(code, None), "{code}");
            for detail in [
                json!({}),
                json!({"constraint": "unique"}),
                json!([]),
                Value::Null,
            ] {
                assert!(!allowed(code, Some(detail.clone())), "{code} {detail}");
            }
        }
    }

    #[test]
    fn the_conflict_reply_has_the_fixed_shape() {
        let reply: Value = serde_json::from_str(constraint_reply(ConstraintKind::Check, 3).get())
            .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert_eq!(
            reply,
            json!({"ok": false, "error": {
                "code": "POLICYSQL_CONSTRAINT_VIOLATION",
                "message": "The statement violates a CHECK constraint.",
                "path": "/statements/3",
                "detail": {"constraint": "check"},
            }})
        );
    }
}
