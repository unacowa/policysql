//! Scenario tests of the step machine (ADR 0024 pull request 4) with a fake compiler and a
//! model of the engine. The scenarios that ADR 0024 names (inconsistencies 3, 4, 6, and #70)
//! are also checked in as transcripts under `tests/fixtures/transactions/` (see
//! `transcripts.rs`).

mod common;

use common::{
    Engine, FakeCompiler, LIMITS, OWNER, SNAPSHOT, auth, begin, code, command, command_as,
    phase_of, sequence_text, statement_text,
};
use policysql_transaction::machine::step_json;
use serde_json::{Value, json};

fn begun(mode: &str) -> Engine {
    let mut engine = Engine::new();
    let reply = engine.run(&begin(mode));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["value"]["status"], "active");
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("active"));
    engine
}

fn effect_types(engine: &Engine) -> Vec<String> {
    engine
        .transcript
        .iter()
        .flat_map(|line| {
            let output: Value = serde_json::from_str(&line.output).unwrap_or(Value::Null);
            output["effects"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|effect| effect["type"].as_str().unwrap_or("").to_owned())
        })
        .collect()
}

#[test]
fn begin_statement_retry_commit() {
    let mut engine = begun("write");
    assert_eq!(
        effect_types(&engine),
        [
            "checkBinding",
            "open",
            "persist",
            "setTimer",
            "log",
            "respond"
        ]
    );
    let begin_reply = engine.last_reply().cloned().unwrap_or_default();
    assert_eq!(begin_reply["value"]["nextSequence"], 1);
    assert_eq!(
        begin_reply["value"]["expiresAt"],
        "2026-09-21T14:13:24.000Z"
    );
    let text = statement_text(1, "INSERT INTO projects (id) VALUES (:id)");
    let first = engine.run(&command("statement", &text));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["value"]["result"]["sequence"], 1);
    assert_eq!(first["value"]["result"]["affectedRows"], 1);
    assert_eq!(first["value"]["nextSequence"], 2);
    let replay = engine.run(&command("statement", &text));
    assert_eq!(replay, first, "an exact retry replays the recorded reply");
    let committed = engine.run(&command("commit", &sequence_text(2)));
    assert_eq!(committed["value"]["status"], "committed", "{committed}");
    assert_eq!(committed["value"]["meta"]["commitChecks"], "not_triggered");
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("committed")
    );
    assert_eq!(engine.observed.commits_emitted, 1);
    assert_eq!(engine.compiler.live_handles(), 0, "every handle released");
    assert!(engine.volatile.is_none());
    let again = engine.run(&command("commit", &sequence_text(2)));
    assert_eq!(again, committed, "a repeated commit replays committed");
}

#[test]
fn sequence_gap_conflicts_and_rolls_back() {
    let mut engine = begun("read");
    let reply = engine.run(&command(
        "statement",
        &statement_text(2, "SELECT id FROM projects"),
    ));
    assert_eq!(code(&reply), Some("POLICYSQL_TRANSACTION_CONFLICT"));
    assert!(effect_types(&engine).contains(&"rollback".to_owned()));
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
}

#[test]
fn a_different_payload_at_the_last_sequence_conflicts() {
    let mut engine = begun("read");
    engine.run(&command(
        "statement",
        &statement_text(1, "SELECT id FROM projects"),
    ));
    let other = engine.run(&command(
        "statement",
        &statement_text(1, "SELECT name FROM projects"),
    ));
    assert_eq!(code(&other), Some("POLICYSQL_TRANSACTION_CONFLICT"));
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
}

#[test]
fn read_mode_rejects_a_mutation() {
    let mut engine = begun("read");
    let reply = engine.run(&command(
        "statement",
        &statement_text(1, "DELETE FROM projects"),
    ));
    assert_eq!(code(&reply), Some("POLICYSQL_TRANSACTION_MODE_VIOLATION"));
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn compile_errors_close_the_transaction() {
    let mut engine = begun("read");
    let reply = engine.run(&command("statement", &statement_text(1, "BAD")));
    assert_eq!(code(&reply), Some("POLICYSQL_INVALID_SQL"));
    assert_eq!(reply["error"]["path"], "/statements/0");
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
}

#[test]
fn issue_70_overflow_is_rejected_from_the_body_text() {
    // `{"value": 1e400}`: JSON.stringify would send `null`; the machine compiles the text.
    let mut engine = begun("write");
    let text = r#"{"sequence":1,"sql":"INSERT INTO counters (id, ratio) VALUES (:id, :value)","params":{"id":"x","value":1e400}}"#;
    let reply = engine.run(&command("statement", text));
    assert_eq!(code(&reply), Some("POLICYSQL_INVALID_REQUEST"), "{reply}");
    assert!(
        !effect_types(&engine).contains(&"execute".to_owned()),
        "nothing executes"
    );
}

#[test]
fn issue_70_large_integers_keep_their_digits() {
    let mut engine = begun("write");
    let text = r#"{"sequence":1,"sql":"INSERT INTO counters (id, big) VALUES (:id, :value)","params":{"id":"x","value":9007199254740993}}"#;
    engine.feed(&command("statement", text));
    engine.resolve(true, "unknown");
    let execute = engine.outstanding.clone().unwrap_or_default();
    assert_eq!(execute["type"], "execute");
    let raw = engine
        .transcript
        .last()
        .map(|line| line.output.clone())
        .unwrap_or_default();
    assert!(raw.contains(r#""value":9007199254740993"#), "{raw}");
    engine.settle();
    // The rounded spelling is a different command: not an exact retry.
    let rounded = r#"{"sequence":1,"sql":"INSERT INTO counters (id, big) VALUES (:id, :value)","params":{"id":"x","value":9007199254740992}}"#;
    let retry = engine.run(&command("statement", rounded));
    assert_eq!(
        code(&retry),
        Some("POLICYSQL_TRANSACTION_CONFLICT"),
        "{retry}"
    );
}

#[test]
fn owner_loss_fails_closed_but_replays_the_completed_statement() {
    let mut engine = begun("read");
    let text = statement_text(1, "SELECT id FROM projects");
    let first = engine.run(&command("statement", &text));
    engine.lose();
    let replay = engine.run(&command("statement", &text));
    assert_eq!(replay, first, "replayed before the liveness check");
    let next = engine.run(&command(
        "statement",
        &statement_text(2, "SELECT id FROM projects"),
    ));
    assert_eq!(code(&next), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
}

#[test]
fn begin_retry_replays_state_and_conflicts_on_another_start() {
    let mut engine = begun("read");
    let again = engine.run(&begin("read"));
    assert_eq!(again["value"]["status"], "active");
    let mut other = begin("read");
    other["input"]["startFingerprint"] = json!("d".repeat(64));
    let conflict = engine.run(&other);
    assert_eq!(code(&conflict), Some("POLICYSQL_TRANSACTION_CONFLICT"));
    engine.lose();
    let lost = engine.run(&begin("read"));
    assert_eq!(code(&lost), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
}

#[test]
fn another_caller_is_unavailable() {
    let mut engine = begun("read");
    let reply = engine.run(&command_as(
        "statement",
        &statement_text(1, "SELECT id FROM projects"),
        &auth("intruder"),
    ));
    assert_eq!(code(&reply), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("active"));
}

#[test]
fn timer_expires_an_idle_transaction() {
    let mut engine = begun("read");
    engine.now += 3_999;
    engine.run(&json!({"type": "timerFired"}));
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("active"),
        "not due yet"
    );
    engine.now += 1;
    engine.run(&json!({"type": "timerFired"}));
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    let reply = engine.run(&command(
        "statement",
        &statement_text(1, "SELECT id FROM projects"),
    ));
    assert_eq!(code(&reply), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
}

#[test]
fn an_expired_command_is_unavailable_and_records_expired() {
    let mut engine = begun("read");
    engine.now += 5_000;
    let reply = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&reply), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn deadline_check_after_committing_is_persisted() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown"); // binding checked → Persist(committing)
    engine.now += 4_000;
    engine.resolve(true, "unknown"); // Persisted at the deadline → rollback, no COMMIT
    engine.settle();
    assert_eq!(engine.observed.commits_emitted, 0);
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_TRANSACTION_UNAVAILABLE")
    );
}

#[test]
fn deadline_check_with_failed_expired_record_resets_to_outcome_unknown() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.now += 4_000;
    engine.resolve(true, "unknown"); // → Rollback
    engine.resolve(true, "unknown"); // → Persist(expired)
    engine.resolve(false, "unknown"); // PersistFailed → INTERNAL, Reset
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_INTERNAL")
    );
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("committing")
    );
    let retry = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&retry), Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"));
}

#[test]
fn persist_failure_of_committing_never_sends_commit() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(false, "unknown"); // PersistFailed(committing) → rollback
    engine.settle();
    assert_eq!(engine.observed.commits_emitted, 0);
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_INTERNAL")
    );
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
    let retry = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&retry), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
}

#[test]
fn inconsistency_3_owner_lost_after_commit_is_outcome_unknown() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown"); // Persisted(committing) → Commit
    assert_eq!(engine.observed.commits_emitted, 1);
    engine.lose();
    let retry = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&retry), Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"));
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("commit_unknown")
    );
    let again = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&again), Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"));
    let statement = engine.run(&command(
        "statement",
        &statement_text(1, "SELECT id FROM projects"),
    ));
    assert_eq!(code(&statement), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
}

#[test]
fn inconsistency_3_abandon_after_commit_is_outcome_unknown() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    let abandoned = engine.feed(&json!({"type": "abandon"}));
    assert_eq!(
        phase_of(engine.durable.as_deref()).as_deref(),
        Some("commit_unknown")
    );
    assert_eq!(
        abandoned["effects"].as_array().map(Vec::len),
        Some(1),
        "{abandoned}"
    );
    assert_eq!(abandoned["effects"][0]["type"], "persist");
    assert!(abandoned["volatile"].is_null());
    engine.resolve(true, "unknown");
    engine.lose();
    let retry = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&retry), Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"));
}

#[test]
fn inconsistency_3_failed_terminal_put_still_reports_committed() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown"); // Committed → Persist(committed)
    engine.resolve(false, "unknown"); // PersistFailed → reply committed, Reset
    let reply = engine.last_reply().cloned().unwrap_or_default();
    assert_eq!(reply["value"]["status"], "committed", "{reply}");
    assert!(
        engine
            .last_effects
            .iter()
            .any(|effect| effect["type"] == "reset")
    );
    let retry = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&retry), Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"));
}

#[test]
fn inconsistency_4_commit_transport_error_is_outcome_unknown() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.resolve(false, "unavailable");
    engine.settle();
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN")
    );
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("commit_unknown")
    );
    let retry = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&retry), Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"));
}

#[test]
fn not_committed_is_a_definite_failure() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.resolve(false, "not_committed");
    engine.settle();
    let reply = engine.last_reply().cloned().unwrap_or_default();
    assert_eq!(reply["value"]["status"], "failed", "{reply}");
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
}

#[test]
fn inconsistency_6_timer_during_commit_is_ignored() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown"); // Commit in flight
    let commit = engine.outstanding.clone();
    engine.now += 10_000;
    let fired = engine.feed(&json!({"type": "timerFired"}));
    assert_eq!(fired["effects"], json!([]), "nothing expires a sent COMMIT");
    engine.outstanding = commit;
    engine.settle();
    let reply = engine.last_reply().cloned().unwrap_or_default();
    assert_eq!(reply["value"]["status"], "committed", "{reply}");
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("committed")
    );
}

#[test]
fn timer_during_a_statement_rolls_back_when_it_returns() {
    let mut engine = begun("read");
    engine.feed(&command(
        "statement",
        &statement_text(1, "SELECT id FROM projects"),
    ));
    engine.resolve(true, "unknown"); // → Execute in flight
    let execute = engine.outstanding.clone();
    engine.now += 4_000;
    engine.feed(&json!({"type": "timerFired"}));
    engine.outstanding = execute;
    engine.settle();
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_TRANSACTION_UNAVAILABLE")
    );
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn triggered_commit_checks_reject_until_pull_request_5() {
    let mut engine = begun("write");
    engine.compiler.triggers.insert("projects".to_owned());
    engine.run(&command(
        "statement",
        &statement_text(1, "INSERT INTO projects (id) VALUES (:id)"),
    ));
    let reply = engine.run(&command("commit", &sequence_text(2)));
    assert_eq!(code(&reply), Some("POLICYSQL_COMMIT_CHECK_REJECTED"));
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn rollback_command_records_rolled_back() {
    let mut engine = begun("write");
    let reply = engine.run(&command("rollback", &sequence_text(1)));
    assert_eq!(reply["value"]["status"], "rolled_back");
    let repeated = engine.run(&command("rollback", &sequence_text(1)));
    assert_eq!(repeated, reply);
    let commit = engine.run(&command("commit", &sequence_text(2)));
    assert_eq!(code(&commit), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
}

#[test]
fn statement_limit_and_shape_errors() {
    let mut engine = begun("read");
    let invalid = engine.run(&command(
        "statement",
        r#"{"sequence":1,"sql":"SELECT id FROM projects"}"#,
    ));
    assert_eq!(code(&invalid), Some("POLICYSQL_INVALID_REQUEST"));
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("active"),
        "shape errors do not close"
    );
    for sequence in 1..=8 {
        let reply = engine.run(&command(
            "statement",
            &statement_text(sequence, "SELECT id FROM projects"),
        ));
        assert_eq!(reply["ok"], true, "{reply}");
    }
    let ninth = engine.run(&command(
        "statement",
        &statement_text(9, "SELECT id FROM projects"),
    ));
    assert_eq!(code(&ninth), Some("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED"));
}

#[test]
fn old_format_records_are_discarded() {
    let old = json!({
        "transactionId": OWNER, "status": "committing", "commitSent": {"sequence": 1, "digest": "d"},
    })
    .to_string();
    for (kind, text, expected) in [
        (
            "commit",
            sequence_text(1),
            "POLICYSQL_COMMIT_OUTCOME_UNKNOWN",
        ),
        (
            "commit",
            sequence_text(7),
            "POLICYSQL_COMMIT_OUTCOME_UNKNOWN",
        ),
        (
            "statement",
            statement_text(1, "SELECT id FROM projects"),
            "POLICYSQL_TRANSACTION_UNAVAILABLE",
        ),
        (
            "rollback",
            sequence_text(1),
            "POLICYSQL_TRANSACTION_UNAVAILABLE",
        ),
    ] {
        let mut engine = Engine::new();
        engine.store = Some(old.clone());
        engine.durable = Some(old.clone());
        let reply = engine.run(&command(kind, &text));
        assert_eq!(code(&reply), Some(expected), "{kind}");
        assert_eq!(
            phase_of(engine.store.as_deref()).as_deref(),
            Some("discarded")
        );
        let again = engine.run(&command(kind, &text));
        assert_eq!(code(&again), Some(expected), "the tombstone answers alike");
    }
    let mut engine = Engine::new();
    engine.durable = Some(old);
    let begin_reply = engine.run(&begin("read"));
    assert_eq!(
        code(&begin_reply),
        Some("POLICYSQL_TRANSACTION_UNAVAILABLE")
    );
}

#[test]
fn invalid_host_facts_and_events_are_internal_errors() {
    let compiler = FakeCompiler::new();
    for (event, host) in [
        (r#"{"type":"timerFired"}"#, "{}"),
        (
            r#"{"type":"timerFired"}"#,
            r#"{"nowMs":1,"entropy":"00","requestId":"r","owner":null}"#,
        ),
        (
            "{}",
            &*format!(
                r#"{{"nowMs":1,"entropy":"{}","requestId":"r","owner":"{OWNER}"}}"#,
                "0".repeat(64)
            ),
        ),
    ] {
        let output = step_json(&compiler, &LIMITS, None, None, event, host);
        assert!(
            output.starts_with(r#"{"error":{"code":"POLICYSQL_INTERNAL""#),
            "{output}"
        );
    }
}

#[test]
fn invalid_volatile_state_fails_closed() {
    let mut engine = begun("write");
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown"); // committing, COMMIT in flight
    engine.volatile = Some("{\"v\":1}".to_owned());
    let output = engine.feed(&json!({"type": "committed", "id": 1}));
    assert_eq!(
        phase_of(output["durable"].as_str()).as_deref(),
        Some("commit_unknown")
    );
    engine.resolve(true, "unknown");
    let retry = engine.run(&command("commit", &sequence_text(1)));
    assert_eq!(code(&retry), Some("POLICYSQL_COMMIT_OUTCOME_UNKNOWN"));
}

#[test]
fn stale_outcomes_fail_closed_or_are_ignored() {
    let mut engine = begun("read");
    let stale = engine.feed(&json!({"type": "persisted", "id": 1}));
    assert_eq!(
        phase_of(stale["durable"].as_str()).as_deref(),
        Some("failed"),
        "{stale}"
    );
    engine.settle();
    let ignored = engine.feed(&json!({"type": "committed", "id": 99}));
    assert_eq!(
        ignored["effects"][0]["record"]["event"],
        "tx_outcome_ignored"
    );
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn same_inputs_give_the_same_output_bytes() {
    let mut engine = begun("write");
    engine.run(&command(
        "statement",
        &statement_text(1, "INSERT INTO projects (id) VALUES (:id)"),
    ));
    engine.run(&command("commit", &sequence_text(2)));
    let compiler = FakeCompiler::new();
    for line in &engine.transcript {
        let output = step_json(
            &compiler,
            &LIMITS,
            line.durable.as_deref(),
            line.volatile.as_deref(),
            &line.event,
            &line.host,
        );
        assert_eq!(output, line.output);
    }
}

#[test]
fn snapshot_change_replays_a_committed_commit() {
    let mut engine = begun("write");
    let committed = engine.run(&command("commit", &sequence_text(1)));
    engine.lose();
    engine.compiler.snapshot = "sqlite-turso-v1:schema_1:policy_1:abi-7".to_owned();
    let mut retry = command("commit", &sequence_text(1));
    retry["input"]["snapshot"] = json!("sqlite-turso-v1:schema_1:policy_1:abi-7");
    retry["input"]["databaseBinding"]["snapshot"] =
        json!("sqlite-turso-v1:schema_1:policy_1:abi-7");
    assert_eq!(engine.run(&retry), committed);
    let _ = SNAPSHOT;
}
