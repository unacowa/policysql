//! What the machine needs from the policy compiler (ADR 0024, "Where the machine lives").
//!
//! `policysql-wasm` implements [`Compiler`] with the gateway and its execution-handle table;
//! property tests use a fake. Plans never leave the compiler: the machine holds only the
//! handle of a compiled statement, asks the compiler for the driver statements when it emits
//! `Execute`, validates the raw result against the handle, and releases it.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Select,
    Insert,
    Update,
    Delete,
}

impl Operation {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Select => "select",
            Self::Insert => "insert",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

/// A client-facing error: a stable code, a message safe for an untrusted client, and an
/// RFC 6901 pointer into the body (or none).
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CoreError {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

impl CoreError {
    #[must_use]
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
            path: None,
        }
    }
}

/// One compiled statement, as the machine sees it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatementSummary {
    pub operation: Operation,
    /// The logical resource name the statement acts on.
    pub resource: Option<String>,
}

/// A compiled envelope whose plan is held by the compiler under `handle`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Compiled {
    pub handle: u64,
    pub statements: Vec<StatementSummary>,
    pub schema_version: String,
    pub policy_version: String,
}

impl Compiled {
    /// Every statement is a SELECT (the envelope runs in a read transaction).
    #[must_use]
    pub fn read_only(&self) -> bool {
        self.statements
            .iter()
            .all(|statement| statement.operation == Operation::Select)
    }
}

/// A statement as the database port takes it. Parameter values are JSON; BLOBs are in the
/// private ABI form `{"type":"blob","base64":…}` that the engine's codec decodes.
#[derive(Clone, Debug, PartialEq)]
pub struct DriverStatement {
    pub sql: String,
    pub client_parameters: BTreeMap<String, serde_json::Value>,
    pub server_parameters: BTreeMap<String, serde_json::Value>,
    /// The cost observation statement (`EXPLAIN QUERY PLAN`), for `Observe`.
    pub cost_sql: String,
}

/// A raw database result in the private ABI shape `validate_result_json` takes.
#[derive(Clone, Debug, PartialEq)]
pub struct RawResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
}

/// A result that passed the compiled contract, with what the public result shape needs.
#[derive(Clone, Debug)]
pub struct Validated {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub redactions: Vec<Vec<bool>>,
    pub affected_rows: u64,
    /// The statement's public result columns (`name`, `type`, `representation`, ...), each as
    /// exact JSON text.
    pub result_columns: Vec<Box<RawValue>>,
    pub operation_check: bool,
}

/// The policy compiler. Every method is deterministic given the runtime's configuration and
/// the handles it holds.
pub trait Compiler {
    /// The runtime snapshot (`{profile}:{schema}:{policy}:abi-{N}`).
    fn snapshot(&self) -> &str;

    /// Compiles an envelope text for the canonical session `auth_json` with execute access
    /// and keeps its plan under a new handle.
    ///
    /// # Errors
    ///
    /// The compile's client-facing error, as `compile_json` reports it.
    fn compile(&self, auth_json: &str, envelope_json: &str) -> Result<Compiled, CoreError>;

    /// The driver statements of a live handle.
    ///
    /// # Errors
    ///
    /// `POLICYSQL_INTERNAL` for an unknown handle.
    fn statements(&self, handle: u64) -> Result<Vec<DriverStatement>, CoreError>;

    /// Validates a raw result of statement `index` against a live handle.
    ///
    /// # Errors
    ///
    /// The validation's client-facing error (`POLICYSQL_SCHEMA_MISMATCH`, ...).
    fn validate(&self, handle: u64, index: usize, raw: RawResult) -> Result<Validated, CoreError>;

    /// Releases a handle; releasing an unknown handle does nothing.
    fn release(&self, handle: u64);

    /// The commit checks that changed rows in `resources` trigger, by ascending id, with the
    /// role their callback queries run as and their validator timeout (policy data).
    fn triggered_checks(&self, resources: &[&str]) -> Vec<TriggeredCheck>;
}

/// A commit check that a commit triggers (ADR 0007): recomputed from the recorded mutations
/// and the runtime's policy on every commit, never stored durably.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggeredCheck {
    /// The policy check id; the validator endpoint is looked up by it in the configuration.
    pub id: String,
    /// The callback role; `None` runs callback queries as the commit's role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// The validator call timeout (`hook.timeout_ms`).
    pub timeout_ms: u64,
}
