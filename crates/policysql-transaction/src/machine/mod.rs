//! The transaction step machine (ADR 0024): `step(durable, volatile, event, host) ->
//! (durable, volatile, effects)`, pure, with no I/O, clock, or randomness.
//!
//! Pull request 4 implements the `interactive` kind on an owner: begin, statement, commit,
//! rollback, expiry, and owner loss, without commit checks. Commit checks and callbacks (pull
//! request 5) attach at [`Compiler::triggered_checks`] and the `validating` phase, which a
//! record may already hold and which is handled by the successor rules; until then a commit
//! whose changed rows trigger a check is rejected with `POLICYSQL_COMMIT_CHECK_REJECTED`.
//! Atomic execution (pull request 6) and the engine-side `request` kind (pull request 7) are not
//! implemented: their events are answered without effects.
//!
//! This module holds the state, events, effects, and the compiler port; the transitions and
//! the JSON entry point follow. The machine is not used by production paths before the
//! switch-over (pull request 7).

pub mod compiler;
pub mod io;
pub mod state;
pub mod time;

pub use compiler::{
    Compiled, Compiler, CoreError, DriverStatement, Operation, RawResult, StatementSummary,
    Validated,
};
pub use io::{Class, Effect, Event, HostFacts};
pub use state::{
    Durable, MAX_DURABLE_BYTES, MAX_VOLATILE_BYTES, Phase, TX_STATE_VERSION, Volatile,
    durable_bound_holds,
};

/// The largest integer JavaScript reads exactly; ids, sequences, and times stay below it.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// The latest time the machine accepts (9999-12-31T23:59:59.999Z, minus a day so every
/// deadline it computes stays in range).
pub const MAX_TIME_MS: u64 = 253_402_300_799_999 - 86_400_000;
/// Event JSON beyond the raw results: the forwarded input, ids, and framing.
pub const EVENT_FIXED_BYTES: usize = 64 * 1024;
/// Raw results per statement in an `Executed` event.
pub const EVENT_RESULT_BYTES: usize = 1_048_576;

/// The runtime limits the machine enforces (`RuntimeLimits`, ADR 0024 pull request 3).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub transaction_ms: u64,
    pub max_transaction_statements: u64,
    pub max_transaction_result_bytes: u64,
    pub begin_timeout_ms: u64,
    /// Statements per atomic envelope; bounds an `Executed` event.
    pub max_statements: u64,
}

impl Limits {
    /// The largest event JSON: `max_statements` × 1 MiB of raw results plus 64 KiB.
    #[must_use]
    pub fn max_event_bytes(&self) -> usize {
        usize::try_from(self.max_statements.max(1))
            .unwrap_or(usize::MAX)
            .saturating_mul(EVENT_RESULT_BYTES)
            .saturating_add(EVENT_FIXED_BYTES)
    }
}
