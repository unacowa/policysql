//! Properties of atomic execution (ADR 0024 "Testing strategy", pull request 6), over random
//! effect outcomes, verdicts, timers, `Abandon`, and duplicated or stale outcome events, on
//! both placements, keyed and unkeyed:
//!
//! - at most one `Commit` per atomic execution;
//! - a keyed retry never executes twice: across executions of one key and body, at most one
//!   envelope is committed, and every later one is answered from the row or rejected;
//! - no definite rejection after `Commit`: once an execution emitted `Commit`, its reply is the
//!   committed response or a code the client treats as an unknown outcome;
//! - a failed expectation rolls back: no `Commit`, and nothing is stored;
//! - every plan handle is released; `step` is deterministic.

mod common;

use common::{Engine, atomic_input, code, envelope, execute_request};
use proptest::prelude::*;
use serde_json::{Value, json};

const KEY: &str = "request-key-0001";
const KEY_HASH: &str = "0123456789abcdef0123456789abcdef00000000000000000000000000000000";
const FINGERPRINT: &str = "f00df00df00df00df00df00df00df00df00df00df00df00df00df00df00df00d";
const CLASSES: [&str; 5] = [
    "timeout",
    "unavailable",
    "rejected",
    "not_committed",
    "unknown",
];

/// The codes the client takes as a definite rejection of `execute` (`REJECTIONS` in
/// `packages/client/protocol.js`).
const REJECTIONS: [&str; 26] = [
    "POLICYSQL_UNAUTHENTICATED",
    "POLICYSQL_AUTHENTICATION_FAILED",
    "POLICYSQL_FORBIDDEN_ACCESS",
    "POLICYSQL_MISSING_POLICY",
    "POLICYSQL_FORBIDDEN_OPERATION",
    "POLICYSQL_FORBIDDEN_COLUMN",
    "POLICYSQL_FORBIDDEN_COLUMN_CONTEXT",
    "POLICYSQL_PRESET_COLUMN",
    "POLICYSQL_TRANSACTION_MODE_VIOLATION",
    "POLICYSQL_INVALID_REQUEST",
    "POLICYSQL_INVALID_SQL",
    "POLICYSQL_MULTIPLE_STATEMENTS",
    "POLICYSQL_UNSUPPORTED_SQL",
    "POLICYSQL_DUPLICATE_RESULT_COLUMN",
    "POLICYSQL_INVALID_PARAMETER",
    "POLICYSQL_AMBIGUOUS_PARAMETER_TYPE",
    "POLICYSQL_STALE_OPERATION",
    "POLICYSQL_IDEMPOTENCY_CONFLICT",
    "POLICYSQL_TRANSACTION_CONFLICT",
    "POLICYSQL_TRANSACTION_UNAVAILABLE",
    "POLICYSQL_COMMIT_CHECK_REJECTED",
    "POLICYSQL_LIMIT_EXCEEDED",
    "POLICYSQL_EXPECTATION_FAILED",
    "POLICYSQL_SCHEMA_MISMATCH",
    "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED",
    "POLICYSQL_USAGE_BUDGET_EXCEEDED",
];

#[derive(Clone, Copy, Debug)]
enum Action {
    /// Run the outstanding effect, successfully or with the failure class `class`.
    Resolve(bool, usize),
    /// Answer an outstanding validator call with an allowing or denying decision.
    Decide(bool),
    /// Advance the clock and fire the timer.
    Timer(u64),
    /// The engine abandons its state (owner shutdown).
    Abandon,
    /// Feed the last outcome event again.
    Duplicate,
    /// Feed an outcome for an effect id that is not pending.
    Stale(u64),
}

fn action() -> impl Strategy<Value = Action> {
    prop_oneof![
        8 => (prop::bool::weighted(0.8), 0..CLASSES.len()).prop_map(|(ok, class)| Action::Resolve(ok, class)),
        2 => any::<bool>().prop_map(Action::Decide),
        1 => (0_u64..6_000).prop_map(Action::Timer),
        1 => Just(Action::Abandon),
        1 => Just(Action::Duplicate),
        1 => any::<u64>().prop_map(Action::Stale),
    ]
}

#[derive(Clone, Copy, Debug)]
struct Setup {
    owner: bool,
    keyed: bool,
    /// 0 select, 1 insert, 2 insert into a checked resource, 3 an insert whose expectation fails.
    body: u8,
    /// Owner placement: 0 no row, 1 this request's row, 2 another fingerprint's, 3 two rows.
    row: u8,
    requests: usize,
}

fn setup() -> impl Strategy<Value = Setup> {
    (any::<bool>(), any::<bool>(), 0_u8..4, 0_u8..4, 1_usize..4).prop_map(
        |(owner, keyed, body, row, requests)| Setup {
            owner,
            keyed,
            body,
            row,
            requests,
        },
    )
}

fn body(kind: u8) -> Value {
    match kind {
        0 => envelope(&[("SELECT id, name FROM projects", json!({}))]),
        1 => envelope(&[(
            "INSERT INTO projects (id, name) VALUES (:id, :name)",
            json!({"id": "p1", "name": "p1"}),
        )]),
        2 => envelope(&[(
            "INSERT INTO audited (id, note) VALUES (:id, :note)",
            json!({"id": "a1", "note": "a1"}),
        )]),
        _ => json!({"statements": [{"sql": "INSERT INTO projects (id, name) VALUES (:id, :name)",
            "params": {"id": "p1", "name": "p1"}, "expect": {"affectedRows": 2}}]}),
    }
}

fn request(setup: &Setup) -> Value {
    let body = body(setup.body);
    if setup.owner {
        atomic_input(&body, setup.keyed.then_some([KEY_HASH, FINGERPRINT]))
    } else {
        execute_request(&body, setup.keyed.then_some(KEY))
    }
}

const STORED: &str = r#"{"version":1,"transactionId":"atomic_0123456789abcdef01234567","status":"committed","results":[],"usage":{},"originalRequestId":"earlier","replayed":false,"commitChecks":"passed"}"#;

fn engine(setup: &Setup) -> Engine {
    let mut engine = Engine::atomic(setup.owner);
    engine.configured = vec!["consistency".to_owned()];
    if setup.owner && setup.keyed {
        let row = |fingerprint: &str| {
            [
                KEY_HASH.to_owned(),
                fingerprint.to_owned(),
                STORED.to_owned(),
            ]
        };
        engine.idempotency_rows = match setup.row {
            1 => vec![row(FINGERPRINT)],
            2 => vec![row(&"e".repeat(64))],
            3 => vec![row(FINGERPRINT), row(FINGERPRINT)],
            _ => Vec::new(),
        };
    }
    engine
}

/// The outcome event a resolution would feed, without feeding it.
fn last_outcome(engine: &Engine) -> Option<String> {
    engine
        .transcript
        .last()
        .map(|line| line.event.clone())
        .filter(|event| event.contains("\"id\""))
}

/// Keeps the outstanding effect of the client lane across an event of another lane, unless
/// that event reset the owner (the engine then closed the connection).
fn restore(engine: &mut Engine, outstanding: Option<Value>) {
    let reset = engine
        .last_effects
        .iter()
        .any(|effect| effect["type"] == "reset");
    if engine.outstanding.is_none() && !reset {
        engine.outstanding = outstanding;
    }
}

/// Runs one script; returns the engine and every execution's (commits emitted, reply).
fn run(setup: &Setup, actions: &[Action]) -> (Engine, Vec<(usize, Option<Value>)>) {
    let mut engine = engine(setup);
    let mut actions = actions.iter();
    let mut executions = Vec::new();
    for _ in 0..setup.requests {
        let commits = engine.observed.commits_emitted;
        let replies = engine.observed.replies.len();
        engine.feed(&request(setup));
        for action in actions.by_ref().take(12) {
            match *action {
                Action::Resolve(ok, class) => {
                    engine.resolve(ok, CLASSES[class]);
                }
                Action::Decide(allowed) => {
                    if engine
                        .outstanding
                        .as_ref()
                        .is_some_and(|effect| effect["type"] == "callValidator")
                    {
                        engine.decide(true, &json!({"version": "1", "allowed": allowed}));
                    } else {
                        engine.resolve(true, "unknown");
                    }
                }
                Action::Timer(ms) => {
                    engine.now += ms;
                    if engine.owner.is_some() {
                        let outstanding = engine.outstanding.take();
                        engine.feed(&json!({"type": "timerFired"}));
                        restore(&mut engine, outstanding);
                    }
                }
                Action::Abandon => {
                    engine.feed(&json!({"type": "abandon"}));
                    // The engine runs Abandon's Persist as it discards the state; no outcome
                    // follows, and the owner restarts from the store.
                    if let Some(effect) = engine.outstanding.take()
                        && effect["type"] == "persist"
                    {
                        engine.store = engine.persist_text.take();
                    }
                    engine.pending_rows.clear();
                    engine.envelope_open = false;
                    engine.lose();
                    break;
                }
                Action::Duplicate => {
                    if let Some(event) = last_outcome(&engine) {
                        let outstanding = engine.outstanding.take();
                        engine.feed(&serde_json::from_str(&event).unwrap_or(Value::Null));
                        restore(&mut engine, outstanding);
                    }
                }
                Action::Stale(id) => {
                    let outstanding = engine.outstanding.take();
                    engine.feed(&json!({"type": "rolledBack", "id": id % 1_000_000}));
                    restore(&mut engine, outstanding);
                }
            }
        }
        engine.settle();
        executions.push((
            engine.observed.commits_emitted - commits,
            engine
                .observed
                .replies
                .get(replies)
                .map(|(_, reply)| reply.clone()),
        ));
        assert_eq!(
            engine.compiler.live_handles(),
            0,
            "every handle is released"
        );
    }
    (engine, executions)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 768, ..ProptestConfig::default() })]

    #[test]
    fn atomic_execution_properties(setup in setup(), actions in prop::collection::vec(action(), 0..36)) {
        let (engine, executions) = run(&setup, &actions);
        for (commits, reply) in &executions {
            prop_assert!(*commits <= 1, "at most one COMMIT per atomic execution");
            if *commits == 1 && let Some(reply) = reply {
                let rejected = code(reply).is_some_and(|code| REJECTIONS.contains(&code));
                prop_assert!(!rejected, "no definite rejection after COMMIT: {reply}");
                if reply["ok"] == true {
                    prop_assert_eq!(&reply["value"]["status"], "committed");
                }
            }
            if let Some(reply) = reply && reply["ok"] == true {
                prop_assert_eq!(&reply["value"]["status"], "committed");
            }
        }
        if setup.keyed && setup.body != 0 {
            // One key and one body: a keyed retry never executes twice.
            prop_assert!(engine.observed.envelope_commits <= 1, "{} envelopes committed", engine.observed.envelope_commits);
            prop_assert!(engine.idempotency_rows.len() <= 1 + usize::from(setup.row == 3));
        }
        if setup.body == 3 {
            prop_assert_eq!(engine.observed.envelope_commits, 0, "a failed expectation never commits");
            prop_assert!(engine.idempotency_rows.iter().all(|row| row[2] == STORED), "nothing is stored");
            for (_, reply) in &executions {
                if let Some(reply) = reply {
                    prop_assert!(reply["ok"] != true || setup.row == 1, "only a replay succeeds: {reply}");
                }
            }
        }
        if setup.owner && setup.keyed && setup.row == 2 {
            prop_assert_eq!(engine.observed.envelope_commits, 0, "a conflicting row never executes");
        }
        // Deterministic: the same inputs give the same output bytes.
        let (again, _) = run(&setup, &actions);
        prop_assert_eq!(&again.transcript, &engine.transcript);
    }
}

#[test]
fn a_failed_expectation_emits_a_rollback() {
    let setup = Setup {
        owner: false,
        keyed: true,
        body: 3,
        row: 0,
        requests: 1,
    };
    let (engine, executions) = run(&setup, &[]);
    assert_eq!(
        code(executions[0].1.as_ref().unwrap_or(&Value::Null)),
        Some("POLICYSQL_EXPECTATION_FAILED")
    );
    assert_eq!(engine.observed.rollbacks_emitted, 1);
    assert_eq!(engine.observed.commits_emitted, 0);
    let setup = Setup {
        owner: true,
        ..setup
    };
    let (engine, executions) = run(&setup, &[]);
    assert_eq!(
        code(executions[0].1.as_ref().unwrap_or(&Value::Null)),
        Some("POLICYSQL_EXPECTATION_FAILED")
    );
    assert_eq!(engine.observed.rollbacks_emitted, 1);
    assert_eq!(engine.observed.commits_emitted, 0);
}
