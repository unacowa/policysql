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
    /// The owner running this step; `None` in the engine (the `request` kind, pull request 7).
    pub owner: Option<String>,
    /// Check ids with an endpoint in `PolicySqlConfig` (commit checks run in pull request 5).
    #[serde(default)]
    pub configured_checks: Vec<String>,
}

/// The request id syntax of ADR 0023 (`REQUEST_ID` in `engine.ts`).
#[must_use]
pub fn valid_request_id(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

impl HostFacts {
    /// Host facts the machine can run with: an owner step (pull request 4 implements no
    /// engine-side `request` kind), a time JavaScript holds exactly, 32 bytes of entropy.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        self.now_ms <= super::MAX_TIME_MS
            && super::state::hex64(&self.entropy)
            && valid_request_id(&self.request_id)
            && self.owner.as_deref().is_some_and(super::state::owner_name)
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
}

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
            | Self::TimerFailed { id } => Some(*id),
            Self::Forwarded { .. } | Self::TimerFired | Self::Abandon => None,
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
            Self::Forwarded { .. } | Self::TimerFired | Self::Abandon => None,
        }
    }
}

/// A statement as the database port takes it.
#[derive(Clone, Debug, Serialize)]
pub struct DriverCall {
    pub sql: String,
    pub args: BTreeMap<String, serde_json::Value>,
}

/// The context `Observe` carries to the background cost observation.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserveContext {
    pub operation: &'static str,
    pub resource: Option<String>,
}

/// One effect. Awaited effects carry an id that their outcome event repeats; a batch holds any
/// number of immediate effects followed by at most one awaited effect.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Effect {
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
    Execute {
        id: u64,
        statements: Vec<DriverCall>,
        trace: Option<()>,
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
    Respond {
        lane: &'static str,
        reply: Box<RawValue>,
    },
    Observe {
        statements: Vec<DriverCall>,
        context: ObserveContext,
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
            Self::Open { id, .. }
            | Self::CheckBinding { id, .. }
            | Self::Execute { id, .. }
            | Self::Commit { id }
            | Self::Rollback { id }
            | Self::SetTimer { id, .. }
            | Self::Persist { id } => Some(*id),
            Self::Respond { .. } | Self::Observe { .. } | Self::Log { .. } | Self::Reset => None,
        }
    }

    #[must_use]
    pub const fn is_awaited(&self) -> bool {
        matches!(
            self,
            Self::Open { .. }
                | Self::CheckBinding { .. }
                | Self::Execute { .. }
                | Self::Commit { .. }
                | Self::Rollback { .. }
                | Self::SetTimer { .. }
                | Self::Persist { .. }
        )
    }
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
            Class::NotCommitted | Class::Unknown => Self::Internal,
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
        },
    })
}

/// `{"ok":true,"value":…}`.
#[must_use]
pub fn value_reply(value: &RawValue) -> Box<RawValue> {
    to_raw(&ValueReply { ok: true, value })
}
