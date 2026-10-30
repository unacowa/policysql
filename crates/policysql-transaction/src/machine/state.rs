//! Durable and volatile state (ADR 0024, "State"): shapes, bounds, version, and the
//! consistency rules that make a value readable.
//!
//! Durable state is what a successor owner must see; the engine writes it to the owner's store
//! only when a step emits `Persist`. Volatile state dies with the owner instance: the connection,
//! the pending effect, the live execution handles, and the operation in progress. Both cross the
//! ABI as JSON text that the engine keeps verbatim, so a recorded response keeps its exact bytes.

use super::compiler::{Operation, StatementLimits};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// `TX_STATE_VERSION`. Any other `v` makes a record unreadable (ADR 0024, "Versioning").
pub const TX_STATE_VERSION: u32 = 1;
/// Durable JSON fits a Durable Object value (128 KiB) with room for the key and framing.
pub const MAX_DURABLE_BYTES: usize = 96 * 1024;
/// Volatile JSON bound.
pub const MAX_VOLATILE_BYTES: usize = 256 * 1024;
/// Mutations kept per transaction: the most statements a runtime can allow (`RuntimeLimits`).
pub const MAX_MUTATIONS: usize = 256;
/// Longest resource name a durable record may hold.
pub const MAX_RESOURCE_NAME_BYTES: usize = 1024;
/// Bytes of a durable record besides the recorded response, the mutations, and the
/// deployment strings counted by [`durable_bound_holds`]: the owner, the three identity
/// hashes, the binding's scope, database id, and generation (at most 256 bytes each, ADR
/// 0014), the counters, and the JSON framing.
pub const DURABLE_FIXED_BYTES: usize = 2 * 1024;
/// Bytes of one recorded mutation besides its resource name.
pub const MUTATION_FIXED_BYTES: usize = 64;
/// Bytes of a recorded reply besides the statement result: transaction id, status, sequence
/// numbers, the request id (at most 128 bytes), and framing.
pub const REPLY_FIXED_BYTES: usize = 512;

/// Whether every durable record of a runtime stays within [`MAX_DURABLE_BYTES`] (ADR 0024,
/// "Bounds"), so that runtime construction can reject limits for which it would not.
///
/// `deployment_bytes` is the length of the snapshot (held twice: in the record and in its
/// binding) plus the schema and policy version strings; `longest_resource_name` the longest
/// catalog resource name a mutation can record. The recorded response is the last statement's
/// reply, whose result is bounded by `max_transaction_result_bytes`.
#[must_use]
pub fn durable_bound_holds(
    deployment_bytes: usize,
    max_transaction_statements: u64,
    max_transaction_result_bytes: u64,
    longest_resource_name: usize,
) -> bool {
    let (Ok(statements), Ok(result_bytes)) = (
        usize::try_from(max_transaction_statements),
        usize::try_from(max_transaction_result_bytes),
    ) else {
        return false;
    };
    statements <= MAX_MUTATIONS
        && longest_resource_name <= MAX_RESOURCE_NAME_BYTES
        && DURABLE_FIXED_BYTES
            .saturating_add(deployment_bytes)
            .saturating_add(REPLY_FIXED_BYTES)
            .saturating_add(result_bytes)
            .saturating_add(statements.saturating_mul(MUTATION_FIXED_BYTES + longest_resource_name))
            <= MAX_DURABLE_BYTES
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Active,
    Validating,
    Committing,
    Committed,
    RolledBack,
    Failed,
    Expired,
    CommitUnknown,
    Discarded,
}

impl Phase {
    /// The phases that carry an expiry (`expiresAtMs`).
    #[must_use]
    pub const fn has_deadline(self) -> bool {
        matches!(self, Self::Active | Self::Validating | Self::Committing)
    }

    /// Phases after which nothing of this transaction runs again.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        !self.has_deadline()
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Validating => "validating",
            Self::Committing => "committing",
            Self::Committed => "committed",
            Self::RolledBack => "rolled_back",
            Self::Failed => "failed",
            Self::Expired => "expired",
            Self::CommitUnknown => "commit_unknown",
            Self::Discarded => "discarded",
        }
    }
}

/// The machine kind of an owner's record: an interactive transaction (pull request 4) or an
/// atomic execution on its owner (pull request 6), whose record only serializes work and is
/// never used to answer a request (ADR 0024 "Atomic on the owner").
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Interactive,
    Atomic,
}

/// The ids of an atomic execution on its owner (ADR 0024 `AtomicIds`).
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtomicIds {
    /// `atomic_` and 24 (keyed) or 32 (unkeyed) hex digits.
    pub transaction_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_hash: Option<String>,
}

impl AtomicIds {
    #[must_use]
    pub fn is_valid(&self) -> bool {
        let id = self
            .transaction_id
            .strip_prefix("atomic_")
            .is_some_and(|hex| {
                matches!(hex.len(), 24 | 32)
                    && hex
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            });
        id && self.key_hash.as_deref().is_none_or(hex64)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Read,
    Write,
}

impl Mode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

/// Who started the transaction and how (no session values: ADR 0024 "No session in durable
/// state").
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    /// `identity_json` `auth`: principal, subject, role, session, and the full binding.
    pub auth_fingerprint: String,
    /// The same without the binding's snapshot, for exact retries across a deployment.
    pub replay: String,
    pub start_fingerprint: String,
    pub mode: Mode,
}

/// A database binding (ADR 0014), pinned at begin.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub version: u8,
    pub scope: String,
    pub database_id: String,
    pub generation: String,
    pub snapshot: String,
}

impl Binding {
    /// ADR 0014's shape: version 1 and four parts of 1-256 of `[A-Za-z0-9_.:-]`.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        self.version == 1
            && [
                &self.scope,
                &self.database_id,
                &self.generation,
                &self.snapshot,
            ]
            .into_iter()
            .all(|part| binding_part(part))
    }
}

fn binding_part(part: &str) -> bool {
    (1..=256).contains(&part.len())
        && part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

/// The last completed command: its digest and its reply value, kept as exact JSON text.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replay {
    pub digest: String,
    pub response: Box<RawValue>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub rows_read: u64,
    pub rows_written: u64,
    pub query_duration_ms: f64,
}

impl Usage {
    #[must_use]
    pub fn is_valid(&self) -> bool {
        self.query_duration_ms.is_finite()
            && self.query_duration_ms >= 0.0
            && self.rows_read <= super::MAX_SAFE_INTEGER
            && self.rows_written <= super::MAX_SAFE_INTEGER
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Counters {
    pub statements: u32,
    pub result_bytes: u64,
    pub usage: Usage,
}

/// A statement that changed at least one row: what commit needs to recompute its checks.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    pub index: u32,
    pub operation: Operation,
    pub resource: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Versions {
    pub schema: String,
    pub policy: String,
}

/// A readable durable record.
#[derive(Clone, Debug)]
pub enum Durable {
    /// What replaces an unreadable record (ADR 0024, "Fail-closed rules").
    Tombstone {
        owner: String,
    },
    Live(Box<Record>),
}

#[derive(Clone, Debug)]
pub struct Record {
    pub owner: String,
    pub kind: Kind,
    pub phase: Phase,
    pub identity: Identity,
    pub binding: Binding,
    pub snapshot: String,
    pub expires_at_ms: Option<u64>,
    pub next_sequence: u64,
    pub last: Option<Replay>,
    pub counters: Counters,
    pub mutations: Vec<Mutation>,
    pub versions: Option<Versions>,
    /// Present iff `kind` is `atomic`.
    pub atomic: Option<AtomicIds>,
}

/// The wire form: every field but `v`, `owner`, and `phase` is absent in a tombstone.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableWire {
    v: u32,
    owner: String,
    phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<Kind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<Identity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    binding: Option<Binding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last: Option<Replay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    counters: Option<Counters>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mutations: Option<Vec<Mutation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    versions: Option<Versions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    atomic: Option<AtomicIds>,
}

/// Why a durable record is unreadable (`tx_state_discarded.reason`; never a value).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unreadable {
    TooLarge,
    Malformed,
    Version,
    Owner,
    Inconsistent,
}

impl Unreadable {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TooLarge => "too_large",
            Self::Malformed => "malformed",
            Self::Version => "version",
            Self::Owner => "owner",
            Self::Inconsistent => "inconsistent",
        }
    }
}

pub(crate) fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn owner_name(value: &str) -> bool {
    value.strip_prefix("tx_").is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// Snapshot and catalog version strings: what `SnapshotId` and the runtime accept, bounded.
fn short_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
}

impl Durable {
    #[must_use]
    pub fn owner(&self) -> &str {
        match self {
            Self::Tombstone { owner } => owner,
            Self::Live(record) => &record.owner,
        }
    }

    #[must_use]
    pub fn phase(&self) -> Phase {
        match self {
            Self::Tombstone { .. } => Phase::Discarded,
            Self::Live(record) => record.phase,
        }
    }

    /// Reads durable JSON for the owner `owner`.
    ///
    /// # Errors
    ///
    /// Returns why the text is not a readable record of this version and owner.
    pub fn parse(text: &str, owner: &str) -> Result<Self, Unreadable> {
        if text.len() > MAX_DURABLE_BYTES {
            return Err(Unreadable::TooLarge);
        }
        // `v` first, so an old-format record is reported as such.
        let probe: serde_json::Value =
            serde_json::from_str(text).map_err(|_| Unreadable::Malformed)?;
        if probe.get("v").and_then(serde_json::Value::as_u64) != Some(u64::from(TX_STATE_VERSION)) {
            return Err(Unreadable::Version);
        }
        let wire: DurableWire = serde_json::from_str(text).map_err(|_| Unreadable::Malformed)?;
        if wire.owner != owner {
            return Err(Unreadable::Owner);
        }
        Self::from_wire(wire).ok_or(Unreadable::Inconsistent)
    }

    fn from_wire(wire: DurableWire) -> Option<Self> {
        if !owner_name(&wire.owner) {
            return None;
        }
        if wire.phase == Phase::Discarded {
            let empty = wire.kind.is_none()
                && wire.identity.is_none()
                && wire.binding.is_none()
                && wire.snapshot.is_none()
                && wire.expires_at_ms.is_none()
                && wire.next_sequence.is_none()
                && wire.last.is_none()
                && wire.counters.is_none()
                && wire.mutations.is_none()
                && wire.versions.is_none()
                && wire.atomic.is_none();
            return empty.then_some(Self::Tombstone { owner: wire.owner });
        }
        let record = Record {
            owner: wire.owner,
            kind: wire.kind?,
            phase: wire.phase,
            identity: wire.identity?,
            binding: wire.binding?,
            snapshot: wire.snapshot?,
            expires_at_ms: wire.expires_at_ms,
            next_sequence: wire.next_sequence?,
            last: wire.last,
            counters: wire.counters?,
            mutations: wire.mutations?,
            versions: wire.versions,
            atomic: wire.atomic,
        };
        record.is_consistent().then(|| Self::Live(Box::new(record)))
    }

    /// The JSON text of this record.
    #[must_use]
    pub fn to_json(&self) -> String {
        let wire = match self {
            Self::Tombstone { owner } => DurableWire {
                v: TX_STATE_VERSION,
                owner: owner.clone(),
                phase: Phase::Discarded,
                kind: None,
                identity: None,
                binding: None,
                snapshot: None,
                expires_at_ms: None,
                next_sequence: None,
                last: None,
                counters: None,
                mutations: None,
                versions: None,
                atomic: None,
            },
            Self::Live(record) => DurableWire {
                v: TX_STATE_VERSION,
                owner: record.owner.clone(),
                phase: record.phase,
                kind: Some(record.kind),
                identity: Some(record.identity.clone()),
                binding: Some(record.binding.clone()),
                snapshot: Some(record.snapshot.clone()),
                expires_at_ms: record.expires_at_ms,
                next_sequence: Some(record.next_sequence),
                last: record.last.clone(),
                counters: Some(record.counters),
                mutations: Some(record.mutations.clone()),
                versions: record.versions.clone(),
                atomic: record.atomic.clone(),
            },
        };
        // Every field is a string, an integer, a finite float, or exact JSON text, so
        // serialization cannot fail; an empty text would be rejected by the size check.
        serde_json::to_string(&wire).unwrap_or_default()
    }
}

impl Record {
    /// Internal consistency (ADR 0024 "Unreadable durable state"): what any record that core
    /// wrote satisfies.
    #[must_use]
    pub fn is_consistent(&self) -> bool {
        let identity = &self.identity;
        let hashes = hex64(&identity.auth_fingerprint)
            && hex64(&identity.replay)
            && hex64(&identity.start_fingerprint);
        let deadline = self.expires_at_ms.is_some() == self.phase.has_deadline()
            && self.expires_at_ms.is_none_or(|at| at <= super::MAX_TIME_MS);
        let sequence = self.next_sequence >= 1
            && self.next_sequence <= super::MAX_SAFE_INTEGER
            && self.last.is_some() == (self.next_sequence > 1)
            && u64::from(self.counters.statements) < self.next_sequence;
        let last = self
            .last
            .as_ref()
            .is_none_or(|last| hex64(&last.digest) && last.response.get().starts_with('{'));
        let terminal_reply = self.kind == Kind::Atomic
            || !matches!(self.phase, Phase::Committed | Phase::RolledBack)
            || self.last.is_some();
        // An atomic record only serializes work: `active`, then a terminal phase; it never
        // holds a reply, a sequence, a mutation, or `committing` (ADR 0024).
        let kind = match self.kind {
            Kind::Interactive => self.atomic.is_none(),
            Kind::Atomic => {
                matches!(
                    self.phase,
                    Phase::Active | Phase::Committed | Phase::Failed | Phase::Expired
                ) && self.atomic.as_ref().is_some_and(AtomicIds::is_valid)
                    && self.next_sequence == 1
                    && self.counters == Counters::default()
                    && self.mutations.is_empty()
                    && self.identity.mode == Mode::Write
            }
        };
        let mutations = self.mutations.len() <= MAX_MUTATIONS
            && self
                .mutations
                .windows(2)
                .all(|pair| pair[0].index < pair[1].index)
            && self.mutations.iter().all(|mutation| {
                mutation.index < self.counters.statements
                    && mutation.operation != Operation::Select
                    && !mutation.resource.is_empty()
                    && mutation.resource.len() <= MAX_RESOURCE_NAME_BYTES
            });
        let versions = self.versions.is_some() == (self.counters.statements > 0)
            && self.versions.as_ref().is_none_or(|versions| {
                short_text(&versions.schema) && short_text(&versions.policy)
            });
        hashes
            && kind
            && deadline
            && sequence
            && last
            && terminal_reply
            && mutations
            && versions
            && self.counters.usage.is_valid()
            && self.counters.result_bytes <= super::MAX_SAFE_INTEGER
            && self.binding.is_valid()
            && self.binding.snapshot == self.snapshot
            && short_text(&self.snapshot)
            && owner_name(&self.owner)
    }
}

/// The database connection as the owner sees it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Connection {
    None,
    Opening,
    Open,
    Closing,
}

/// The awaited effect kinds, recorded with their id while pending.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Awaited {
    Open,
    CheckBinding,
    Execute,
    Commit,
    Rollback,
    SetTimer,
    Persist,
    CallValidator,
    Forward,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pending {
    pub id: u64,
    pub effect: Awaited,
}

/// Which lane an operation in progress answers on. `background` work (expiry, fail closed,
/// discard) answers nobody.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkLane {
    Client,
    Background,
}

/// The operation in progress and the step it waits for. Each variant awaits exactly the
/// effect named in its documentation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Task {
    /// `CheckBinding` of a begin.
    #[serde(rename_all = "camelCase")]
    BeginBinding {
        identity: Identity,
        binding: Binding,
        snapshot: String,
    },
    /// `Open` of a begin; the record is created on `Opened`.
    #[serde(rename_all = "camelCase")]
    BeginOpen {
        identity: Identity,
        binding: Binding,
        snapshot: String,
        expires_at_ms: u64,
    },
    /// `Persist` of the new `active` record.
    BeginPersist,
    /// `SetTimer` at the expiry.
    BeginTimer,
    /// `CheckBinding` before a statement executes.
    #[serde(rename_all = "camelCase")]
    StatementBinding {
        sequence: u64,
        digest: String,
        handle: u64,
        operation: Operation,
        resource: Option<String>,
        versions: Versions,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        explain_resource: Option<u64>,
    },
    /// `Execute` of a statement.
    #[serde(rename_all = "camelCase")]
    StatementExecute {
        sequence: u64,
        digest: String,
        handle: u64,
        operation: Operation,
        resource: Option<String>,
        versions: Versions,
        started_at_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        explain_resource: Option<u64>,
    },
    /// `CheckBinding` before a commit. `auth` (the commit's canonical session) is present when
    /// the recorded mutations trigger commit checks, which run after this check; `passed` when
    /// they have all allowed the commit (this is the check after the last validator).
    #[serde(rename_all = "camelCase")]
    CommitBinding {
        sequence: u64,
        digest: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auth: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        passed: bool,
    },
    /// `Persist` of `committing`; the deadline is checked when it is consumed.
    #[serde(rename_all = "camelCase")]
    CommitPersist {
        sequence: u64,
        digest: String,
        #[serde(default, skip_serializing_if = "is_false")]
        passed: bool,
    },
    /// `Commit`; from here only its outcome decides.
    #[serde(rename_all = "camelCase")]
    CommitSend {
        sequence: u64,
        digest: String,
        #[serde(default, skip_serializing_if = "is_false")]
        passed: bool,
    },
    /// `Persist` of `validating`, before the first validator is called.
    ValidatingPersist(CommitChecks),
    /// `CallValidator` of `checks[index]`; its capability is live in volatile state.
    Validator(CommitChecks),
    /// A verdict that waits for the connection, which a callback query holds; awaits nothing
    /// (kept as `Volatile::deferred`, resumed when the callback query's `Execute` returns).
    #[serde(rename_all = "camelCase")]
    Verdict { checks: CommitChecks, allowed: bool },
    /// `CheckBinding` before a rollback command.
    RollbackBinding { sequence: u64, digest: String },
    /// `Rollback` of a rollback command.
    RollbackSend { sequence: u64, digest: String },
    /// `Rollback` before the record moves to `phase`; then `Persist` and, for client work,
    /// the reply.
    #[serde(rename_all = "camelCase")]
    CloseRollback {
        phase: Phase,
        reply: Option<Box<RawValue>>,
    },
    /// `Persist` of a decided record, then `reply` (client work) or nothing (background).
    /// On `PersistFailed` the reply is `failure` and the owner resets.
    #[serde(rename_all = "camelCase")]
    Reply {
        reply: Option<Box<RawValue>>,
        failure: Option<Box<RawValue>>,
        logs: Vec<Box<RawValue>>,
        failure_logs: Vec<Box<RawValue>>,
        /// A statement whose completion is being recorded: an expiry that arrived meanwhile
        /// rolls back after the reply.
        expire_after: bool,
        /// The durable text before the statement completed. When its completion cannot be
        /// stored, the record moves to `failed` from this state, so the statement is not
        /// recorded as done (a retry gets what a successor would answer).
        restore: Option<String>,
    },
    /// `Persist` of a fail-closed record; then `Reset` whatever the outcome.
    ResetAfterPersist,

    // ---- atomic execution (pull request 6) ----
    /// `CheckBinding` before an engine-side `execute` compiles (the `request` kind).
    RequestBinding { operation: Box<RawValue> },
    /// `Forward` of an `execute` whose commit checks could trigger; the owner's reply is
    /// relayed.
    AtomicForward,
    /// `CheckBinding` of an atomic input on its owner, before it compiles.
    AtomicBinding { input: Box<RawValue> },
    /// `Open` of the atomic database transaction.
    AtomicOpen,
    /// `Persist` of the owner's `active` record.
    AtomicPersist,
    /// `SetTimer` at the owner's deadline.
    AtomicTimer,
    /// `Execute` of the idempotency lookup.
    AtomicLookup,
    /// `Execute` of the envelope's statements.
    AtomicExecute,
    /// `CheckBinding` after the commit checks, before the idempotency row and COMMIT.
    AtomicCommitBinding,
    /// `Execute` of the idempotency row, in the same database transaction.
    AtomicInsert,
    /// `Commit`; from here only its outcome decides.
    AtomicCommit,
    /// `Rollback` after the lookup found this request's row; then the stored reply.
    AtomicReplay { reply: Box<RawValue> },
}

#[allow(clippy::trivially_copy_pass_by_ref)]
const fn is_false(value: &bool) -> bool {
    !*value
}

/// Where an atomic execution runs (ADR 0024 "One machine, three kinds").
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Placement {
    /// In the engine that received the request: no owner, no `Persist`, no `SetTimer`.
    Direct,
    /// On the owner of `tx_<validation hex>`: commit checks and their callbacks.
    Owner,
}

/// The idempotency identity of a keyed write (`identity_json` `request`).
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Idempotency {
    pub key_hash: String,
    pub fingerprint: String,
}

/// One statement of an atomic envelope, as the machine keeps it while the envelope runs.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtomicStatement {
    pub operation: Operation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub limits: StatementLimits,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explain_resource: Option<u64>,
}

/// The atomic `usage` of a reply (`turso.ts` `policyUsage`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtomicUsage {
    pub rows_returned: u64,
    pub rows_affected: u64,
    pub rows_read: u64,
    pub rows_written: u64,
    pub query_duration_ms: f64,
}

/// An atomic execution in progress (ADR 0024 `AtomicProgress`): compiled, executed, checked,
/// and committed within one request, so nothing of it is durable.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtomicRun {
    pub placement: Placement,
    /// The public `transactionId` (`atomic_...`).
    pub transaction_id: String,
    /// The request id the reply's `meta.requestId` names.
    pub request_id: String,
    /// The caller's canonical session (commit checks derive the callback session from it).
    pub auth: String,
    pub role: String,
    /// The pinned binding (the direct placement has no record).
    pub binding: Binding,
    /// The envelope's plan, live until the execution ends.
    pub handle: u64,
    pub statements: Vec<AtomicStatement>,
    pub versions: Versions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency: Option<Idempotency>,
    /// When the work began (`now_ms`), for the cumulative timeout.
    pub started_at_ms: u64,
    /// The owner's deadline (`now_ms + transaction_ms`); absent for the direct placement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    /// Whether the reply carries `debug.executionTrace` (tracing enabled and debug access).
    #[serde(default, skip_serializing_if = "is_false")]
    pub debug: bool,
    /// The execution trace `Execute` carries, kept for the reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Box<RawValue>>,
    /// The validated public results, once the envelope executed within its limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub results: Option<Box<RawValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AtomicUsage>,
    /// The statements that changed rows (by envelope index): what triggers commit checks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mutations: Vec<Mutation>,
    /// Every triggered commit check allowed the commit.
    #[serde(default, skip_serializing_if = "is_false")]
    pub checks_passed: bool,
}

/// The commit checks of the commit in progress (ADR 0024 `CommitProgress`): recomputed from
/// the policy when the commit starts, kept only in volatile state.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitChecks {
    pub sequence: u64,
    pub digest: String,
    /// The commit's canonical session; each check's callback session derives from it.
    pub auth: String,
    pub checks: Vec<super::compiler::TriggeredCheck>,
    /// The check being validated.
    pub index: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Work {
    pub lane: WorkLane,
    /// The client request this work answers.
    pub request_id: Option<String>,
    pub task: Task,
}

/// The live callback capability of the check being validated (ADR 0007): the token's hash,
/// never the token, its expiry, the callback session, and the callback queries' sequence,
/// last reply, and cumulative rows and bytes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub token_hash: String,
    pub expires_at_ms: u64,
    pub check: String,
    /// The callback session (canonical JSON): the commit's session with the check's role,
    /// that role added to `roles`, and `access: ["execute"]`.
    pub session: String,
    pub role: String,
    pub next_sequence: u64,
    pub last: Option<Replay>,
    pub rows: u64,
    pub result_bytes: u64,
}

/// A callback query in progress and the effect it waits for.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum CallbackTask {
    /// `CheckBinding` before the query executes.
    #[serde(rename_all = "camelCase")]
    Binding {
        sequence: u64,
        digest: String,
        handle: u64,
        versions: Versions,
    },
    /// `Execute` of the query on the transaction's connection.
    #[serde(rename_all = "camelCase")]
    Execute {
        sequence: u64,
        digest: String,
        handle: u64,
        versions: Versions,
    },
}

impl CallbackTask {
    #[must_use]
    pub const fn awaits(&self) -> Awaited {
        match self {
            Self::Binding { .. } => Awaited::CheckBinding,
            Self::Execute { .. } => Awaited::Execute,
        }
    }
}

/// The callback lane (ADR 0022): at most one query in progress, beside the client lane.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallbackWork {
    pub pending: Pending,
    pub request_id: String,
    /// The capability the query was authorized by; it continues only while that capability
    /// is the live one.
    pub token_hash: String,
    pub task: CallbackTask,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Volatile {
    pub v: u32,
    /// The owner name; absent in the engine (the `request` kind and direct atomic execution).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub next_effect_id: u64,
    pub connection: Connection,
    pub handles: Vec<u64>,
    pub pending: Option<Pending>,
    pub work: Option<Work>,
    pub rollback_requested: bool,
    /// The callback lane's query in progress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callback: Option<CallbackWork>,
    /// The capability of the validator being called; revoked at its verdict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<Capability>,
    /// A verdict waiting for the connection (`Task::Verdict`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred: Option<Work>,
    /// The `CallValidator` whose wait was ended (expiry, a failed callback): its late outcome
    /// is logged and ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_validator: Option<u64>,
    /// The atomic execution in progress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atomic: Option<Box<AtomicRun>>,
}

impl Volatile {
    /// Reads volatile JSON for `owner` (`None`: the engine); `None` when it is not a valid
    /// value of this version or exceeds `bound` bytes.
    #[must_use]
    pub fn parse(text: &str, owner: Option<&str>, bound: usize) -> Option<Self> {
        if text.len() > bound {
            return None;
        }
        let value: Self = serde_json::from_str(text).ok()?;
        (value.v == TX_STATE_VERSION && value.owner.as_deref() == owner && value.is_consistent())
            .then_some(value)
    }

    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Pending effect and work belong together on each lane; ids stay below 2^53 so the engine
    /// reads them exactly; at most one live handle per lane. A capability is live only while
    /// its validator is awaited; a deferred verdict only while a callback query executes.
    #[must_use]
    pub fn is_consistent(&self) -> bool {
        let work_awaits = self.work.as_ref().map(|work| awaited_by(&work.task));
        let paired = match (&self.pending, work_awaits) {
            (None, None) => true,
            (Some(pending), Some(effect)) => pending.effect == effect,
            _ => false,
        };
        let callback = self.callback.as_ref().is_none_or(|callback| {
            callback.pending.effect == callback.task.awaits()
                && callback.pending.id < self.next_effect_id
                && self
                    .pending
                    .is_none_or(|pending| pending.id != callback.pending.id)
                && super::io::valid_request_id(&callback.request_id)
        });
        let validating = matches!(
            self.work.as_ref().map(|work| &work.task),
            Some(Task::Validator(_))
        );
        let capability = self.capability.as_ref().is_none_or(|capability| {
            validating
                && hex64(&capability.token_hash)
                && capability.next_sequence >= 1
                && capability.next_sequence <= super::MAX_SAFE_INTEGER
                && capability.last.is_some() == (capability.next_sequence > 1)
        });
        let deferred = self.deferred.as_ref().is_none_or(|deferred| {
            self.work.is_none()
                && matches!(deferred.task, Task::Verdict { .. })
                && matches!(
                    self.callback.as_ref().map(|callback| &callback.task),
                    Some(CallbackTask::Execute { .. })
                )
                && deferred
                    .request_id
                    .as_deref()
                    .is_none_or(super::io::valid_request_id)
        });
        let verdict_in_work = matches!(
            self.work.as_ref().map(|work| &work.task),
            Some(Task::Verdict { .. })
        );
        paired
            && !verdict_in_work
            && callback
            && capability
            && deferred
            && self.next_effect_id >= 1
            && self.next_effect_id <= super::MAX_SAFE_INTEGER
            && self
                .pending
                .is_none_or(|pending| pending.id < self.next_effect_id)
            && self.handles.len() <= 2
            && self.owner.as_deref().is_none_or(owner_name)
            && self.atomic.as_ref().is_none_or(|atomic| {
                // The direct placement runs in the engine, the owner placement on its owner.
                (atomic.placement == Placement::Owner) == self.owner.is_some()
                    && atomic.binding.is_valid()
                    && super::io::valid_request_id(&atomic.request_id)
                    && self.handles.contains(&atomic.handle)
            })
            && self
                .work
                .as_ref()
                .and_then(|work| work.request_id.as_deref())
                .is_none_or(super::io::valid_request_id)
    }

    /// Whether a callback query's `Execute` holds the connection.
    #[must_use]
    pub fn callback_executing(&self) -> bool {
        matches!(
            self.callback.as_ref().map(|callback| &callback.task),
            Some(CallbackTask::Execute { .. })
        )
    }

    /// Nothing is in progress or held: the owner can drop this volatile part.
    #[must_use]
    pub fn is_idle(&self) -> bool {
        self.work.is_none()
            && self.pending.is_none()
            && self.connection == Connection::None
            && self.handles.is_empty()
            && self.callback.is_none()
            && self.capability.is_none()
            && self.deferred.is_none()
            && self.atomic.is_none()
    }
}

/// The effect a task waits for.
#[must_use]
pub const fn awaited_by(task: &Task) -> Awaited {
    match task {
        Task::BeginBinding { .. }
        | Task::StatementBinding { .. }
        | Task::CommitBinding { .. }
        | Task::RollbackBinding { .. }
        | Task::RequestBinding { .. }
        | Task::AtomicBinding { .. }
        | Task::AtomicCommitBinding => Awaited::CheckBinding,
        Task::BeginOpen { .. } | Task::AtomicOpen => Awaited::Open,
        Task::BeginPersist
        | Task::CommitPersist { .. }
        | Task::ValidatingPersist(_)
        | Task::Reply { .. }
        | Task::ResetAfterPersist
        | Task::AtomicPersist => Awaited::Persist,
        Task::BeginTimer | Task::AtomicTimer => Awaited::SetTimer,
        Task::AtomicForward => Awaited::Forward,
        // A deferred verdict is never pending (`is_consistent` keeps it out of `work`).
        Task::Validator(_) | Task::Verdict { .. } => Awaited::CallValidator,
        Task::StatementExecute { .. }
        | Task::AtomicLookup
        | Task::AtomicExecute
        | Task::AtomicInsert => Awaited::Execute,
        Task::CommitSend { .. } | Task::AtomicCommit => Awaited::Commit,
        Task::RollbackSend { .. } | Task::CloseRollback { .. } | Task::AtomicReplay { .. } => {
            Awaited::Rollback
        }
    }
}
