//! Properties of `step` (ADR 0024 "Testing strategy"), over random event sequences generated
//! from a model of the engine and adversarial inputs: duplicated, stale, and reordered
//! outcomes, `Abandon`, owner loss, timers and clock jumps around every deadline, invalid
//! volatile state, and tampered durable state.
#![allow(
    clippy::too_many_lines,
    clippy::struct_excessive_bools,
    clippy::collapsible_match
)]

mod common;

use common::{
    Engine, FakeCompiler, LIMITS, OWNER, begin, code, command, phase_of, rejects_commit,
    sequence_text,
};
use policysql_transaction::machine::step_json;
use proptest::prelude::*;
use serde_json::{Value, json};

#[derive(Clone, Debug)]
enum Action {
    Begin(bool),
    Statement {
        offset: i8,
        sql: u8,
        alternate: bool,
    },
    Commit {
        offset: i8,
    },
    Rollback {
        offset: i8,
    },
    /// Run the outstanding effect: success, or a failure of the given class.
    Resolve {
        ok: bool,
        class: u8,
    },
    Timer,
    Advance(u16),
    Abandon,
    Lose,
    /// Feed the last outcome event again.
    Duplicate,
    /// Feed an outcome for an id that is not pending.
    Stale {
        delta: u8,
        kind: u8,
    },
    /// Hold the outstanding effect's outcome and feed it after the next action.
    Hold,
    CorruptVolatile,
}

fn action() -> impl Strategy<Value = Action> {
    prop_oneof![
        1 => any::<bool>().prop_map(Action::Begin),
        4 => (-1i8..=1, 0u8..5, any::<bool>()).prop_map(|(offset, sql, alternate)| Action::Statement { offset, sql, alternate }),
        3 => (-1i8..=1).prop_map(|offset| Action::Commit { offset }),
        1 => (-1i8..=1).prop_map(|offset| Action::Rollback { offset }),
        12 => (prop::bool::weighted(0.8), 0u8..6).prop_map(|(ok, class)| Action::Resolve { ok, class }),
        2 => Just(Action::Timer),
        2 => prop_oneof![0u16..50, 3_900u16..4_100, 0u16..9_000].prop_map(Action::Advance),
        1 => Just(Action::Abandon),
        1 => Just(Action::Lose),
        1 => Just(Action::Duplicate),
        1 => (0u8..4, 0u8..7).prop_map(|(delta, kind)| Action::Stale { delta, kind }),
        1 => Just(Action::Hold),
        1 => Just(Action::CorruptVolatile),
    ]
}

const SQL: [&str; 5] = [
    "SELECT id FROM projects",
    "INSERT INTO projects (id) VALUES (:id)",
    "UPDATE projects SET name = :name",
    "DELETE FROM projects",
    "BAD",
];
const CLASSES: [&str; 6] = [
    "timeout",
    "unavailable",
    "rejected",
    "not_committed",
    "unknown",
    "limit",
];

fn next_sequence(engine: &Engine) -> u64 {
    engine
        .durable
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value["nextSequence"].as_u64())
        .unwrap_or(1)
}

fn sequence(engine: &Engine, offset: i8) -> u64 {
    next_sequence(engine)
        .saturating_add_signed(i64::from(offset))
        .max(1)
}

/// What the properties remember across the run.
#[derive(Default)]
struct Watch {
    commit_emitted: bool,
    persist_committing: bool,
    /// `commit:{sequence}` of the commit whose `committing` record was persisted.
    committing: Option<String>,
    /// The volatile state was corrupted: its handles are unknown to the machine.
    handles_unknown: bool,
    /// The step just run got a corrupted volatile state.
    corrupted: bool,
    replies_seen: usize,
    lines_seen: usize,
}

fn stored_expiry(engine: &Engine) -> Option<u64> {
    let value: Value = serde_json::from_str(engine.store.as_deref()?).ok()?;
    value["expiresAtMs"].as_u64()
}

/// Checks every property on the effects and replies of the step just run.
fn check(engine: &Engine, watch: &mut Watch) -> Result<(), TestCaseError> {
    let fresh = engine.transcript.len() > watch.lines_seen;
    watch.lines_seen = engine.transcript.len();
    let effects: &[Value] = if fresh { &engine.last_effects } else { &[] };
    for effect in effects {
        if effect["record"]["event"] == "tx_fail_closed" {
            // Only adversarial inputs fail closed; an internal invariant never does.
            let reason = effect["record"]["reason"].as_str().unwrap_or("");
            // Every volatile state the machine writes reads back: `volatile_invalid` only
            // right after the test corrupted it.
            prop_assert!(
                reason == "outcome_not_pending"
                    || (reason == "volatile_invalid" && watch.corrupted),
                "fail closed: {}",
                reason
            );
        }
        match effect["type"].as_str() {
            Some("commit") => {
                // At most one COMMIT per transaction, only after `committing` is stored, and
                // never at or after the deadline.
                prop_assert!(!watch.commit_emitted, "a second COMMIT");
                let stored = phase_of(engine.store.as_deref());
                prop_assert_eq!(stored.as_deref(), Some("committing"));
                prop_assert!(stored_expiry(engine).is_some_and(|at| engine.now < at));
                watch.commit_emitted = true;
            }
            Some("persist") => {
                if phase_of(engine.durable.as_deref()).as_deref() == Some("committing")
                    && !watch.persist_committing
                {
                    watch.persist_committing = true;
                    let next = engine
                        .durable
                        .as_deref()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .and_then(|value| value["nextSequence"].as_u64());
                    watch.committing = next.map(|sequence| format!("commit:{sequence}"));
                }
            }
            _ => {}
        }
    }
    let not_committed = engine.observed.not_committed_fed;
    if watch.commit_emitted && !not_committed {
        for text in [engine.durable.as_deref(), engine.store.as_deref()] {
            let phase = phase_of(text);
            prop_assert!(
                !matches!(phase.as_deref(), Some("failed" | "expired" | "rolled_back")),
                "after COMMIT the phase is {:?}",
                phase
            );
        }
    }
    for (kind, reply) in &engine.observed.replies[watch.replies_seen..] {
        // The properties are about the commit that reached `committing` (a commit at another
        // sequence is another command and may be rejected).
        let that_commit = watch
            .committing
            .as_deref()
            .is_none_or(|committing| committing == kind);
        if kind.starts_with("commit") && that_commit {
            if reply["ok"] == true && reply["value"]["status"] == "committed" {
                prop_assert!(engine.observed.committed_fed, "committed before Committed");
            }
            if rejects_commit(reply) && !(not_committed && reply["value"]["status"] == "failed") {
                prop_assert!(!watch.commit_emitted, "a rejection after COMMIT: {}", reply);
                if watch.persist_committing {
                    // Never while the store says COMMIT may have been sent: a successor, or
                    // this owner after `Reset`, would answer outcome-unknown. When `committing`
                    // landed, the rejecting phase replaced it before the reply.
                    let stored = phase_of(engine.store.as_deref());
                    prop_assert!(
                        !matches!(stored.as_deref(), Some("committing" | "commit_unknown")),
                        "rejected with {:?} stored: {}",
                        stored,
                        reply
                    );
                    if engine
                        .observed
                        .stored_phases
                        .iter()
                        .any(|phase| phase == "committing")
                    {
                        prop_assert!(
                            matches!(stored.as_deref(), Some("failed" | "expired" | "discarded")),
                            "rejected after committing landed with {:?} stored: {}",
                            stored,
                            reply
                        );
                    }
                }
            }
        }
    }
    watch.replies_seen = engine.observed.replies.len();
    if engine.volatile.is_none() && engine.outstanding.is_none() && !watch.handles_unknown {
        prop_assert_eq!(
            engine.compiler.live_handles(),
            0,
            "a handle was not released"
        );
    }
    Ok(())
}

fn feed_checked(engine: &mut Engine, event: &Value) -> Result<(), TestCaseError> {
    // Determinism: the same inputs give the same output bytes.
    let shadow = engine.compiler.clone();
    let host_before = engine.requests;
    engine.feed(event);
    let line = engine
        .transcript
        .last()
        .cloned()
        .ok_or_else(|| TestCaseError::fail("no line"))?;
    let again = step_json(
        &shadow,
        &LIMITS,
        line.durable.as_deref(),
        line.volatile.as_deref(),
        &line.event,
        &line.host,
    );
    prop_assert_eq!(&again, &line.output);
    prop_assert_eq!(engine.requests, host_before + 1);
    Ok(())
}

/// What a run reached, for the generator-coverage test.
#[derive(Debug, Default)]
struct Reached {
    commit: bool,
    committed: bool,
    unknown: bool,
    expired: bool,
    fail_closed: bool,
    rejected_after_committing: bool,
}

fn run_actions(actions: &[Action]) -> Result<(), TestCaseError> {
    run_reaching(actions).map(|_| ())
}

fn run_reaching(actions: &[Action]) -> Result<Reached, TestCaseError> {
    let mut engine = Engine::new();
    let mut watch = Watch::default();
    let mut held: Option<Value> = None;
    let mut last_outcome: Option<Value> = None;
    for action in actions {
        let client_busy = !engine.waiting.is_empty();
        let release_held =
            held.is_some() && !matches!(action, Action::Hold | Action::Lose | Action::Abandon);
        match action {
            Action::Begin(write) if !client_busy => {
                feed_checked(&mut engine, &begin(if *write { "write" } else { "read" }))?;
            }
            Action::Statement {
                offset,
                sql,
                alternate,
            } if !client_busy => {
                let sql = SQL[usize::from(*sql)];
                let params = if *alternate {
                    json!({"id": "b"})
                } else {
                    json!({"id": "a"})
                };
                let text =
                    json!({"sequence": sequence(&engine, *offset), "sql": sql, "params": params})
                        .to_string();
                feed_checked(&mut engine, &command("statement", &text))?;
            }
            Action::Commit { offset } if !client_busy => {
                let text = sequence_text(sequence(&engine, *offset));
                feed_checked(&mut engine, &command("commit", &text))?;
            }
            Action::Rollback { offset } if !client_busy => {
                let text = sequence_text(sequence(&engine, *offset));
                feed_checked(&mut engine, &command("rollback", &text))?;
            }
            Action::Resolve { ok, class } => {
                if let Some(effect) = engine.outstanding.clone() {
                    let before = engine.transcript.len();
                    let shadow = engine.compiler.clone();
                    engine.resolve(*ok, CLASSES[usize::from(*class)]);
                    if let Some(line) = engine.transcript.get(before).cloned() {
                        let again = step_json(
                            &shadow,
                            &LIMITS,
                            line.durable.as_deref(),
                            line.volatile.as_deref(),
                            &line.event,
                            &line.host,
                        );
                        prop_assert_eq!(&again, &line.output);
                        last_outcome = serde_json::from_str(&line.event).ok();
                    }
                    let _ = effect;
                }
            }
            Action::Timer => feed_checked(&mut engine, &json!({"type": "timerFired"}))?,
            Action::Advance(ms) => engine.now += u64::from(*ms),
            Action::Abandon => {
                feed_checked(&mut engine, &json!({"type": "abandon"}))?;
                // The engine runs the one Persist, then discards everything.
                if engine
                    .outstanding
                    .as_ref()
                    .is_some_and(|effect| effect["type"] == "persist")
                {
                    engine.store = engine.persist_text.take();
                }
                engine.lose();
                // A lost owner's effects never complete (ADR 0022).
                held = None;
            }
            Action::Lose => {
                engine.lose();
                held = None;
            }
            Action::Duplicate => {
                if let Some(event) = last_outcome.clone() {
                    let outstanding = engine.outstanding.clone();
                    feed_checked(&mut engine, &event)?;
                    if engine.outstanding.is_none() && engine.volatile.is_some() {
                        engine.outstanding = outstanding;
                    }
                }
            }
            Action::Stale { delta, kind } => {
                let base = engine
                    .outstanding
                    .as_ref()
                    .and_then(|effect| effect["id"].as_u64())
                    .unwrap_or(1);
                let id = base + 1 + u64::from(*delta);
                let event = match kind {
                    0 => json!({"type": "committed", "id": id}),
                    1 => json!({"type": "persisted", "id": id}),
                    2 => json!({"type": "rolledBack", "id": id}),
                    3 => json!({"type": "opened", "id": id}),
                    4 => json!({"type": "bindingChecked", "id": id, "allowed": true}),
                    5 => json!({"type": "commitFailed", "id": id, "class": "unknown"}),
                    _ => json!({"type": "executed", "id": id, "results": []}),
                };
                let outstanding = engine.outstanding.clone();
                feed_checked(&mut engine, &event)?;
                if engine.outstanding.is_none() && engine.volatile.is_some() {
                    engine.outstanding = outstanding;
                }
            }
            Action::Hold => {
                if held.is_none() {
                    held = engine.outstanding.take();
                }
            }
            Action::CorruptVolatile => {
                if let Some(text) = engine.volatile.as_mut() {
                    watch.handles_unknown = true;
                    watch.corrupted = true;
                    text.truncate(text.len() / 2);
                    let outstanding = engine.outstanding.clone();
                    feed_checked(&mut engine, &json!({"type": "timerFired"}))?;
                    if engine.outstanding.is_none() && engine.volatile.is_some() {
                        engine.outstanding = outstanding;
                    }
                }
            }
            _ => {}
        }
        check(&engine, &mut watch)?;
        watch.corrupted = false;
        if release_held && let Some(effect) = held.take() {
            // A reordered outcome arrives late.
            engine.outstanding = Some(effect);
            engine.resolve(true, "unknown");
            check(&engine, &mut watch)?;
        }
    }
    // Every reachable durable state is readable by the machine (it never writes a value it
    // would discard), and the durable state round-trips.
    if let Some(text) = &engine.store {
        prop_assert!(
            policysql_transaction::machine::Durable::parse(text, OWNER).is_ok(),
            "{}",
            text
        );
    }
    let replies = &engine.observed.replies;
    Ok(Reached {
        commit: watch.commit_emitted,
        committed: replies
            .iter()
            .any(|(_, reply)| reply["value"]["status"] == "committed"),
        unknown: replies
            .iter()
            .any(|(_, reply)| code(reply) == Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN")),
        expired: engine
            .observed
            .stored_phases
            .iter()
            .any(|phase| phase == "expired"),
        fail_closed: engine
            .transcript
            .iter()
            .any(|line| line.output.contains("tx_fail_closed")),
        rejected_after_committing: watch.persist_committing
            && !watch.commit_emitted
            && replies
                .iter()
                .any(|(kind, reply)| kind.starts_with("commit") && rejects_commit(reply)),
    })
}

/// The generators reach every state the properties are about, so the properties are not
/// vacuous.
#[test]
fn generators_reach_every_outcome() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let mut runner = TestRunner::deterministic();
    let mut counts = [0usize; 6];
    for _ in 0..1_000 {
        let Ok(tree) = commit_path().new_tree(&mut runner) else {
            continue;
        };
        let Ok(reached) = run_reaching(&tree.current()) else {
            continue;
        };
        for (count, hit) in counts.iter_mut().zip([
            reached.commit,
            reached.committed,
            reached.unknown,
            reached.expired,
            reached.fail_closed,
            reached.rejected_after_committing,
        ]) {
            *count += usize::from(hit);
        }
    }
    eprintln!(
        "reached [commit, committed, unknown, expired, fail_closed, rejected_after_committing] in 1000 runs: {counts:?}"
    );
    assert!(counts.iter().all(|count| *count >= 10), "{counts:?}");
}

proptest! {
    #![proptest_config(common::proptest_config(1_000))]

    #[test]
    fn commit_safety_over_random_sequences(actions in prop::collection::vec(action(), 1..60)) {
        let mut actions = actions;
        actions.insert(0, Action::Begin(true));
        run_actions(&actions)?;
    }
}

/// Sequences that reach `committing` and then hit every adversarial outcome in turn.
fn commit_path() -> impl Strategy<Value = Vec<Action>> {
    let prefix = vec![
        Action::Begin(true),
        Action::Resolve { ok: true, class: 0 },
        Action::Resolve { ok: true, class: 0 },
        Action::Resolve { ok: true, class: 0 },
        Action::Resolve { ok: true, class: 0 },
        Action::Statement {
            offset: 0,
            sql: 1,
            alternate: false,
        },
        Action::Resolve { ok: true, class: 0 },
        Action::Resolve { ok: true, class: 0 },
        Action::Resolve { ok: true, class: 0 },
        Action::Commit { offset: 0 },
    ];
    prop::collection::vec(action(), 0..30).prop_map(move |tail| {
        let mut actions = prefix.clone();
        actions.extend(tail);
        actions
    })
}

proptest! {
    #![proptest_config(common::proptest_config(2_000))]

    #[test]
    fn commit_safety_from_committing(actions in commit_path()) {
        run_actions(&actions)?;
    }
}

/// A durable state reached by a valid run, as text.
fn reached(prefix: usize) -> (Engine, Option<String>) {
    let mut engine = Engine::new();
    engine.run(&begin("write"));
    if prefix > 0 {
        engine.run(&command(
            "statement",
            &json!({"sequence": 1, "sql": "INSERT INTO projects (id) VALUES (:id)", "params": {}})
                .to_string(),
        ));
    }
    if prefix > 1 {
        engine.run(&command("commit", &sequence_text(2)));
    }
    let store = engine.store.clone();
    (engine, store)
}

fn tamper(text: &str, how: u8, position: usize, value: i64) -> String {
    let mut parsed: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    match how {
        0 => {
            let mut bytes = text.as_bytes().to_vec();
            let index = position % bytes.len().max(1);
            if let Some(byte) = bytes.get_mut(index) {
                *byte = byte.wrapping_add(u8::try_from(value.rem_euclid(255) + 1).unwrap_or(1));
            }
            return String::from_utf8_lossy(&bytes).into_owned();
        }
        1 => {
            parsed["phase"] = json!(
                [
                    "active",
                    "validating",
                    "committing",
                    "committed",
                    "rolled_back",
                    "failed",
                    "expired",
                    "commit_unknown",
                    "discarded",
                    "bogus"
                ][position % 10]
            );
        }
        2 => parsed["nextSequence"] = json!(value),
        3 => parsed["owner"] = json!(format!("tx_{:032x}", position)),
        4 => parsed["v"] = json!(value),
        5 => parsed["expiresAtMs"] = json!(value),
        6 => {
            if let Some(object) = parsed.as_object_mut() {
                let keys: Vec<String> = object.keys().cloned().collect();
                if let Some(key) = keys.get(position % keys.len().max(1)) {
                    object.remove(key);
                }
            }
        }
        7 => parsed["counters"]["statements"] = json!(value),
        8 => parsed["identity"]["replay"] = json!("0".repeat(64)),
        _ => parsed["extra"] = json!(value),
    }
    parsed.to_string()
}

proptest! {
    #![proptest_config(common::proptest_config(1_000))]

    /// Tampered durable state is discarded or behaves as some valid state; it never yields a
    /// COMMIT, and a commit against a discarded record is always outcome-unknown.
    #[test]
    fn tampered_durable_state_fails_closed(
        prefix in 0usize..3,
        how in 0u8..10,
        position in any::<usize>(),
        value in -3i64..10_000_000_000_000,
        commit_sequence in 1u64..5,
    ) {
        let (_, store) = reached(prefix);
        let Some(text) = store else { return Ok(()); };
        let tampered = tamper(&text, how, position, value);
        let mut engine = Engine::new();
        engine.store = Some(tampered.clone());
        engine.durable = Some(tampered.clone());
        let readable = policysql_transaction::machine::Durable::parse(&tampered, OWNER).is_ok();
        let output = engine.feed(&command("commit", &sequence_text(commit_sequence)));
        let effects = output["effects"].as_array().cloned().unwrap_or_default();
        prop_assert!(effects.iter().all(|effect| effect["type"] != "commit"));
        if !readable {
            prop_assert_eq!(effects[0]["record"]["event"].as_str(), Some("tx_state_discarded"));
            let reply = effects.iter().find(|effect| effect["type"] == "respond").map(|effect| effect["reply"].clone()).unwrap_or_default();
            prop_assert_eq!(code(&reply), Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"));
        }
        engine.settle();
        prop_assert_eq!(engine.observed.commits_emitted, 0, "a tampered record never commits");
        // Other events on the tampered record never commit or panic either.
        for event in [json!({"type": "timerFired"}), json!({"type": "abandon"}), json!({"type": "persisted", "id": 1})] {
            let output = step_json(&FakeCompiler::new(), &LIMITS, Some(&tampered), None, &event.to_string(), &host());
            prop_assert!(!output.contains(r#""type":"commit""#), "{}", output);
        }
    }

    /// Arbitrary strings for all four inputs never panic and never commit.
    #[test]
    fn arbitrary_inputs_never_commit(
        durable in proptest::option::of(".{0,200}"),
        volatile in proptest::option::of(".{0,200}"),
        event in ".{0,200}",
        host_text in ".{0,200}",
    ) {
        let compiler = FakeCompiler::new();
        for host_input in [host_text.as_str(), &host()] {
            let output = step_json(&compiler, &LIMITS, durable.as_deref(), volatile.as_deref(), &event, host_input);
            prop_assert!(!output.contains(r#""type":"commit""#));
        }
    }

    /// A second command with the same digest replays; a different payload at that sequence
    /// conflicts (ADR 0007).
    #[test]
    fn exact_retry_replays_and_a_different_payload_conflicts(
        sql in 0usize..4,
        first in "[a-z]{1,8}",
        second in "[a-z]{1,8}",
        spacing in any::<bool>(),
    ) {
        let mut engine = Engine::new();
        engine.run(&begin("write"));
        let text = json!({"sequence": 1, "sql": SQL[sql], "params": {"id": first}}).to_string();
        let reply = engine.run(&command("statement", &text));
        prop_assert_eq!(&reply["ok"], &json!(true));
        // The same command with other whitespace and key order is the same canonical payload.
        let respelled = if spacing {
            format!(r#"{{ "params": {{"id": {}}}, "sql": {}, "sequence": 1.0 }}"#, json!(first), json!(SQL[sql]))
        } else {
            text.clone()
        };
        prop_assert_eq!(engine.run(&command("statement", &respelled)), reply);
        let other = json!({"sequence": 1, "sql": SQL[sql], "params": {"id": second}}).to_string();
        let answer = engine.run(&command("statement", &other));
        if first == second {
            prop_assert_eq!(&answer["ok"], &json!(true));
        } else {
            prop_assert_eq!(code(&answer), Some("POLICYSQL_TRANSACTION_CONFLICT"));
        }
        let commit = engine.run(&command("commit", &sequence_text(2)));
        if first == second {
            prop_assert_eq!(&engine.run(&command("commit", &sequence_text(2))), &commit);
        }
    }

    /// Expiry races: a timer and clock jumps around the deadline at every point of a commit
    /// never leave a COMMIT after the deadline or a rejection after COMMIT.
    #[test]
    fn expiry_races_around_commit(
        steps in 0usize..6,
        jump in prop_oneof![3_990u64..4_010, 0u64..100],
        timer in any::<bool>(),
    ) {
        let mut engine = Engine::new();
        engine.run(&begin("write"));
        engine.feed(&command("commit", &sequence_text(1)));
        let mut watch = Watch::default();
        for index in 0..8 {
            if index == steps {
                engine.now += jump;
                if timer {
                    let outstanding = engine.outstanding.clone();
                    feed_checked(&mut engine, &json!({"type": "timerFired"}))?;
                    if engine.outstanding.is_none() {
                        engine.outstanding = outstanding;
                    }
                }
            }
            engine.resolve(true, "unknown");
            check(&engine, &mut watch)?;
        }
        let retry = engine.run(&command("commit", &sequence_text(1)));
        if watch.commit_emitted {
            prop_assert!(!rejects_commit(&retry), "{}", retry);
        }
    }
}

fn host() -> String {
    json!({"nowMs": common::T0, "entropy": "1".repeat(64), "requestId": "req", "owner": OWNER})
        .to_string()
}

proptest! {
    #![proptest_config(common::proptest_config(500))]

    /// A statement whose completion cannot be stored is not recorded as done: the record
    /// moves to `failed` from the state before it, and a retry of that statement gets the
    /// same answer from this owner and from a successor (never the statement's reply).
    #[test]
    fn a_statement_whose_completion_is_not_stored_is_never_replayed(
        before in 0u64..4,
        sql in 0usize..3,
        lose in any::<bool>(),
    ) {
        let mut engine = Engine::new();
        engine.run(&begin("write"));
        for sequence in 1..=before {
            let text = json!({"sequence": sequence, "sql": SQL[0], "params": {}}).to_string();
            prop_assert_eq!(&engine.run(&command("statement", &text))["ok"], &json!(true));
        }
        let sequence = before + 1;
        let text = json!({"sequence": sequence, "sql": SQL[sql], "params": {"id": "a"}}).to_string();
        engine.feed(&command("statement", &text));
        engine.resolve(true, "unknown"); // binding checked
        engine.resolve(true, "unknown"); // executed -> Persist(completion)
        engine.resolve(false, "unknown"); // PersistFailed -> rollback, Persist(failed)
        engine.settle();
        let reply = engine.last_reply().cloned().unwrap_or_default();
        prop_assert_eq!(code(&reply), Some("POLICYSQL_INTERNAL"));
        let stored: Value = serde_json::from_str(engine.store.as_deref().unwrap_or("null")).unwrap_or_default();
        prop_assert_eq!(stored["phase"].as_str(), Some("failed"));
        prop_assert_eq!(stored["nextSequence"].as_u64(), Some(sequence), "the statement is not recorded");
        if lose {
            engine.lose();
        }
        let retry = engine.run(&command("statement", &text));
        prop_assert_eq!(code(&retry), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"), "{}", retry);
        prop_assert_eq!(engine.compiler.live_handles(), 0);
    }
}
