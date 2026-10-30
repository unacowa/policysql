//! Properties of `step` with commit checks and callbacks (ADR 0024 "Testing strategy", pull
//! request 5), over random event sequences that reach a validator call and then interleave
//! verdicts (allow, deny, malformed, failed, late), callback queries (with the real, a
//! tampered, or a revoked capability; in and out of sequence; reads, mutations, and bad SQL),
//! callback outcomes, timers and clock jumps, owner loss, `Abandon`, duplicated, stale, and
//! held outcomes, and invalid volatile state.
#![allow(clippy::too_many_lines, clippy::struct_excessive_bools)]

mod common;

use common::{Engine, LIMITS, begin, code, command, phase_of, rejects_commit, sequence_text};
use policysql_transaction::machine::step_json;
use proptest::prelude::*;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Rows per callback query (the fake execute returns one) and the limit the runs use.
const MAX_CALLBACK_ROWS: u64 = 1;

#[derive(Clone, Debug)]
enum Action {
    /// A callback query: which capability (0 the live one, 1 tampered, 2 the previous
    /// validator's), sequence offset from the next, and SQL (0 read, 1 mutation, 2 bad).
    Callback {
        token: u8,
        offset: i8,
        sql: u8,
        whole: bool,
    },
    ResolveCallback {
        ok: bool,
        class: u8,
    },
    /// Run the client lane's outstanding effect (a validator call succeeds with an allow).
    Resolve {
        ok: bool,
        class: u8,
    },
    /// Answer the validator: 0 deny, 1 malformed, 2 non-2xx, 3 allow, 4 an allow addressed to
    /// the previous validator's id (or an id never issued): stale, it must not advance.
    Decide(u8),
    Timer,
    Advance(u16),
    Lose,
    Abandon,
    /// Hold the client lane's outstanding effect and feed its outcome later.
    Hold,
    Release,
    Duplicate,
    Stale {
        delta: u8,
    },
    CorruptVolatile,
    /// A second commit at the commit's sequence (a retry; the lane is serialized, so it is
    /// sent only when no reply is awaited).
    RetryCommit,
    /// Run the client lane's effects to completion, all succeeding.
    Settle,
}

fn action() -> impl Strategy<Value = Action> {
    prop_oneof![
        10 => (prop_oneof![8 => Just(0u8), 1 => Just(1u8), 1 => Just(2u8)], prop_oneof![8 => Just(0i8), 1 => Just(-1i8), 1 => Just(1i8)], prop_oneof![8 => Just(0u8), 1 => Just(1u8), 1 => Just(2u8)], prop::bool::weighted(0.75)).prop_map(|(token, offset, sql, whole)| Action::Callback { token, offset, sql, whole }),
        6 => (prop::bool::weighted(0.92), 0u8..6).prop_map(|(ok, class)| Action::ResolveCallback { ok, class }),
        6 => (prop::bool::weighted(0.9), 0u8..6).prop_map(|(ok, class)| Action::Resolve { ok, class }),
        4 => (0u8..5).prop_map(Action::Decide),
        2 => Just(Action::Timer),
        2 => prop_oneof![0u16..50, 900u16..1_100, 3_900u16..4_100].prop_map(Action::Advance),
        1 => Just(Action::Lose),
        1 => Just(Action::Abandon),
        2 => Just(Action::Hold),
        1 => Just(Action::Release),
        1 => Just(Action::Duplicate),
        1 => (0u8..4).prop_map(|delta| Action::Stale { delta }),
        1 => Just(Action::CorruptVolatile),
        1 => Just(Action::RetryCommit),
        1 => Just(Action::Settle),
    ]
}

const CLASSES: [&str; 6] = [
    "timeout",
    "unavailable",
    "rejected",
    "not_committed",
    "unknown",
    "limit",
];

/// What the properties remember across the run.
#[derive(Default)]
struct Watch {
    commit_emitted: bool,
    /// Checks the commit triggers, validator calls emitted, and allowing verdicts fed for them.
    checks: usize,
    validator_calls: usize,
    allowed_verdicts: BTreeSet<u64>,
    /// Transcript index of the last allowing verdict and of the last allowed binding check.
    last_allow: Option<usize>,
    last_binding_ok: Option<usize>,
    /// Ids of every validator call, and those whose verdict was fed.
    validator_ids: Vec<u64>,
    decided: BTreeSet<u64>,
    /// Tokens of every validator call, in order.
    tokens: Vec<String>,
    /// The token the callback query in progress presented.
    query_token: Option<String>,
    /// Connection effects (execute, commit, rollback) in flight.
    connection: BTreeSet<u64>,
    /// Successful callback replies per token (distinct sequences).
    callback_rows: BTreeMap<String, BTreeSet<u64>>,
    corrupted: bool,
    handles_unknown: bool,
    replies_seen: usize,
    callback_replies_seen: usize,
    lines_seen: usize,
    /// The last callback query's token and sequence, for matching its reply.
    query: Option<(String, u64)>,
}

fn is_connection(effect: &Value) -> bool {
    matches!(
        effect["type"].as_str(),
        Some("execute" | "commit" | "rollback")
    )
}

fn feed_checked(
    engine: &mut Engine,
    watch: &mut Watch,
    event: &Value,
) -> Result<(), TestCaseError> {
    let shadow = engine.compiler.clone();
    let callback_before = engine
        .volatile
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|volatile| volatile["callback"]["pending"]["id"].as_u64());
    if let Some(id) = event["id"].as_u64() {
        watch.connection.remove(&id);
        if event["type"] == "validatorReplied" || event["type"] == "validatorFailed" {
            // Only the first verdict for the latest validator counts; a stale or repeated one
            // is ignored by the model, as the machine must ignore it.
            let fresh = watch.validator_ids.last() == Some(&id) && !watch.decided.contains(&id);
            watch.decided.insert(id);
            let allows = event["ok"] == true
                && event["decision"] == json!({"version": "1", "allowed": true});
            if allows && fresh {
                watch.allowed_verdicts.insert(id);
                watch.last_allow = Some(engine.transcript.len());
            }
        }
        if event["type"] == "bindingChecked"
            && event["allowed"] == true
            && callback_before != Some(id)
        {
            watch.last_binding_ok = Some(engine.transcript.len());
        }
    }
    engine.feed(event);
    let line = engine
        .transcript
        .last()
        .cloned()
        .ok_or_else(|| TestCaseError::fail("no line"))?;
    // Determinism: the same inputs give the same output bytes.
    let again = step_json(
        &shadow,
        &engine.limits,
        line.durable.as_deref(),
        line.volatile.as_deref(),
        &line.event,
        &line.host,
    );
    prop_assert_eq!(&again, &line.output);
    check(engine, watch)
}

fn check(engine: &Engine, watch: &mut Watch) -> Result<(), TestCaseError> {
    let fresh = engine.transcript.len() > watch.lines_seen;
    watch.lines_seen = engine.transcript.len();
    let effects: Vec<Value> = if fresh {
        engine.last_effects.clone()
    } else {
        Vec::new()
    };
    let callback_pending = engine
        .volatile
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|volatile| volatile["callback"]["pending"]["id"].as_u64());
    for effect in &effects {
        if effect["record"]["event"] == "tx_fail_closed" {
            let reason = effect["record"]["reason"].as_str().unwrap_or("");
            prop_assert!(
                reason == "outcome_not_pending"
                    || (reason == "volatile_invalid" && watch.corrupted),
                "fail closed: {}",
                reason
            );
        }
        if is_connection(effect) {
            // One effect on the connection at a time.
            prop_assert!(
                watch.connection.is_empty(),
                "two effects on the connection: {}",
                effect
            );
            if let Some(id) = effect["id"].as_u64() {
                watch.connection.insert(id);
            }
        }
        match effect["type"].as_str() {
            Some("callValidator") => {
                // Checks run in ascending id order, each once, and the next one only after the
                // previous one allowed.
                let expected = CHECK_IDS.get(watch.validator_calls).copied();
                prop_assert_eq!(effect["check"].as_str(), expected, "check order");
                prop_assert!(
                    watch
                        .validator_ids
                        .iter()
                        .all(|id| watch.allowed_verdicts.contains(id)),
                    "the next validator before the previous one allowed"
                );
                watch.validator_calls += 1;
                if let Some(id) = effect["id"].as_u64() {
                    watch.validator_ids.push(id);
                }
                watch.tokens.push(
                    effect["capability"]["token"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned(),
                );
            }
            Some("execute") if callback_pending == effect["id"].as_u64() => {
                // A callback query executes only with the live capability: the latest
                // validator's token, before that validator's verdict.
                prop_assert_eq!(
                    watch.query_token.as_deref(),
                    watch.tokens.last().map(String::as_str)
                );
                let latest = watch.validator_ids.last().copied();
                prop_assert!(
                    latest.is_some_and(|id| !watch.decided.contains(&id)),
                    "callback after the verdict"
                );
            }
            Some("commit") => {
                prop_assert!(!watch.commit_emitted, "a second COMMIT");
                let stored = phase_of(engine.store.as_deref());
                prop_assert_eq!(stored.as_deref(), Some("committing"));
                // The commit's mutation triggers the check: every validator called allowed,
                // and the binding was checked after the last allow.
                prop_assert_eq!(
                    watch.validator_calls,
                    watch.checks,
                    "COMMIT without every check called"
                );
                prop_assert!(
                    watch
                        .validator_ids
                        .iter()
                        .all(|id| watch.allowed_verdicts.contains(id)),
                    "COMMIT without every check allowed"
                );
                prop_assert!(
                    watch.last_binding_ok > watch.last_allow,
                    "COMMIT without a binding check after the last validator"
                );
                watch.commit_emitted = true;
            }
            _ => {}
        }
        if effect["type"] == "checkBinding" && callback_pending == effect["id"].as_u64() {
            // The callback lane runs one query at a time: this one's token.
            watch.query_token = watch.query.as_ref().map(|(token, _)| token.clone());
        }
    }
    for reply in &engine.observed.callback_replies[watch.callback_replies_seen..] {
        if reply["ok"] == true
            && let Some((token, sequence)) = watch.query.clone()
        {
            let rows = watch.callback_rows.entry(token).or_default();
            rows.insert(sequence);
            prop_assert!(
                u64::try_from(rows.len()).unwrap_or(u64::MAX) <= MAX_CALLBACK_ROWS,
                "callback rows over the limit"
            );
        }
    }
    watch.callback_replies_seen = engine.observed.callback_replies.len();
    for (kind, reply) in &engine.observed.replies[watch.replies_seen..] {
        if kind == "commit:2" {
            if reply["value"]["status"] == "committed" {
                prop_assert!(engine.observed.committed_fed, "committed before Committed");
            }
            if rejects_commit(reply)
                && !(engine.observed.not_committed_fed && reply["value"]["status"] == "failed")
            {
                prop_assert!(!watch.commit_emitted, "a rejection after COMMIT: {}", reply);
            }
        }
    }
    watch.replies_seen = engine.observed.replies.len();
    if engine.volatile.is_none()
        && engine.outstanding.is_none()
        && engine.callback_outstanding.is_none()
        && !watch.handles_unknown
    {
        prop_assert_eq!(
            engine.compiler.live_handles(),
            0,
            "a handle was not released"
        );
    }
    Ok(())
}

/// The ids of the triggered checks, in the order they must run.
const CHECK_IDS: [&str; 2] = ["consistency", "zeta"];

/// A write transaction with one insert into `projects` that triggers `checks` checks (1 or 2;
/// the second without a role), at its first validator call.
fn validating(checks: usize) -> Engine {
    let mut engine = Engine::new();
    engine.compiler.triggers.insert("projects".to_owned());
    if checks > 1 {
        // Listed out of order: the machine must run them by ascending id.
        let mut second = engine.compiler.checks[0].clone();
        CHECK_IDS[1].clone_into(&mut second.id);
        second.role = None;
        engine.compiler.checks.insert(0, second);
    }
    engine
        .compiler
        .checks
        .sort_by(|left, right| right.id.cmp(&left.id));
    engine.configured = CHECK_IDS[..checks]
        .iter()
        .map(|id| (*id).to_owned())
        .collect();
    engine.limits.max_callback_rows = MAX_CALLBACK_ROWS;
    engine.run(&begin("write"));
    let insert =
        json!({"sequence": 1, "sql": "INSERT INTO projects (id) VALUES (:id)", "params": {}});
    engine.run(&command("statement", &insert.to_string()));
    engine.feed(&command("commit", &sequence_text(2)));
    engine
}

fn next_callback_sequence(engine: &Engine) -> u64 {
    engine
        .volatile
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|volatile| volatile["capability"]["nextSequence"].as_u64())
        .unwrap_or(1)
}

fn run(checks: usize, actions: &[Action]) -> Result<Reached, TestCaseError> {
    let mut engine = validating(checks);
    let mut watch = Watch {
        checks,
        lines_seen: engine.transcript.len(),
        replies_seen: engine.observed.replies.len(),
        ..Watch::default()
    };
    let mut held: Option<Value> = None;
    let mut last_outcome: Option<Value> = None;
    let mut reached = Reached::default();
    for action in actions {
        match action {
            Action::Callback {
                token,
                offset,
                sql,
                whole,
            } => {
                let presented = match token {
                    0 => watch.tokens.last().cloned().unwrap_or_default(),
                    1 => "A".repeat(43),
                    _ => watch
                        .tokens
                        .iter()
                        .rev()
                        .nth(1)
                        .cloned()
                        .unwrap_or_else(|| "B".repeat(43)),
                };
                let sequence = next_callback_sequence(&engine)
                    .saturating_add_signed(i64::from(*offset))
                    .max(1);
                let sql =
                    ["SELECT id FROM projects", "DELETE FROM projects", "BAD"][usize::from(*sql)];
                let text = json!({"sequence": sequence, "sql": sql, "params": {}}).to_string();
                let event = json!({"type": "forwarded", "input": {
                    "kind": "callbackQuery", "validationId": format!("cval_{}", &common::OWNER[3..]),
                    "capability": presented, "command": text,
                }});
                if engine.callback_outstanding.is_none() {
                    watch.query = Some((presented.clone(), sequence));
                    feed_checked(&mut engine, &mut watch, &event)?;
                    // Usually the query runs to its reply before anything else happens.
                    for _ in 0..usize::from(*whole) * 2 {
                        if let Some(effect) = engine.callback_outstanding.take() {
                            let event = outcome(&effect, true, "unknown");
                            feed_checked(&mut engine, &mut watch, &event)?;
                        }
                    }
                }
            }
            Action::ResolveCallback { ok, class } => {
                if let Some(effect) = engine.callback_outstanding.take() {
                    let event = outcome(&effect, *ok, CLASSES[usize::from(*class)]);
                    last_outcome = Some(event.clone());
                    feed_checked(&mut engine, &mut watch, &event)?;
                }
            }
            Action::Resolve { ok, class } => {
                if let Some(effect) = engine.outstanding.take() {
                    let event = outcome(&effect, *ok, CLASSES[usize::from(*class)]);
                    if effect["type"] == "commit" {
                        if *ok {
                            engine.observed.committed_fed = true;
                        } else if CLASSES[usize::from(*class)] == "not_committed" {
                            engine.observed.not_committed_fed = true;
                        }
                    }
                    if effect["type"] == "persist" {
                        persist(&mut engine, *ok);
                    }
                    last_outcome = Some(event.clone());
                    feed_checked(&mut engine, &mut watch, &event)?;
                }
            }
            Action::Decide(4) => {
                // A verdict for an id that is not the awaited validator's: the previous
                // validator's (already decided) or one never issued.
                let id = match watch.validator_ids.as_slice() {
                    [.., previous, _] => *previous,
                    _ => {
                        engine
                            .outstanding
                            .as_ref()
                            .and_then(|effect| effect["id"].as_u64())
                            .unwrap_or(1)
                            + 100
                    }
                };
                reached.stale = true;
                let event = json!({"type": "validatorReplied", "id": id, "ok": true,
                    "decision": {"version": "1", "allowed": true}});
                let (outstanding, callback) = (
                    engine.outstanding.clone(),
                    engine.callback_outstanding.clone(),
                );
                feed_checked(&mut engine, &mut watch, &event)?;
                if engine.volatile.is_some() {
                    engine.outstanding = engine.outstanding.take().or(outstanding);
                    engine.callback_outstanding = engine.callback_outstanding.take().or(callback);
                }
            }
            Action::Decide(kind) => {
                if let Some(effect) = engine.outstanding.clone()
                    && effect["type"] == "callValidator"
                {
                    engine.outstanding = None;
                    let (ok, decision) = match kind {
                        0 => (true, json!({"version": "1", "allowed": false})),
                        1 => (
                            true,
                            json!({"version": "1", "allowed": true, "extra": true}),
                        ),
                        2 => (false, json!({"version": "1", "allowed": true})),
                        _ => (true, json!({"version": "1", "allowed": true})),
                    };
                    let event = json!({"type": "validatorReplied", "id": effect["id"], "ok": ok, "decision": decision});
                    last_outcome = Some(event.clone());
                    feed_checked(&mut engine, &mut watch, &event)?;
                }
            }
            Action::Timer => {
                let outstanding = engine.outstanding.clone();
                feed_checked(&mut engine, &mut watch, &json!({"type": "timerFired"}))?;
                // The timer does not answer an awaited effect: it stays in flight.
                if engine.outstanding.is_none() && engine.volatile.is_some() {
                    engine.outstanding = outstanding;
                }
            }
            Action::Advance(ms) => engine.now += u64::from(*ms),
            Action::Lose => {
                engine.lose();
                watch.connection.clear();
                held = None;
            }
            Action::Abandon => {
                feed_checked(&mut engine, &mut watch, &json!({"type": "abandon"}))?;
                if engine
                    .outstanding
                    .as_ref()
                    .is_some_and(|effect| effect["type"] == "persist")
                {
                    engine.store = engine.persist_text.take();
                }
                engine.lose();
                watch.connection.clear();
                held = None;
            }
            Action::Hold => {
                if held.is_none() {
                    held = engine.outstanding.take();
                }
            }
            Action::Release => {
                if let Some(effect) = held.take() {
                    let event = outcome(&effect, true, "unknown");
                    if effect["type"] == "commit" {
                        engine.observed.committed_fed = true;
                    }
                    if effect["type"] == "persist" {
                        persist(&mut engine, true);
                    }
                    reached.late |= effect["type"] == "callValidator";
                    feed_checked(&mut engine, &mut watch, &event)?;
                }
            }
            Action::Duplicate => {
                if let Some(event) = last_outcome.clone() {
                    let (outstanding, callback) = (
                        engine.outstanding.clone(),
                        engine.callback_outstanding.clone(),
                    );
                    feed_checked(&mut engine, &mut watch, &event)?;
                    if engine.volatile.is_some() {
                        engine.outstanding = engine.outstanding.take().or(outstanding);
                        engine.callback_outstanding =
                            engine.callback_outstanding.take().or(callback);
                    }
                }
            }
            Action::Stale { delta } => {
                let base = engine
                    .outstanding
                    .as_ref()
                    .and_then(|effect| effect["id"].as_u64())
                    .unwrap_or(1);
                let id = base + 2 + u64::from(*delta);
                let event = match delta {
                    0 => {
                        json!({"type": "validatorReplied", "id": id, "ok": true, "decision": {"version": "1", "allowed": true}})
                    }
                    1 => json!({"type": "executed", "id": id, "results": []}),
                    2 => json!({"type": "bindingChecked", "id": id, "allowed": true}),
                    _ => json!({"type": "committed", "id": id}),
                };
                let (outstanding, callback) = (
                    engine.outstanding.clone(),
                    engine.callback_outstanding.clone(),
                );
                feed_checked(&mut engine, &mut watch, &event)?;
                if engine.volatile.is_some() {
                    engine.outstanding = engine.outstanding.take().or(outstanding);
                    engine.callback_outstanding = engine.callback_outstanding.take().or(callback);
                }
            }
            Action::CorruptVolatile => {
                if let Some(text) = engine.volatile.as_mut() {
                    text.truncate(text.len() / 2);
                    watch.corrupted = true;
                    watch.handles_unknown = true;
                    feed_checked(&mut engine, &mut watch, &json!({"type": "timerFired"}))?;
                    watch.corrupted = false;
                    watch.connection.clear();
                }
            }
            Action::Settle => {
                for _ in 0..8 {
                    let Some(effect) = engine.outstanding.take() else {
                        break;
                    };
                    let event = outcome(&effect, true, "unknown");
                    if effect["type"] == "commit" {
                        engine.observed.committed_fed = true;
                    }
                    if effect["type"] == "persist" {
                        persist(&mut engine, true);
                    }
                    feed_checked(&mut engine, &mut watch, &event)?;
                }
            }
            Action::RetryCommit => {
                if engine.waiting.is_empty() {
                    feed_checked(
                        &mut engine,
                        &mut watch,
                        &command("commit", &sequence_text(2)),
                    )?;
                }
            }
        }
    }
    reached.validated = watch.validator_calls > 0;
    reached.second = watch.validator_calls > 1;
    reached.second_committed = watch.validator_calls > 1 && watch.commit_emitted;
    reached.callback = engine
        .observed
        .callback_replies
        .iter()
        .any(|reply| reply["ok"] == true);
    reached.committed = engine
        .observed
        .replies
        .iter()
        .any(|(_, reply)| reply["value"]["status"] == "committed");
    reached.rejected = engine
        .observed
        .replies
        .iter()
        .any(|(_, reply)| code(reply) == Some("POLICYSQL_COMMIT_CHECK_REJECTED"));
    reached.limit = engine
        .observed
        .callback_replies
        .iter()
        .any(|reply| code(reply) == Some("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED"));
    if let Some(text) = &engine.store {
        prop_assert!(
            policysql_transaction::machine::Durable::parse(text, common::OWNER).is_ok(),
            "{}",
            text
        );
    }
    Ok(reached)
}

/// The engine model's Persist outcome: the store takes the text on success.
fn persist(engine: &mut Engine, ok: bool) {
    if ok {
        engine.store = engine.persist_text.take();
        if let Some(phase) = phase_of(engine.store.as_deref()) {
            engine.observed.stored_phases.push(phase);
        }
    } else {
        engine.persist_text = None;
    }
}

/// The outcome event of an effect.
fn outcome(effect: &Value, ok: bool, class: &str) -> Value {
    let id = effect["id"].clone();
    match (effect["type"].as_str(), ok) {
        (Some("checkBinding"), true) => {
            json!({"type": "bindingChecked", "id": id, "allowed": true})
        }
        (Some("checkBinding"), false) => {
            json!({"type": "bindingCheckFailed", "id": id, "class": class})
        }
        (Some("execute"), true) => {
            let select = effect["statements"][0]["sql"]
                .as_str()
                .unwrap_or("")
                .starts_with("SELECT");
            json!({"type": "executed", "id": id, "results": [{
                "columns": if select { json!(["id"]) } else { json!([]) },
                "rows": if select { json!([["p1"]]) } else { json!([]) },
                "rowsAffected": i32::from(!select),
                "usage": {"rowsRead": 1, "rowsWritten": 0, "queryDurationMs": 0.5},
            }]})
        }
        (Some("execute"), false) => json!({"type": "executeFailed", "id": id, "class": class}),
        (Some("commit"), true) => json!({"type": "committed", "id": id}),
        (Some("commit"), false) => json!({"type": "commitFailed", "id": id, "class": class}),
        (Some("rollback"), true) => json!({"type": "rolledBack", "id": id}),
        (Some("rollback"), false) => json!({"type": "rollbackFailed", "id": id, "class": class}),
        (Some("persist"), true) => json!({"type": "persisted", "id": id}),
        (Some("persist"), false) => json!({"type": "persistFailed", "id": id}),
        (Some("setTimer"), true) => json!({"type": "timerSet", "id": id}),
        (Some("setTimer"), false) => json!({"type": "timerFailed", "id": id}),
        (Some("callValidator"), true) => {
            json!({"type": "validatorReplied", "id": id, "ok": true, "decision": {"version": "1", "allowed": true}})
        }
        _ => json!({"type": "validatorFailed", "id": id, "class": class}),
    }
}

#[derive(Debug, Default)]
struct Reached {
    validated: bool,
    callback: bool,
    committed: bool,
    rejected: bool,
    limit: bool,
    late: bool,
    stale: bool,
    second: bool,
    second_committed: bool,
}

/// One or two triggered checks, then actions after reaching the first validator call
/// (binding check, then `validating` stored).
fn path() -> impl Strategy<Value = (usize, Vec<Action>)> {
    let prefix = vec![
        Action::Resolve { ok: true, class: 0 },
        Action::Resolve { ok: true, class: 0 },
    ];
    (1usize..=2, prop::collection::vec(action(), 0..50)).prop_map(move |(checks, tail)| {
        let mut actions = prefix.clone();
        actions.extend(tail);
        (checks, actions)
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 3_000, ..ProptestConfig::default() })]

    #[test]
    fn commit_checks_and_callbacks_are_safe((checks, actions) in path()) {
        run(checks, &actions)?;
    }
}

/// The generator reaches every outcome the properties are about.
#[test]
fn the_generator_reaches_every_outcome() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let mut runner = TestRunner::deterministic();
    let mut counts = [0usize; 9];
    for _ in 0..1_000 {
        let Ok(tree) = path().new_tree(&mut runner) else {
            continue;
        };
        let (checks, actions) = tree.current();
        let Ok(reached) = run(checks, &actions) else {
            continue;
        };
        for (count, hit) in counts.iter_mut().zip([
            reached.validated,
            reached.callback,
            reached.committed,
            reached.rejected,
            reached.limit,
            reached.late,
            reached.stale,
            reached.second,
            reached.second_committed,
        ]) {
            *count += usize::from(hit);
        }
    }
    eprintln!(
        "reached [validated, callback, committed, rejected, limit, late, stale, second check, committed after two checks] in 1000 runs: {counts:?}"
    );
    assert!(counts.iter().all(|count| *count >= 10), "{counts:?}");
}

#[test]
fn limits_are_the_shared_defaults() {
    assert_eq!(LIMITS.max_callback_rows, 100);
}
