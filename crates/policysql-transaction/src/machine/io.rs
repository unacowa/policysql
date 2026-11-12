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
    /// The commit outcome is unknown (503 `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`). Not
    /// [`Code::KeyedOutcomeUnknown`].
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
    /// A keyed atomic execute was refused before the database was read (a compile, the session
    /// gate, or a body limit), so the outcome of an earlier request with the same key is unknown
    /// (500 `POLICYSQL_OUTCOME_UNKNOWN`, ADR 0007 #85 and ADR 0030). The refusal is
    /// `detail.cause`. Not [`Code::OutcomeUnknown`], the commit outcome.
    KeyedOutcomeUnknown,
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
            Self::KeyedOutcomeUnknown => (
                "POLICYSQL_OUTCOME_UNKNOWN",
                "This request was not executed. The outcome of an earlier request with the same Idempotency-Key is unknown.",
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

/// The codes a keyed atomic execute refused before the database was read can carry as
/// `detail.cause.code` (ADR 0030 amendment): every code a compile returns, the session gate's
/// and the body limits'. A code that depends on the database's state is never in this list.
pub const OUTCOME_CAUSE_CODES: [&str; 22] = [
    "POLICYSQL_FORBIDDEN_ACCESS",
    "POLICYSQL_STALE_OPERATION",
    "POLICYSQL_INVALID_REQUEST",
    "POLICYSQL_REQUEST_TOO_LARGE",
    "POLICYSQL_JSON_TOO_DEEP",
    "POLICYSQL_INVALID_SQL",
    "POLICYSQL_MULTIPLE_STATEMENTS",
    "POLICYSQL_UNSUPPORTED_SQL",
    "POLICYSQL_MISSING_POLICY",
    "POLICYSQL_FORBIDDEN_OPERATION",
    "POLICYSQL_FORBIDDEN_COLUMN",
    "POLICYSQL_FORBIDDEN_COLUMN_CONTEXT",
    "POLICYSQL_DUPLICATE_RESULT_COLUMN",
    "POLICYSQL_INVALID_PARAMETER",
    "POLICYSQL_AMBIGUOUS_PARAMETER_TYPE",
    "POLICYSQL_RESERVED_PARAMETER",
    "POLICYSQL_PRESET_COLUMN",
    "POLICYSQL_LIMIT_EXCEEDED",
    "POLICYSQL_EXPECTATION_FAILED",
    "POLICYSQL_SQL_TOO_COMPLEX",
    "POLICYSQL_INTERNAL",
    "POLICYSQL_DATABASE_UNAVAILABLE",
];

/// The values `error.detail.feature` may take (ADR 0030, amendment for #145 pull request C).
/// The rows of `policysql_parser::UnsupportedFeature`, which a test keeps in step.
pub const UNSUPPORTED_FEATURES: [&str; 33] = [
    "explain",
    "statement",
    "constant_select",
    "star",
    "json_collection",
    "delete",
    "update",
    "insert",
    "insert_select",
    "compound_select",
    "values",
    "distinct",
    "window_clause",
    "group_by",
    "nulls_ordering",
    "cte",
    "derived_table",
    "table_source",
    "database_qualifier",
    "indexed_by",
    "join",
    "self_join",
    "window_function",
    "subquery",
    "expression",
    "cast",
    "function",
    "literal",
    "missing_from",
    "duplicate_alias",
    "duplicate_write_column",
    "insert_arity",
    "protected_statement",
];

/// The values `error.detail.reason` may take (`INVALID_PARAMETER`).
pub const PARAMETER_REASONS: [&str; 8] = [
    "positional",
    "prefix",
    "name",
    "type",
    "null",
    "literal",
    "value",
    "names",
];

/// The values `error.detail.complexity` may take (`SQL_TOO_COMPLEX`): the causes of a compile
/// and of the database's own refusal, and `database` when the adapter named none.
pub const COMPLEXITY_DETAILS: [&str; 11] = [
    "height",
    "recursion",
    "columns",
    "parameters",
    "like_pattern",
    "column_metadata",
    "database_expression_depth",
    "function_arguments",
    "compound_terms",
    "join_tables",
    "database",
];

/// The values `error.detail.expectation` may take (`EXPECTATION_FAILED`).
pub const EXPECTATIONS: [&str; 2] = ["affectedRows", "rowCount"];

/// The largest `error.detail.span` offset: the ceiling of a statement's byte length
/// (`MAX_SQL_BYTES_CEILING`).
pub const MAX_SPAN_OFFSET: u64 = 1_048_576;

/// Whether `path` is one a `detail.cause.path` may take: `/statements/<n>` or
/// `/statements/<n>/sql`, with `<n>` a canonical decimal of 1 to 10 digits.
#[must_use]
pub fn is_cause_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/statements/") else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let (number, tail) = rest.split_at(digits);
    let canonical = match number.as_bytes() {
        [b'0'] => true,
        [b'1'..=b'9', ..] => number.len() <= 10,
        _ => false,
    };
    canonical && (tail.is_empty() || tail == "/sql")
}

/// `error.detail`: values fixed per code, enumerations, numbers, and fixed-form pointers only
/// (ADR 0030). A later change adds a field and a row to [`ErrorDetail::allowed`].
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorDetail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraint: Option<ConstraintKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<OutcomeCause>,
    /// `UNSUPPORTED_SQL`: the construct, from [`UNSUPPORTED_FEATURES`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
    /// `INVALID_SQL`: the offending token in the statement's UTF-8 bytes, `[start, end)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    /// `INVALID_PARAMETER`: from [`PARAMETER_REASONS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `SQL_TOO_COMPLEX`: from [`COMPLEXITY_DETAILS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complexity: Option<String>,
    /// `EXPECTATION_FAILED`: from [`EXPECTATIONS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expectation: Option<String>,
}

/// A half-open range of UTF-8 byte offsets into a statement's SQL text.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

/// The refusal behind a keyed `POLICYSQL_OUTCOME_UNKNOWN`: the code, path and detail the same
/// request would have been answered with had it carried no key.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutcomeCause {
    pub code: String,
    /// Always serialized; `null` when the cause has no path.
    pub path: Option<String>,
    /// Always serialized; `null` when the cause's code has no detail.
    #[serde(default)]
    pub detail: Option<Box<ErrorDetail>>,
}

impl ErrorDetail {
    /// A detail naming only `feature`.
    #[must_use]
    pub fn feature(name: &str) -> Self {
        Self {
            feature: Some(name.to_owned()),
            ..Self::default()
        }
    }

    /// A detail naming only `reason`.
    #[must_use]
    pub fn reason(name: &str) -> Self {
        Self {
            reason: Some(name.to_owned()),
            ..Self::default()
        }
    }

    /// A detail naming only `complexity`.
    #[must_use]
    pub fn complexity(name: &str) -> Self {
        Self {
            complexity: Some(name.to_owned()),
            ..Self::default()
        }
    }

    /// A detail naming only `expectation`.
    #[must_use]
    pub fn expectation(name: &str) -> Self {
        Self {
            expectation: Some(name.to_owned()),
            ..Self::default()
        }
    }

    /// A detail holding only `span`.
    #[must_use]
    pub fn span(start: u64, end: u64) -> Self {
        Self {
            span: Some(Span { start, end }),
            ..Self::default()
        }
    }

    /// Whether `detail` is what `code` allows. A code in the table requires its detail, except
    /// `POLICYSQL_INVALID_SQL`, whose `span` is absent when the parser reported no position; a
    /// code outside the table has none. The value is read as JSON: serde takes a missing or
    /// `null` `Option` field as `None` and reads a struct from an array.
    #[must_use]
    pub fn allowed(code: &str, detail: Option<&serde_json::Value>) -> bool {
        match code {
            "POLICYSQL_CONSTRAINT_VIOLATION" => detail
                .filter(|value| value.as_object().is_some_and(|fields| fields.len() == 1))
                .and_then(|value| Self::deserialize(value).ok())
                .is_some_and(|detail| detail.constraint.is_some() && detail.cause.is_none()),
            "POLICYSQL_OUTCOME_UNKNOWN" => detail.is_some_and(Self::outcome_cause_allowed),
            "POLICYSQL_INVALID_SQL" => detail.is_none_or(Self::span_allowed),
            "POLICYSQL_UNSUPPORTED_SQL" => detail
                .is_some_and(|value| Self::enumerated(value, "feature", &UNSUPPORTED_FEATURES)),
            "POLICYSQL_INVALID_PARAMETER" => {
                detail.is_some_and(|value| Self::enumerated(value, "reason", &PARAMETER_REASONS))
            }
            "POLICYSQL_SQL_TOO_COMPLEX" => detail
                .is_some_and(|value| Self::enumerated(value, "complexity", &COMPLEXITY_DETAILS)),
            "POLICYSQL_EXPECTATION_FAILED" => {
                detail.is_some_and(|value| Self::enumerated(value, "expectation", &EXPECTATIONS))
            }
            _ => detail.is_none(),
        }
    }

    /// Exactly one key, `key`, whose value is one of `values`.
    fn enumerated(detail: &serde_json::Value, key: &str, values: &[&str]) -> bool {
        detail
            .as_object()
            .filter(|fields| fields.len() == 1)
            .and_then(|fields| fields.get(key))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| values.contains(&value))
    }

    /// Exactly `{"span":{"start":s,"end":e}}` with `s <= e <= MAX_SPAN_OFFSET`.
    fn span_allowed(detail: &serde_json::Value) -> bool {
        let Some(span) = detail
            .as_object()
            .filter(|fields| fields.len() == 1)
            .and_then(|fields| fields.get("span"))
            .and_then(serde_json::Value::as_object)
            .filter(|span| span.len() == 2)
        else {
            return false;
        };
        let (Some(start), Some(end)) = (
            span.get("start").and_then(serde_json::Value::as_u64),
            span.get("end").and_then(serde_json::Value::as_u64),
        ) else {
            return false;
        };
        start <= end && end <= MAX_SPAN_OFFSET
    }

    fn outcome_cause_allowed(detail: &serde_json::Value) -> bool {
        let Some(detail) = detail.as_object() else {
            return false;
        };
        let Some(cause) = detail
            .get("cause")
            .and_then(serde_json::Value::as_object)
            .filter(|_| detail.len() == 1)
        else {
            return false;
        };
        let Some(code) = cause
            .get("code")
            .and_then(serde_json::Value::as_str)
            .filter(|code| OUTCOME_CAUSE_CODES.contains(code))
        else {
            return false;
        };
        let path_allowed = match cause.get("path") {
            Some(serde_json::Value::Null) => true,
            Some(serde_json::Value::String(path)) => is_cause_path(path),
            _ => false,
        };
        // `OUTCOME_UNKNOWN` is not a cause code, so the nested check cannot recurse further.
        let detail_allowed = match cause.get("detail") {
            Some(serde_json::Value::Null) => Self::allowed(code, None),
            Some(value @ serde_json::Value::Object(_)) => Self::allowed(code, Some(value)),
            _ => false,
        };
        cause.len() == 3 && path_allowed && detail_allowed
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
/// `index` of the request and carrying the code's `detail` (ADR 0030).
#[must_use]
pub fn error_reply_at_with(code: Code, index: u64, detail: &ErrorDetail) -> Box<RawValue> {
    let (code, message) = code.parts();
    let path = format!("/statements/{index}");
    to_raw(&ErrorReply {
        ok: false,
        error: ErrorBody {
            code,
            message,
            path: Some(&path),
            detail: Some(detail),
        },
    })
}

/// The reply for a failure `class` outside a statement's execution (a binding check, an
/// idempotency lookup). A complexity class is answered like the statement's own, with the
/// `database` complexity and no path, so the code never appears without its required detail.
#[must_use]
pub fn class_reply(class: Class) -> Box<RawValue> {
    let code = Code::for_class(class);
    if code != Code::SqlTooComplex {
        return error_reply(code);
    }
    let (code, message) = code.parts();
    to_raw(&ErrorReply {
        ok: false,
        error: ErrorBody {
            code,
            message,
            path: None,
            detail: Some(&ErrorDetail::complexity("database")),
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
                ..ErrorDetail::default()
            }),
        },
    })
}

/// 500 `POLICYSQL_OUTCOME_UNKNOWN` for a keyed atomic execute refused by a compile: the fixed
/// message, no top-level path, and the compile's code and path as `detail.cause`. The cause is
/// not checked here: a reader (the engine's `checkedOwnerReply`, a machine's `owner_replied`)
/// rejects a code outside [`OUTCOME_CAUSE_CODES`].
#[must_use]
pub fn outcome_unknown_reply(cause: &super::compiler::CoreError) -> Box<RawValue> {
    let (code, message) = Code::KeyedOutcomeUnknown.parts();
    to_raw(&ErrorReply {
        ok: false,
        error: ErrorBody {
            code,
            message,
            path: None,
            detail: Some(&ErrorDetail {
                cause: Some(OutcomeCause {
                    code: cause.code.clone(),
                    path: cause.path.clone(),
                    detail: cause.detail.clone(),
                }),
                ..ErrorDetail::default()
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
            detail: error.detail.as_deref(),
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
    use super::{
        COMPLEXITY_CAUSES, COMPLEXITY_DETAILS, Class, Code, ConstraintKind, EXPECTATIONS,
        ErrorDetail, OUTCOME_CAUSE_CODES, PARAMETER_REASONS, UNSUPPORTED_FEATURES, class_reply,
        constraint_reply, core_error_reply, error_reply_at_with, is_cause_path,
        outcome_unknown_reply,
    };
    use crate::machine::compiler::CoreError;
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
    fn the_constraint_row_requires_its_detail_and_other_codes_without_a_row_have_none() {
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
            Some(json!({"constraint": "unique", "cause": null})),
            Some(json!({"constraint": "unique", "constraint2": null})),
            Some(json!({"cause": null})),
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

    #[test]
    fn the_keyed_outcome_unknown_code_is_not_the_commit_outcome() {
        assert_eq!(
            Code::KeyedOutcomeUnknown.parts(),
            (
                "POLICYSQL_OUTCOME_UNKNOWN",
                "This request was not executed. The outcome of an earlier request with the same \
                 Idempotency-Key is unknown."
            )
        );
        assert_eq!(
            Code::OutcomeUnknown.parts().0,
            "POLICYSQL_COMMIT_OUTCOME_UNKNOWN"
        );
    }

    #[test]
    fn the_outcome_unknown_reply_has_the_fixed_shape_and_always_writes_the_path() {
        let mut cause = CoreError::new("POLICYSQL_MISSING_POLICY", "ignored message");
        cause.path = Some("/statements/2".to_owned());
        let reply = outcome_unknown_reply(&cause);
        assert!(
            reply.get().starts_with(
                "{\"ok\":false,\"error\":{\"code\":\"POLICYSQL_OUTCOME_UNKNOWN\",\"message\":"
            ),
            "{}",
            reply.get()
        );
        let parsed: Value = serde_json::from_str(reply.get())
            .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert_eq!(
            parsed,
            json!({"ok": false, "error": {
                "code": "POLICYSQL_OUTCOME_UNKNOWN",
                "message": Code::KeyedOutcomeUnknown.parts().1,
                "path": null,
                "detail": {"cause": {
                    "code": "POLICYSQL_MISSING_POLICY",
                    "path": "/statements/2",
                    "detail": null,
                }},
            }})
        );
        let pathless = CoreError::new("POLICYSQL_FORBIDDEN_ACCESS", "ignored message");
        let reply = outcome_unknown_reply(&pathless);
        let parsed: Value = serde_json::from_str(reply.get())
            .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert_eq!(
            parsed["error"]["detail"],
            json!({"cause": {"code": "POLICYSQL_FORBIDDEN_ACCESS", "path": null, "detail": null}}),
            "a null path and a null detail are written, not omitted"
        );
        let mut detailed = CoreError::new("POLICYSQL_UNSUPPORTED_SQL", "ignored message");
        detailed.path = Some("/statements/0".to_owned());
        detailed.detail = Some(Box::new(ErrorDetail::feature("star")));
        let reply = outcome_unknown_reply(&detailed);
        let parsed: Value = serde_json::from_str(reply.get())
            .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert_eq!(
            parsed["error"]["detail"],
            json!({"cause": {
                "code": "POLICYSQL_UNSUPPORTED_SQL",
                "path": "/statements/0",
                "detail": {"feature": "star"},
            }})
        );
        assert!(ErrorDetail::allowed(
            "POLICYSQL_OUTCOME_UNKNOWN",
            parsed["error"].get("detail")
        ));
        assert!(ErrorDetail::allowed(
            "POLICYSQL_OUTCOME_UNKNOWN",
            parsed["error"].get("detail")
        ));
    }

    #[test]
    fn the_outcome_unknown_detail_table_accepts_only_a_fixed_cause() {
        let allowed =
            |detail: Value| ErrorDetail::allowed("POLICYSQL_OUTCOME_UNKNOWN", Some(&detail));
        // A cause code whose own row requires a detail cannot carry `null`.
        let requires_detail = |code: &str| {
            [
                "POLICYSQL_UNSUPPORTED_SQL",
                "POLICYSQL_INVALID_PARAMETER",
                "POLICYSQL_SQL_TOO_COMPLEX",
                "POLICYSQL_EXPECTATION_FAILED",
            ]
            .contains(&code)
        };
        for code in OUTCOME_CAUSE_CODES {
            for path in [
                Value::Null,
                json!("/statements/0"),
                json!("/statements/12/sql"),
                json!("/statements/9999999999"),
            ] {
                assert!(
                    allowed(json!({"cause": {"code": code, "path": path, "detail": null}}))
                        != requires_detail(code),
                    "{code} {path}"
                );
            }
        }
        assert_eq!(OUTCOME_CAUSE_CODES.len(), 22);
        let good = "POLICYSQL_INVALID_SQL";
        assert!(!ErrorDetail::allowed("POLICYSQL_OUTCOME_UNKNOWN", None));
        let mut forged = vec![
            json!({}),
            json!({"cause": null}),
            json!({"cause": []}),
            json!({"cause": "x"}),
            json!([{"code": good, "path": null, "detail": null}]),
            json!({"cause": {"code": good, "path": null, "detail": null}, "constraint": "unique"}),
            json!({"cause": {"code": good, "path": null, "detail": null, "message": "x"}}),
            // The two-key form of the earlier amendment is no longer accepted.
            json!({"cause": {"code": good, "path": null}}),
            json!({"cause": {"code": good, "detail": null}}),
            json!({"cause": {"code": good}}),
            json!({"cause": {"path": null}}),
            json!({"cause": [good, null]}),
            Value::Null,
        ];
        for code in [
            json!("POLICYSQL_CONSTRAINT_VIOLATION"),
            json!("POLICYSQL_CHECK_FAILED"),
            json!("POLICYSQL_SCHEMA_MISMATCH"),
            json!("POLICYSQL_DATABASE_TIMEOUT"),
            json!("POLICYSQL_OUTCOME_UNKNOWN"),
            json!("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"),
            json!("FORBIDDEN_COLUMN"),
            json!("policysql_invalid_sql"),
            json!(1),
            Value::Null,
        ] {
            forged.push(json!({"cause": {"code": code, "path": null, "detail": null}}));
        }
        for path in [
            json!("/statements/01"),
            json!("/statements/-1"),
            json!("/statements/"),
            json!("/statements/0/params"),
            json!("/statements/0/sql/x"),
            json!("/x"),
            json!(""),
            json!("/statements/12345678901"),
            json!(0),
        ] {
            forged.push(json!({"cause": {"code": good, "path": path, "detail": null}}));
        }
        for detail in forged {
            assert!(!allowed(detail.clone()), "{detail}");
        }
        // A cause is not a constraint's, and no other code takes one.
        let cause = json!({"cause": {"code": good, "path": null, "detail": null}});
        assert!(!ErrorDetail::allowed("POLICYSQL_INVALID_SQL", Some(&cause)));
        assert!(!ErrorDetail::allowed(
            "POLICYSQL_CONSTRAINT_VIOLATION",
            Some(
                &json!({"constraint": "unique", "cause": {"code": good, "path": null, "detail": null}})
            )
        ));
    }

    #[test]
    fn a_cause_path_is_a_statement_pointer_with_a_canonical_index() {
        for path in [
            "/statements/0",
            "/statements/10/sql",
            "/statements/1234567890",
        ] {
            assert!(is_cause_path(path), "{path}");
        }
        for path in [
            "",
            "/statements/",
            "/statements/00",
            "/statements/+1",
            "/statements/1/sql/",
            "/statements/1/SQL",
            "statements/1",
            "/statements/12345678901",
        ] {
            assert!(!is_cause_path(path), "{path}");
        }
    }

    /// The table shared with the Worker (`deploy/cloudflare/test/error-detail.test.mjs`).
    #[test]
    fn the_shared_fixture_is_judged_as_the_worker_judges_it() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/error-detail-cases.json"
        ))
        .unwrap_or_else(|error| unreachable!("the fixture is JSON: {error}"));
        assert!(cases.len() > 200);
        for case in cases {
            let code = case["code"].as_str().unwrap_or_default();
            let valid = case["valid"].as_bool().unwrap_or_default();
            assert_eq!(
                ErrorDetail::allowed(code, case.get("detail")),
                valid,
                "{case}"
            );
        }
    }

    #[test]
    fn the_enumerations_are_unique_and_the_complexity_values_cover_the_causes() {
        for values in [
            UNSUPPORTED_FEATURES.as_slice(),
            PARAMETER_REASONS.as_slice(),
            COMPLEXITY_DETAILS.as_slice(),
            EXPECTATIONS.as_slice(),
        ] {
            let unique: std::collections::BTreeSet<_> = values.iter().collect();
            assert_eq!(unique.len(), values.len());
        }
        assert_eq!(UNSUPPORTED_FEATURES.len(), 33);
        for cause in COMPLEXITY_CAUSES {
            assert!(COMPLEXITY_DETAILS.contains(&cause), "{cause}");
        }
        assert!(COMPLEXITY_DETAILS.contains(&"database"));
    }

    #[test]
    fn a_compile_error_reply_carries_its_detail_and_nothing_else() {
        let mut error = CoreError::new("POLICYSQL_INVALID_SQL", "The SQL cannot be parsed.");
        error.path = Some("/statements/0".to_owned());
        error.detail = Some(Box::new(ErrorDetail::span(7, 11)));
        let parsed: Value = serde_json::from_str(core_error_reply(&error).get())
            .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert_eq!(
            parsed["error"]["detail"],
            json!({"span": {"start": 7, "end": 11}})
        );
        error.detail = None;
        let parsed: Value = serde_json::from_str(core_error_reply(&error).get())
            .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert!(parsed["error"].get("detail").is_none());
    }

    #[test]
    fn a_database_complexity_refusal_names_its_complexity() {
        let parsed: Value = serde_json::from_str(
            error_reply_at_with(
                Code::SqlTooComplex,
                2,
                &ErrorDetail::complexity("join_tables"),
            )
            .get(),
        )
        .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert_eq!(parsed["error"]["path"], "/statements/2");
        assert_eq!(
            parsed["error"]["detail"],
            json!({"complexity": "join_tables"})
        );
        // A complexity class outside a statement is answered with the `database` complexity.
        let parsed: Value = serde_json::from_str(class_reply(Class::Complex).get())
            .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert_eq!(parsed["error"]["code"], "POLICYSQL_SQL_TOO_COMPLEX");
        assert!(ErrorDetail::allowed(
            "POLICYSQL_SQL_TOO_COMPLEX",
            parsed["error"].get("detail")
        ));
        let parsed: Value = serde_json::from_str(class_reply(Class::Timeout).get())
            .unwrap_or_else(|error| unreachable!("a reply is JSON: {error}"));
        assert!(parsed["error"].get("detail").is_none());
    }
}
