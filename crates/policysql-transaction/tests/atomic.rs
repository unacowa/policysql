//! Atomic execution in the step machine (ADR 0024 pull request 6): the direct placement in the
//! engine and the owner placement with commit checks, keyed and unkeyed, replay, conflict,
//! rollback on a failed expectation, the cumulative result limits, and COMMIT outcomes.

mod common;

use common::{
    Engine, OWNER, STATEMENT_LIMITS, T0, atomic_input, code, envelope, execute_request, phase_of,
};
use policysql_transaction::machine::StatementLimits;
use serde_json::{Value, json};

const KEY: &str = "request-key-0001";
const KEY_HASH: &str = "0123456789abcdef0123456789abcdef00000000000000000000000000000000";
const FINGERPRINT: &str = "f00df00df00df00df00df00df00df00df00df00df00df00df00df00df00df00d";

fn select() -> Value {
    envelope(&[("SELECT id, name FROM projects", json!({}))])
}

fn insert(id: &str) -> Value {
    envelope(&[(
        "INSERT INTO projects (id, name) VALUES (:id, :name)",
        json!({"id": id, "name": id}),
    )])
}

fn audit(id: &str) -> Value {
    envelope(&[(
        "INSERT INTO audited (id, note) VALUES (:id, :note)",
        json!({"id": id, "note": id}),
    )])
}

fn types(engine: &Engine) -> Vec<String> {
    engine.observed.awaited.clone()
}

#[test]
fn a_direct_read_runs_in_the_engine_without_persist_or_timer() {
    let mut engine = Engine::atomic(false);
    let reply = engine.run(&execute_request(&select(), Some(KEY)));
    assert_eq!(reply["ok"], true, "{reply}");
    let value = &reply["value"];
    assert_eq!(value["status"], "committed");
    assert_eq!(value["transactionId"], "atomic_req_1");
    assert_eq!(value["meta"]["requestId"], "req_1");
    assert_eq!(value["meta"]["commitChecks"], "not_triggered");
    assert_eq!(value["meta"]["role"], "member");
    assert_eq!(
        value["results"][0]["rows"],
        json!([{"id": "p1", "name": "safe"}])
    );
    assert!(value["results"][0].get("sequence").is_none());
    // A read envelope ignores the key: no lookup, no row.
    assert_eq!(
        types(&engine),
        ["checkBinding", "open", "execute", "commit"]
    );
    assert!(engine.store.is_none() && engine.durable.is_none() && engine.volatile.is_none());
    assert_eq!(engine.compiler.live_handles(), 0);
    // The committed envelope is observed after the reply.
    let observe = engine.transcript.iter().rev().find_map(|line| {
        let output: Value = serde_json::from_str(&line.output).ok()?;
        output["effects"]
            .as_array()?
            .iter()
            .find(|effect| effect["type"] == "observe")
            .cloned()
    });
    let observe = observe.unwrap_or(Value::Null);
    assert_eq!(
        observe["statements"][0]["sql"],
        "EXPLAIN QUERY PLAN SELECT id, name FROM projects"
    );
    assert_eq!(observe["context"]["statements"][0]["operation"], "select");
}

#[test]
fn a_keyed_write_looks_up_inserts_its_row_in_the_same_transaction_and_replays() {
    let mut engine = Engine::atomic(false);
    let first = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(
        types(&engine),
        [
            "checkBinding",
            "open",
            "execute",
            "execute",
            "execute",
            "commit"
        ]
    );
    assert_eq!(engine.idempotency_rows.len(), 1);
    let stored: Value = serde_json::from_str(&engine.idempotency_rows[0][2]).unwrap_or(Value::Null);
    assert_eq!(stored["version"], 1);
    assert_eq!(stored["status"], "committed");
    assert_eq!(stored["originalRequestId"], "req_1");
    assert_eq!(stored["commitChecks"], "not_triggered");
    let transaction_id = first["value"]["transactionId"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    assert!(transaction_id.starts_with("atomic_") && transaction_id.len() == 7 + 24);

    // The retry with the same key and body replays: rolled back, nothing executes again.
    engine.observed.awaited.clear();
    let replay = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(
        replay["value"]["results"], first["value"]["results"],
        "{replay}"
    );
    assert_eq!(
        replay["value"]["transactionId"],
        first["value"]["transactionId"]
    );
    assert_eq!(
        replay["value"]["meta"]["requestId"], "req_1",
        "the original request id"
    );
    assert_eq!(
        types(&engine),
        ["checkBinding", "open", "execute", "rollback"]
    );
    assert_eq!(engine.observed.envelope_executes, 1);
    assert_eq!(engine.observed.commits_emitted, 1);

    // The same key with another body conflicts, before anything executes.
    let conflict = engine.run(&execute_request(&insert("p2"), Some(KEY)));
    assert_eq!(code(&conflict), Some("POLICYSQL_IDEMPOTENCY_CONFLICT"));
    assert_eq!(engine.observed.envelope_executes, 1);
    assert_eq!(engine.observed.commits_emitted, 1);
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn duplicate_rows_and_a_malformed_stored_record_are_internal() {
    let mut engine = Engine::atomic(false);
    engine.run(&execute_request(&insert("p1"), Some(KEY)));
    let row = engine.idempotency_rows[0].clone();
    engine.idempotency_rows.push(row.clone());
    let duplicate = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(code(&duplicate), Some("POLICYSQL_INTERNAL"));
    for stored in [
        "{",
        r#"{"version":2}"#,
        r#"{"version":1,"transactionId":"tx_1","results":[],"usage":{},"originalRequestId":"r"}"#,
        r#"{"version":1,"transactionId":"atomic_1","results":[],"usage":{},"originalRequestId":"r","status":"failed"}"#,
        r#"{"version":1,"transactionId":"atomic_1","results":[],"usage":{},"originalRequestId":"r","commitChecks":"maybe"}"#,
    ] {
        engine.idempotency_rows = vec![[row[0].clone(), row[1].clone(), stored.to_owned()]];
        let reply = engine.run(&execute_request(&insert("p1"), Some(KEY)));
        assert_eq!(code(&reply), Some("POLICYSQL_INTERNAL"), "{stored}");
    }
    // A row the TypeScript direct path wrote (no status, no commitChecks) still replays.
    engine.idempotency_rows = vec![[row[0].clone(), row[1].clone(),
        r#"{"version":1,"results":[{"x":1}],"usage":{},"originalRequestId":"old","transactionId":"atomic_old","replayed":false}"#.to_owned()]];
    let replay = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(replay["value"]["transactionId"], "atomic_old", "{replay}");
    assert_eq!(replay["value"]["results"], json!([{"x": 1}]));
    assert_eq!(replay["value"]["meta"]["commitChecks"], "not_triggered");
    assert_eq!(engine.observed.commits_emitted, 1);
}

#[test]
fn a_malformed_key_is_rejected_and_an_unkeyed_write_stores_nothing() {
    let mut engine = Engine::atomic(false);
    let bad = engine.run(&execute_request(&insert("p1"), Some("short")));
    assert_eq!(code(&bad), Some("POLICYSQL_IDEMPOTENCY_KEY_INVALID"));
    assert_eq!(engine.observed.commits_emitted, 0);
    let unkeyed = engine.run(&execute_request(&insert("p1"), None));
    assert!(
        unkeyed["value"]["transactionId"]
            .as_str()
            .is_some_and(|id| id.starts_with("atomic_req_")),
        "{unkeyed}"
    );
    assert_eq!(engine.idempotency_rows, Vec::<[String; 3]>::new());
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn a_failed_expectation_rolls_back_and_nothing_is_stored() {
    let mut engine = Engine::atomic(false);
    let body = json!({"statements": [{"sql": "INSERT INTO projects (id, name) VALUES (:id, :name)",
        "params": {"id": "p1", "name": "p1"}, "expect": {"affectedRows": 2}}]});
    let reply = engine.run(&execute_request(&body, Some(KEY)));
    assert_eq!(
        code(&reply),
        Some("POLICYSQL_EXPECTATION_FAILED"),
        "{reply}"
    );
    assert_eq!(engine.observed.commits_emitted, 0);
    assert_eq!(engine.observed.rollbacks_emitted, 1);
    assert!(engine.idempotency_rows.is_empty() && engine.pending_rows.is_empty());
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn the_strictest_statement_limits_apply_cumulatively() {
    // Two selected rows over a one-row limit.
    let mut engine = Engine::atomic(false);
    engine.compiler.limits = Some(StatementLimits {
        max_rows: 1,
        ..STATEMENT_LIMITS
    });
    let two = envelope(&[
        ("SELECT id, name FROM projects", json!({})),
        ("SELECT id, name FROM projects", json!({})),
    ]);
    assert_eq!(
        code(&engine.run(&execute_request(&two, None))),
        Some("POLICYSQL_LIMIT_EXCEEDED")
    );
    assert_eq!(engine.observed.rollbacks_emitted, 1);
    // `[{"id":"p1","name":"safe"}]` is 27 bytes.
    let mut engine = Engine::atomic(false);
    engine.compiler.limits = Some(StatementLimits {
        max_result_bytes: 26,
        ..STATEMENT_LIMITS
    });
    assert_eq!(
        code(&engine.run(&execute_request(&select(), None))),
        Some("POLICYSQL_LIMIT_EXCEEDED")
    );
    let mut engine = Engine::atomic(false);
    engine.compiler.limits = Some(StatementLimits {
        max_result_bytes: 27,
        ..STATEMENT_LIMITS
    });
    assert_eq!(engine.run(&execute_request(&select(), None))["ok"], true);
    // Elapsed time beyond the strictest timeout.
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&select(), None));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.now = T0 + 1_001;
    engine.settle();
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_TIMEOUT")
    );
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn a_commit_failure_is_never_a_rejection_and_rolls_back() {
    for (class, expected) in [
        ("timeout", "POLICYSQL_DATABASE_TIMEOUT"),
        ("unavailable", "POLICYSQL_DATABASE_UNAVAILABLE"),
        ("unknown", "POLICYSQL_INTERNAL"),
        ("rejected", "POLICYSQL_INTERNAL"),
    ] {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), Some(KEY)));
        for _ in 0..5 {
            engine.resolve(true, "unknown");
        }
        assert_eq!(
            engine
                .outstanding
                .as_ref()
                .map(|effect| effect["type"].clone()),
            Some(json!("commit"))
        );
        engine.resolve(false, class);
        engine.settle();
        assert_eq!(
            code(engine.last_reply().unwrap_or(&Value::Null)),
            Some(expected),
            "{class}"
        );
        assert_eq!(engine.observed.rollbacks_emitted, 1, "{class}");
        assert_eq!(engine.compiler.live_handles(), 0);
    }
}

/// ADR 0024 pull request 8: a result the adapter could not carry (`limit`) is the client's
/// `POLICYSQL_LIMIT_EXCEEDED` on the envelope, as the TypeScript direct path answered, and
/// `POLICYSQL_INTERNAL` on the idempotency lookup or insert, so a keyed request whose outcome
/// could not be read is never rejected (never `IDEMPOTENCY_CONFLICT`) and never runs again.
#[test]
fn a_limit_failure_is_limit_exceeded_on_the_envelope_and_internal_on_the_idempotency_row() {
    // Effects of a keyed write: checkBinding, open, lookup, envelope, insert, commit.
    for (successes, expected) in [
        (2, "POLICYSQL_INTERNAL"),
        (3, "POLICYSQL_LIMIT_EXCEEDED"),
        (4, "POLICYSQL_INTERNAL"),
    ] {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), Some(KEY)));
        for _ in 0..successes {
            engine.resolve(true, "unknown");
        }
        engine.resolve(false, "limit");
        engine.settle();
        assert_eq!(
            code(engine.last_reply().unwrap_or(&Value::Null)),
            Some(expected),
            "after {successes} effects"
        );
        assert_eq!(engine.observed.commits_emitted, 0);
        assert_eq!(engine.observed.rollbacks_emitted, 1);
        assert_eq!(engine.idempotency_rows, Vec::<[String; 3]>::new());
        assert_eq!(engine.compiler.live_handles(), 0);
    }
    // Unkeyed, the envelope's limit is the client's too.
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&insert("p1"), None));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.resolve(false, "limit");
    engine.settle();
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_LIMIT_EXCEEDED")
    );
}

#[test]
fn an_envelope_that_could_trigger_a_check_is_forwarded_and_its_reply_relayed() {
    let mut engine = Engine::atomic(false);
    engine.forward_reply =
        json!({"ok": true, "value": {"transactionId": "atomic_y", "status": "committed"}});
    let reply = engine.run(&execute_request(&audit("a1"), Some(KEY)));
    assert_eq!(reply["value"]["transactionId"], "atomic_y");
    assert_eq!(types(&engine), ["checkBinding", "forward"]);
    let forward = engine
        .transcript
        .iter()
        .find_map(|line| {
            let output: Value = serde_json::from_str(&line.output).ok()?;
            output["effects"]
                .as_array()?
                .iter()
                .find(|effect| effect["type"] == "forward")
                .cloned()
        })
        .unwrap_or(Value::Null);
    let input = &forward["input"];
    let key_hash = input["idempotency"]["keyHash"].as_str().unwrap_or("");
    assert_eq!(forward["owner"], format!("tx_{}", &key_hash[..32]));
    assert_eq!(input["validationId"], format!("cval_{}", &key_hash[..32]));
    assert_eq!(
        input["request"],
        audit("a1").to_string(),
        "the verified body text"
    );
    assert_eq!(engine.compiler.live_handles(), 0);
    // An unkeyed one gets a fresh owner from entropy; a reply of another shape is internal.
    engine.forward_reply = json!({"ok": true, "value": "x"});
    let malformed = engine.run(&execute_request(&audit("a2"), None));
    assert_eq!(code(&malformed), Some("POLICYSQL_INTERNAL"));
    engine.forward_reply = json!({"ok": false, "error": {"code": "POLICYSQL_COMMIT_CHECK_REJECTED", "message": "m", "path": null}});
    let rejected = engine.run(&execute_request(&audit("a3"), None));
    assert_eq!(code(&rejected), Some("POLICYSQL_COMMIT_CHECK_REJECTED"));
}

/// `TimerFired` beside the outstanding client-lane effect (the timer lane is not serialized).
fn fire_timer(engine: &mut Engine) {
    let outstanding = engine.outstanding.take();
    engine.feed(&json!({"type": "timerFired"}));
    if engine.outstanding.is_none() {
        engine.outstanding = outstanding;
    }
}

fn owner_engine() -> Engine {
    let mut engine = Engine::atomic(true);
    engine.configured = vec!["consistency".to_owned()];
    engine
}

#[test]
fn the_owner_runs_the_commit_check_then_checks_the_binding_and_commits_once() {
    let mut engine = owner_engine();
    let reply = engine.run(&atomic_input(&audit("a1"), Some([KEY_HASH, FINGERPRINT])));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["value"]["meta"]["commitChecks"], "passed");
    assert_eq!(
        reply["value"]["transactionId"],
        format!("atomic_{}", &KEY_HASH[..24])
    );
    assert_eq!(
        types(&engine),
        [
            "checkBinding",
            "open",
            "persist",
            "setTimer",
            "execute",
            "execute",
            "callValidator",
            "checkBinding",
            "execute",
            "commit",
            "persist"
        ]
    );
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("committed")
    );
    // Statements listed by their envelope index.
    assert_eq!(
        engine.observed.validator_calls[0]["payload"]["statements"],
        json!([{"index": 0, "type": "insert", "resource": "audited"}])
    );
    let stored: Value = serde_json::from_str(&engine.idempotency_rows[0][2]).unwrap_or(Value::Null);
    assert_eq!(stored["commitChecks"], "passed");

    // A keyed retry ignores the record and resolves through the row: no validator, no COMMIT.
    engine.observed.awaited.clear();
    let retried = engine.run(&atomic_input(&audit("a1"), Some([KEY_HASH, FINGERPRINT])));
    assert_eq!(retried["value"]["results"], reply["value"]["results"]);
    assert_eq!(retried["value"]["meta"]["commitChecks"], "passed");
    assert_eq!(
        types(&engine),
        [
            "checkBinding",
            "open",
            "persist",
            "setTimer",
            "execute",
            "rollback",
            "persist"
        ]
    );
    assert_eq!(engine.observed.commits_emitted, 1);
    assert_eq!(engine.observed.validator_calls.len(), 1);
    // Another fingerprint on the same key conflicts with the idempotency code.
    let other = "e".repeat(64);
    let conflict = engine.run(&atomic_input(&audit("a1"), Some([KEY_HASH, &other])));
    assert_eq!(code(&conflict), Some("POLICYSQL_IDEMPOTENCY_CONFLICT"));
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn the_owner_rejects_a_denied_or_unconfigured_check_before_commit() {
    let mut engine = owner_engine();
    engine.feed(&atomic_input(&audit("a1"), None));
    for _ in 0..5 {
        engine.resolve(true, "unknown");
    }
    engine.decide(true, &json!({"version": "1", "allowed": false}));
    engine.settle();
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
    assert_eq!(engine.observed.commits_emitted, 0);
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
    let mut engine = Engine::atomic(true);
    let reply = engine.run(&atomic_input(&audit("a1"), None));
    assert_eq!(code(&reply), Some("POLICYSQL_COMMIT_CHECK_REJECTED"));
    assert_eq!(engine.observed.validator_calls, Vec::<Value>::new());
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn the_owner_timer_ends_an_execution_and_never_a_commit_in_flight() {
    // During the envelope: no COMMIT, the record is expired.
    let mut engine = owner_engine();
    engine.feed(&atomic_input(&insert("p1"), None));
    for _ in 0..4 {
        engine.resolve(true, "unknown");
    }
    engine.now = T0 + 4_000;
    fire_timer(&mut engine);
    engine.settle();
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_TRANSACTION_UNAVAILABLE")
    );
    assert_eq!(engine.observed.commits_emitted, 0);
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    // While COMMIT is in flight: its outcome decides.
    let mut engine = owner_engine();
    engine.feed(&atomic_input(&insert("p1"), None));
    for _ in 0..6 {
        engine.resolve(true, "unknown");
    }
    assert_eq!(
        engine
            .outstanding
            .as_ref()
            .map(|effect| effect["type"].clone()),
        Some(json!("commit"))
    );
    engine.now = T0 + 5_000;
    fire_timer(&mut engine);
    engine.settle();
    assert_eq!(
        engine
            .last_reply()
            .map(|reply| reply["value"]["status"].clone()),
        Some(json!("committed"))
    );
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("committed")
    );
}

#[test]
fn the_owner_ignores_an_unreadable_record_and_runs() {
    let mut engine = owner_engine();
    engine.durable = Some(r#"{"status":"committing","commitSent":{"sequence":2}}"#.to_owned());
    engine.store = engine.durable.clone();
    let reply = engine.run(&atomic_input(&insert("p1"), None));
    assert_eq!(reply["ok"], true, "{reply}");
    assert!(engine.transcript[0].output.contains("tx_state_discarded"));
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("committed")
    );
}

#[test]
fn owner_inputs_are_validated() {
    let mut engine = owner_engine();
    let mut wrong = atomic_input(&insert("p1"), None);
    wrong["input"]["validationId"] = json!(format!("cval_{}", "f".repeat(32)));
    assert_eq!(code(&engine.run(&wrong)), Some("POLICYSQL_INVALID_REQUEST"));
    // A keyed input must run on the owner its key names.
    let elsewhere = format!("{}{}", "f".repeat(32), "0".repeat(32));
    assert_eq!(
        code(&engine.run(&atomic_input(
            &insert("p1"),
            Some([&elsewhere, FINGERPRINT])
        ))),
        Some("POLICYSQL_INVALID_REQUEST")
    );
    // A read envelope never runs on an owner.
    assert_eq!(
        code(&engine.run(&atomic_input(&select(), None))),
        Some("POLICYSQL_INVALID_REQUEST")
    );
    // The request kind runs only in the engine, an owner input only on an owner.
    assert_eq!(
        code(&engine.run(&execute_request(&select(), None))),
        Some("POLICYSQL_INTERNAL")
    );
    let mut direct = Engine::atomic(false);
    assert_eq!(
        code(&direct.run(&atomic_input(&insert("p1"), None))),
        Some("POLICYSQL_INTERNAL")
    );
    assert_eq!(
        engine.observed.commits_emitted + direct.observed.commits_emitted,
        0
    );
    assert_eq!(OWNER.len(), 35);
}

// ---- the review's probes (#75), deterministic --------------------------------------------------

use common::probes;

fn answers(engine: &Engine) -> Vec<String> {
    engine
        .observed
        .replies
        .iter()
        .map(|(_, reply)| {
            code(reply).map_or_else(
                || reply["value"]["status"].as_str().unwrap_or("").to_owned(),
                str::to_owned,
            )
        })
        .collect()
}

#[test]
fn an_invalid_volatile_text_beyond_256_kib_still_releases_its_handles() {
    // A direct execution waits for `Open` with its plan live.
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&select(), None));
    engine.resolve(true, "unknown");
    let open = engine.outstanding.clone().unwrap_or(Value::Null);
    assert_eq!(open["type"], "open");
    assert_eq!(engine.compiler.live_handles(), 1);
    // The engine hands back a volatile text that is no longer valid (an unknown member) and
    // larger than 256 KiB, but within the runtime's volatile bound.
    let mut volatile: Value =
        serde_json::from_str(engine.volatile.as_deref().unwrap_or("{}")).unwrap_or(Value::Null);
    volatile["padding"] = json!("x".repeat(300 * 1024));
    let text = volatile.to_string();
    assert!(text.len() > 256 * 1024 && text.len() <= engine.limits.max_volatile_bytes());
    engine.volatile = Some(text);
    engine.feed(&json!({"type": "opened", "id": open["id"]}));
    assert!(
        engine
            .last_effects
            .iter()
            .any(|effect| effect["type"] == "reset"),
        "fails closed"
    );
    assert_eq!(engine.compiler.live_handles(), 0, "the plan is released");
}

#[test]
fn p1_a_prior_record_of_another_binding_is_ignored_and_replaced() {
    let engine = probes::prior_record_of_another_binding();
    assert_eq!(answers(&engine), ["committed", "committed"]);
    assert_eq!(
        engine.observed.envelope_executes, 1,
        "the retry replays from the row"
    );
    assert_eq!(
        engine.observed.commits_emitted, 1,
        "no COMMIT for the retry"
    );
    let awaited = &engine.observed.awaited;
    assert_eq!(
        awaited[awaited.len() - 7..],
        [
            "checkBinding",
            "open",
            "persist",
            "setTimer",
            "execute",
            "rollback",
            "persist"
        ]
    );
    let record: Value =
        serde_json::from_str(engine.store.as_deref().unwrap_or("{}")).unwrap_or(Value::Null);
    assert_eq!(record["phase"], "committed");
    assert_eq!(
        record["binding"]["databaseId"], "db_a",
        "the record is replaced"
    );
    assert_eq!(record["binding"]["generation"], "1");
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn p2_a_timer_while_a_callback_holds_the_connection_answers_now_and_rolls_back_after_it() {
    let engine = probes::timer_while_callback_holds_the_connection();
    assert_eq!(answers(&engine), ["POLICYSQL_COMMIT_CHECK_REJECTED"]);
    // The callback query's rows are not returned: its capability was revoked.
    let callbacks: Vec<Option<&str>> = engine.observed.callback_replies.iter().map(code).collect();
    assert_eq!(callbacks, [Some("POLICYSQL_TRANSACTION_UNAVAILABLE")]);
    assert_eq!(engine.observed.commits_emitted, 0);
    assert_eq!(engine.observed.rollbacks_emitted, 1);
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    // The late verdict is ignored.
    assert!(
        engine
            .transcript
            .last()
            .is_some_and(|line| line.output.contains("tx_outcome_ignored"))
    );
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn p3_a_successor_timer_does_not_expire_a_keyed_retry_that_has_no_record_yet() {
    let engine = probes::successor_timer_races_a_keyed_retry();
    assert_eq!(answers(&engine), ["committed"]);
    assert_eq!(engine.observed.envelope_commits, 1);
    assert_eq!(engine.idempotency_rows.len(), 1);
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("committed")
    );
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn p4_a_timer_during_the_idempotency_insert_sends_no_commit() {
    let engine = probes::timer_during_the_idempotency_insert();
    assert_eq!(answers(&engine), ["POLICYSQL_TRANSACTION_UNAVAILABLE"]);
    assert_eq!(engine.observed.commits_emitted, 0);
    assert_eq!(engine.observed.rollbacks_emitted, 1);
    assert_eq!(engine.idempotency_rows.len() + engine.pending_rows.len(), 0);
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn p5_a_direct_abandon_during_commit_then_the_retry_resolves_through_the_row() {
    let applied = probes::direct_abandon_during_commit(true);
    assert_eq!(answers(&applied), ["committed"], "the retry replays");
    assert_eq!(applied.observed.envelope_executes, 1);
    assert_eq!(applied.observed.envelope_commits, 1);
    let lost = probes::direct_abandon_during_commit(false);
    assert_eq!(answers(&lost), ["committed"], "the retry executes once");
    assert_eq!(lost.observed.envelope_executes, 2);
    assert_eq!(lost.observed.envelope_commits, 1);
    for engine in [&applied, &lost] {
        assert_eq!(engine.idempotency_rows.len(), 1);
        assert_eq!(engine.compiler.live_handles(), 0);
    }
}

/// An envelope whose client parameter collides with a server parameter (the fake compiler's
/// `session_tenant_id`): core merges the namespaces and fails closed before the envelope's
/// `execute` on both placements, keyed and unkeyed, and releases every handle (ADR 0024 pull
/// request 9 removed the engine's second check in `driverArgs`).
#[test]
fn a_parameter_namespace_collision_executes_no_envelope_on_either_placement() {
    let colliding = envelope(&[(
        "INSERT INTO projects (id) VALUES (:session_tenant_id)",
        json!({"session_tenant_id": "other"}),
    )]);
    let audited = envelope(&[(
        "INSERT INTO audited (id) VALUES (:session_tenant_id)",
        json!({"session_tenant_id": "other"}),
    )]);
    for (label, mut engine, event) in [
        (
            "direct unkeyed",
            Engine::atomic(false),
            execute_request(&colliding, None),
        ),
        (
            "direct keyed",
            Engine::atomic(false),
            execute_request(&colliding, Some(KEY)),
        ),
        (
            "owner unkeyed",
            owner_engine(),
            atomic_input(&audited, None),
        ),
        (
            "owner keyed",
            owner_engine(),
            atomic_input(&audited, Some([KEY_HASH, FINGERPRINT])),
        ),
    ] {
        let reply = engine.run(&event);
        assert_eq!(reply["ok"], false, "{label}: {reply}");
        assert_eq!(
            engine.observed.envelope_executes, 0,
            "{label}: no envelope executes"
        );
        assert_eq!(engine.observed.envelope_commits, 0, "{label}");
        assert!(
            !types(&engine).contains(&"commit".to_owned()),
            "{label}: no COMMIT"
        );
        if label.ends_with("unkeyed") {
            // Without a key there is no idempotency lookup either: no execute effect at all.
            assert!(!types(&engine).contains(&"execute".to_owned()), "{label}");
        }
        assert_eq!(
            engine.compiler.live_handles(),
            0,
            "{label}: handles released"
        );
    }
}

// ---- #80: a keyed retry across a snapshot change ----------------------------------------------

const NEXT_SNAPSHOT: &str = "sqlite-turso-v1:schema_2:policy_2:abi-13";

/// `request` with its binding and snapshot set to `snapshot` and its binding's generation to
/// `generation`, as a request after a deployment (or a database move) carries them.
fn redeployed(mut request: Value, snapshot: &str, generation: &str) -> Value {
    let operation = &mut request["operation"];
    operation["snapshot"] = json!(snapshot);
    operation["databaseBinding"]["snapshot"] = json!(snapshot);
    operation["databaseBinding"]["generation"] = json!(generation);
    request
}

/// The `idempotency` of the `forward` effect the engine emitted last.
fn forwarded_idempotency(engine: &Engine) -> Value {
    engine
        .transcript
        .iter()
        .rev()
        .find_map(|line| {
            let output: Value = serde_json::from_str(&line.output).ok()?;
            output["effects"]
                .as_array()?
                .iter()
                .find(|effect| effect["type"] == "forward")
                .map(|effect| effect["input"]["idempotency"].clone())
        })
        .unwrap_or(Value::Null)
}

#[test]
fn a_committed_keyed_write_replays_across_a_snapshot_change_on_the_direct_placement() {
    let mut engine = Engine::atomic(false);
    let first = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(engine.observed.envelope_executes, 1);

    // A deployment changes the snapshot (policy, schema, or ABI); the client retries.
    engine.compiler.snapshot = NEXT_SNAPSHOT.to_owned();
    engine.observed.awaited.clear();
    let retry = engine.run(&redeployed(
        execute_request(&insert("p1"), Some(KEY)),
        NEXT_SNAPSHOT,
        "1",
    ));
    assert_eq!(retry["ok"], true, "the committed write replays: {retry}");
    assert_eq!(retry["value"]["results"], first["value"]["results"]);
    assert_eq!(
        retry["value"]["transactionId"],
        first["value"]["transactionId"]
    );
    assert_eq!(retry["value"]["meta"]["requestId"], "req_1");
    assert_eq!(
        types(&engine),
        ["checkBinding", "open", "execute", "rollback"],
        "rolled back: nothing executes again"
    );
    assert_eq!(engine.observed.envelope_executes, 1, "never executes twice");
    assert_eq!(engine.observed.commits_emitted, 1);
    assert_eq!(engine.idempotency_rows.len(), 1);

    // Another body on the same key still conflicts under the new snapshot.
    let changed = engine.run(&redeployed(
        execute_request(&insert("p2"), Some(KEY)),
        NEXT_SNAPSHOT,
        "1",
    ));
    assert_eq!(code(&changed), Some("POLICYSQL_IDEMPOTENCY_CONFLICT"));
    // Another generation of the same database still conflicts: the key hash finds the row,
    // the fingerprint keeps the generation.
    let generation = engine.run(&redeployed(
        execute_request(&insert("p1"), Some(KEY)),
        NEXT_SNAPSHOT,
        "2",
    ));
    assert_eq!(code(&generation), Some("POLICYSQL_IDEMPOTENCY_CONFLICT"));
    assert_eq!(engine.observed.envelope_executes, 1);
    assert_eq!(engine.observed.commits_emitted, 1);
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn a_request_whose_binding_and_snapshot_disagree_is_still_stale() {
    // Removing the snapshot from the fingerprint does not relax the snapshot check: a
    // request pinned to the earlier snapshot never reaches the lookup.
    let mut engine = Engine::atomic(false);
    engine.run(&execute_request(&insert("p1"), Some(KEY)));
    engine.compiler.snapshot = NEXT_SNAPSHOT.to_owned();
    let stale = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(code(&stale), Some("POLICYSQL_STALE_OPERATION"), "{stale}");
    let mut mixed = redeployed(
        execute_request(&insert("p1"), Some(KEY)),
        NEXT_SNAPSHOT,
        "1",
    );
    mixed["operation"]["databaseBinding"]["snapshot"] = json!(common::SNAPSHOT);
    let mixed = engine.run(&mixed);
    assert_eq!(code(&mixed), Some("POLICYSQL_STALE_OPERATION"), "{mixed}");
    assert_eq!(engine.observed.envelope_executes, 1);
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn the_forwarded_fingerprint_has_no_snapshot_and_the_owner_replays_across_a_snapshot_change() {
    // The engine computes the identity it forwards: the same request under two snapshots
    // reaches the same owner with the same fingerprint; another generation does not match.
    let mut engine = Engine::atomic(false);
    engine.run(&execute_request(&audit("a1"), Some(KEY)));
    let before = forwarded_idempotency(&engine);
    engine.compiler.snapshot = NEXT_SNAPSHOT.to_owned();
    engine.run(&redeployed(
        execute_request(&audit("a1"), Some(KEY)),
        NEXT_SNAPSHOT,
        "1",
    ));
    let after = forwarded_idempotency(&engine);
    assert!(before["fingerprint"].is_string(), "{before}");
    assert_eq!(before, after);
    engine.run(&redeployed(
        execute_request(&audit("a1"), Some(KEY)),
        NEXT_SNAPSHOT,
        "2",
    ));
    let generation = forwarded_idempotency(&engine);
    assert_eq!(generation["keyHash"], before["keyHash"]);
    assert_ne!(generation["fingerprint"], before["fingerprint"]);
    let fingerprint = before["fingerprint"].as_str().unwrap_or("").to_owned();
    let key_hash = before["keyHash"].as_str().unwrap_or("").to_owned();
    assert_eq!(key_hash.len(), 64);

    // On the owner: commit under the first snapshot, then the retry under the next one.
    let owner = format!("tx_{}", &key_hash[..32]);
    let mut owner_engine = owner_engine();
    owner_engine.owner = Some(owner.clone());
    let input = |snapshot: &str, body: &Value| {
        let mut input = atomic_input(body, Some([&key_hash, &fingerprint]));
        input["input"]["validationId"] = json!(format!("cval_{}", &key_hash[..32]));
        input["input"]["snapshot"] = json!(snapshot);
        input["input"]["databaseBinding"]["snapshot"] = json!(snapshot);
        input
    };
    let first = owner_engine.run(&input(common::SNAPSHOT, &audit("a1")));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(owner_engine.observed.commits_emitted, 1);
    owner_engine.compiler.snapshot = NEXT_SNAPSHOT.to_owned();
    owner_engine.observed.awaited.clear();
    let retry = owner_engine.run(&input(NEXT_SNAPSHOT, &audit("a1")));
    assert_eq!(retry["ok"], true, "{retry}");
    assert_eq!(retry["value"]["results"], first["value"]["results"]);
    assert_eq!(retry["value"]["meta"]["commitChecks"], "passed");
    assert_eq!(owner_engine.observed.commits_emitted, 1, "no second COMMIT");
    assert_eq!(owner_engine.observed.envelope_executes, 1);
    assert_eq!(owner_engine.observed.validator_calls.len(), 1);
    assert!(!types(&owner_engine).contains(&"commit".to_owned()));
    // The generation's fingerprint conflicts on the owner too.
    let other = generation["fingerprint"].as_str().unwrap_or("").to_owned();
    let mut conflicting = input(NEXT_SNAPSHOT, &audit("a1"));
    conflicting["input"]["idempotency"]["fingerprint"] = json!(other);
    let conflict = owner_engine.run(&conflicting);
    assert_eq!(code(&conflict), Some("POLICYSQL_IDEMPOTENCY_CONFLICT"));
    assert_eq!(owner_engine.observed.commits_emitted, 1);
    assert_eq!(owner_engine.compiler.live_handles(), 0);
}

// ---- #85: an owner that does not share the Worker's snapshot ------------------------------------

#[test]
fn an_owner_answers_another_snapshot_as_version_skew_never_as_a_conflict() {
    let owner = format!("tx_{}", "ab".repeat(16));
    let mut owner_engine = owner_engine();
    owner_engine.owner = Some(owner);
    let mut skewed = atomic_input(&audit("a1"), Some([&"ab".repeat(32), &"cd".repeat(32)]));
    skewed["input"]["validationId"] = json!(format!("cval_{}", "ab".repeat(16)));
    skewed["input"]["snapshot"] = json!(NEXT_SNAPSHOT);
    skewed["input"]["databaseBinding"]["snapshot"] = json!(NEXT_SNAPSHOT);
    let answer = owner_engine.run(&skewed);
    assert_eq!(code(&answer), Some("POLICYSQL_INTERNAL"), "{answer}");
    assert_eq!(owner_engine.observed.commits_emitted, 0, "nothing ran");
    assert_eq!(owner_engine.observed.envelope_executes, 0);
    assert_eq!(owner_engine.compiler.live_handles(), 0);
}

#[test]
fn an_owner_compares_the_snapshot_before_reading_the_rest_of_the_input() {
    let owner = format!("tx_{}", "ab".repeat(16));
    let mut owner_engine = owner_engine();
    owner_engine.owner = Some(owner);
    // An input of another deployment whose other members this owner cannot read.
    for member in ["databaseBinding", "request", "auth"] {
        let mut skewed = atomic_input(&audit("a1"), None);
        skewed["input"]["validationId"] = json!(format!("cval_{}", "ab".repeat(16)));
        skewed["input"]["snapshot"] = json!(NEXT_SNAPSHOT);
        skewed["input"][member] = json!(7);
        let answer = owner_engine.run(&skewed);
        assert_eq!(
            code(&answer),
            Some("POLICYSQL_INTERNAL"),
            "{member}: {answer}"
        );
    }
    assert_eq!(owner_engine.observed.commits_emitted, 0);
}
