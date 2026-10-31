//! The transaction step machine (ADR 0024): `step(durable, volatile, event, host) ->
//! (durable, volatile, effects)`, pure, with no I/O, clock, or randomness.
//!
//! Pull request 4 implements the `interactive` kind on an owner: begin, statement, commit,
//! rollback, expiry, and owner loss. Pull request 5 adds commit checks and callbacks: a commit
//! whose recorded mutations trigger checks ([`Compiler::triggered_checks`]) persists
//! `validating`, calls each validator in turn (`CallValidator`) with a fresh callback
//! capability, serves the validator's callback queries on the callback lane, revokes the
//! capability at the verdict, and checks the binding again before `committing`.
//! Pull request 6 adds atomic execution with placements `direct` (in the engine, from a
//! `request` event for `execute`) and `owner` (a forwarded `atomic` input, with commit checks),
//! the idempotency lookup, replay, and row, and the cumulative limits. The `request` kind of
//! interactive commands is not implemented: since pull request 7 the engine forwards the owner
//! inputs (`begin`, `statement`, `commit`, `rollback`, `callbackQuery`) itself (ADR 0024,
//! notes of pull request 7).
//!
//! The JSON entry point is [`step_json`]; `policysql-wasm` exports it as `step_json`. Since
//! pull request 7 production owners run interactive transactions on it, and since pull request
//! 8 the engine (`request` kind, placement `direct`) and owners run atomic execution on it.

pub mod compiler;
pub mod io;
pub mod state;
mod step;
pub mod time;

pub use compiler::{
    Compiled, Compiler, CoreError, DriverStatement, Operation, RawResult, StatementLimits,
    StatementSummary, TriggeredCheck, Validated,
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
/// Raw results per statement in an `Executed` event. This is the result-side bound of ADR
/// 0027, which pull request 6 replaces with the compiled raw bound; the request side of the
/// event is derived from the configured request limit ([`crate::bounds::event_bytes`]).
pub const EVENT_RESULT_BYTES: usize = 1_048_576;

/// The runtime limits the machine enforces (`RuntimeLimits`, ADR 0024 pull request 3).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub transaction_ms: u64,
    pub max_transaction_statements: u64,
    pub max_transaction_result_bytes: u64,
    pub begin_timeout_ms: u64,
    /// Cumulative callback query rows per commit check.
    pub max_callback_rows: u64,
    /// Statements per atomic envelope; bounds an `Executed` event.
    pub max_statements: u64,
    /// The configured request body limit; bounds the body text an event carries.
    pub max_request_bytes: u64,
}

impl Limits {
    /// The largest volatile JSON: [`MAX_VOLATILE_BYTES`] plus room for an atomic execution's
    /// validated results (derived from one `Executed` event, whose raw rows they restate as
    /// objects) and the body text it compiled.
    #[must_use]
    pub fn max_volatile_bytes(&self) -> usize {
        MAX_VOLATILE_BYTES.saturating_add(self.max_event_bytes().saturating_mul(4))
    }

    /// The largest event JSON, derived from the request limit and the raw result bound
    /// (ADR 0027 "Derived internal bounds"): the JSON-escaped body, the auth, the binding,
    /// `max_statements` × 1 MiB of raw results, and framing.
    #[must_use]
    pub fn max_event_bytes(&self) -> usize {
        let results = usize::try_from(self.max_statements.max(1))
            .unwrap_or(usize::MAX)
            .saturating_mul(EVENT_RESULT_BYTES);
        crate::bounds::event_bytes(self.max_request_bytes(), results)
    }

    /// The configured request limit as a length.
    #[must_use]
    pub fn max_request_bytes(&self) -> usize {
        usize::try_from(self.max_request_bytes).unwrap_or(usize::MAX)
    }

    /// The largest `identity_json` input for this configuration.
    #[must_use]
    pub fn max_hash_input_bytes(&self) -> usize {
        crate::bounds::hash_input_bytes(self.max_request_bytes())
    }
}

/// The result of one step.
#[derive(Debug)]
pub struct Output {
    /// The durable state to keep in memory and, when `effects` holds `Persist`, to write.
    /// `None` with `Reset` among the effects: reload from the store.
    pub durable: Option<String>,
    /// The volatile state to pass back with the next event; `None` when the owner holds no
    /// connection and awaits nothing.
    pub volatile: Option<String>,
    pub effects: Vec<Effect>,
}

/// Runs one step on JSON inputs and returns the output JSON:
/// `{"durable": string|null, "volatile": string|null, "effects": [...]}`, where `durable` and
/// `volatile` are the JSON texts the engine keeps verbatim and passes back. Invalid host facts
/// or an unreadable event envelope give `{"error":{"code":"POLICYSQL_INTERNAL",...}}` and no
/// state; the engine then replies 500 and sends `Abandon` with the previous state.
#[must_use]
pub fn step_json<C: Compiler>(
    compiler: &C,
    limits: &Limits,
    durable: Option<&str>,
    volatile: Option<&str>,
    event: &str,
    host: &str,
) -> String {
    match step::run(compiler, limits, durable, volatile, event, host) {
        Some(output) => output_json(&output),
        None => INTERNAL_OUTPUT.to_owned(),
    }
}

/// [`step_json`] with a typed result; `None` is the `{"error":…}` output.
#[must_use]
pub fn step<C: Compiler>(
    compiler: &C,
    limits: &Limits,
    durable: Option<&str>,
    volatile: Option<&str>,
    event: &str,
    host: &str,
) -> Option<Output> {
    step::run(compiler, limits, durable, volatile, event, host)
}

const INTERNAL_OUTPUT: &str = r#"{"error":{"code":"POLICYSQL_INTERNAL","message":"The request could not be completed.","path":null}}"#;

#[derive(serde::Serialize)]
struct OutputWire<'a> {
    durable: Option<&'a str>,
    volatile: Option<&'a str>,
    effects: &'a [Effect],
}

/// The output JSON of a step.
#[must_use]
pub fn output_json(output: &Output) -> String {
    serde_json::to_string(&OutputWire {
        durable: output.durable.as_deref(),
        volatile: output.volatile.as_deref(),
        effects: &output.effects,
    })
    .unwrap_or_else(|_| INTERNAL_OUTPUT.to_owned())
}
