//! Commit checks and callbacks in the step machine (ADR 0024 pull request 5, ADR 0007), with
//! a fake compiler and the engine model of `common`.

mod common;

use common::{Engine, OWNER, T0, begin, code, command, phase_of, sequence_text, statement_text};
use policysql_transaction::sha256_hex;
use serde_json::{Value, json};

const SELECT: &str = r#"{"sequence":1,"sql":"SELECT id FROM projects","params":{}}"#;

fn select(sequence: u64) -> String {
    json!({"sequence": sequence, "sql": "SELECT id FROM projects", "params": {}}).to_string()
}

/// A write transaction with one insert into `projects`, which triggers `consistency`.
fn checked() -> Engine {
    let mut engine = Engine::new();
    engine.compiler.triggers.insert("projects".to_owned());
    engine.configured = vec!["consistency".to_owned()];
    assert_eq!(engine.run(&begin("write"))["ok"], true);
    let insert = statement_text(1, "INSERT INTO projects (id) VALUES (:id)");
    assert_eq!(engine.run(&command("statement", &insert))["ok"], true);
    engine
}

/// Feeds the commit and runs its effects until the validator call is outstanding.
fn validating(engine: &mut Engine) {
    engine.feed(&command("commit", &sequence_text(2)));
    for _ in 0..4 {
        if engine
            .outstanding
            .as_ref()
            .is_some_and(|effect| effect["type"] == "callValidator")
        {
            return;
        }
        engine.resolve(true, "unknown");
    }
    unreachable!("no validator call: {:?}", engine.outstanding);
}

fn last_reply(engine: &Engine) -> Value {
    engine.last_reply().cloned().unwrap_or_default()
}

fn logs(engine: &Engine, event: &str) -> usize {
    engine
        .transcript
        .iter()
        .filter(|line| line.output.contains(&format!(r#""event":"{event}""#)))
        .count()
}

#[test]
fn an_allowed_check_with_callbacks_commits_with_passed() {
    let mut engine = checked();
    validating(&mut engine);
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("validating")
    );
    let call = engine.observed.validator_calls[0].clone();
    let token = engine.token();
    assert_eq!(token.len(), 43);
    assert_eq!(call["check"], "consistency");
    assert_eq!(call["timeoutMs"], 1_000);
    assert_eq!(call["capability"]["expiresAtMs"], engine.now + 1_000);
    let validation = format!("cval_{}", &OWNER[3..]);
    assert_eq!(
        call["payload"],
        json!({
            "version": "1", "validationId": validation, "check": "consistency",
            "requestId": "req_10", "policyVersion": "policy_1", "schemaVersion": "schema_1",
            "role": "auditor", "session": {"tenant_id": "tenant_a"},
            "statements": [{"index": 0, "type": "insert", "resource": "projects"}],
        })
    );
    // Only the token's hash is kept, and only in volatile state.
    let volatile = engine.volatile.clone().unwrap_or_default();
    assert!(!volatile.contains(&token));
    assert!(volatile.contains(&sha256_hex(token.as_bytes())));
    assert!(!engine.store.clone().unwrap_or_default().contains(&token));

    let first = engine.run_callback(&token, SELECT);
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["value"]["sequence"], 1);
    assert_eq!(first["value"]["meta"]["role"], "auditor");
    assert_eq!(first["value"]["meta"]["policyVersion"], "policy_1");
    assert_eq!(first["value"]["rowCount"], 1);
    // An exact retry replays without touching the database.
    let executes = engine.observed.callback_executes;
    let respelled = r#"{ "params": {}, "sql": "SELECT id FROM projects", "sequence": 1.0 }"#;
    assert_eq!(engine.run_callback(&token, respelled), first);
    assert_eq!(engine.observed.callback_executes, executes);
    assert_eq!(engine.run_callback(&token, &select(2))["ok"], true);

    engine.resolve(true, "unknown");
    // After the verdict the binding is checked again before `committing`.
    assert_eq!(
        engine
            .outstanding
            .as_ref()
            .map(|effect| effect["type"].clone()),
        Some(json!("checkBinding"))
    );
    engine.settle();
    let reply = last_reply(&engine);
    assert_eq!(reply["value"]["status"], "committed", "{reply}");
    assert_eq!(reply["value"]["meta"]["commitChecks"], "passed");
    assert_eq!(engine.observed.commits_emitted, 1);
    assert_eq!(engine.compiler.live_handles(), 0);
    // The capability was revoked at the verdict.
    let late = engine.run_callback(&token, &select(3));
    assert_eq!(code(&late), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    // The commit's retry replays it.
    assert_eq!(engine.run(&command("commit", &sequence_text(2))), reply);
}

#[test]
fn a_deny_a_malformed_decision_or_a_failed_call_rejects_before_commit() {
    let outcomes: [(&str, Option<(bool, Value)>); 7] = [
        (
            "deny",
            Some((true, json!({"version": "1", "allowed": false}))),
        ),
        (
            "non-2xx",
            Some((false, json!({"version": "1", "allowed": true}))),
        ),
        (
            "version",
            Some((true, json!({"version": "2", "allowed": true}))),
        ),
        (
            "extra key",
            Some((true, json!({"version": "1", "allowed": true, "x": 1}))),
        ),
        ("not JSON", Some((true, Value::Null))),
        ("timeout", None),
        ("transport", None),
    ];
    for (label, outcome) in outcomes {
        let mut engine = checked();
        validating(&mut engine);
        match outcome {
            Some((ok, decision)) => {
                engine.decide(ok, &decision);
            }
            None => {
                engine.resolve(
                    false,
                    if label == "timeout" {
                        "timeout"
                    } else {
                        "unavailable"
                    },
                );
            }
        }
        engine.settle();
        let reply = last_reply(&engine);
        assert_eq!(
            code(&reply),
            Some("POLICYSQL_COMMIT_CHECK_REJECTED"),
            "{label}: {reply}"
        );
        assert_eq!(engine.observed.commits_emitted, 0, "{label}");
        assert_eq!(
            phase_of(engine.store.as_deref()).as_deref(),
            Some("failed"),
            "{label}"
        );
        assert!(
            engine.last_effects.is_empty() || engine.volatile.is_none(),
            "{label}"
        );
        // The retry of the rejected commit stays a rejection: COMMIT was never sent.
        let retry = engine.run(&command("commit", &sequence_text(2)));
        assert_eq!(
            code(&retry),
            Some("POLICYSQL_TRANSACTION_UNAVAILABLE"),
            "{label}"
        );
    }
}

#[test]
fn an_unconfigured_check_rejects_before_any_capability() {
    let mut engine = checked();
    engine.configured.clear();
    let reply = engine.run(&command("commit", &sequence_text(2)));
    assert_eq!(code(&reply), Some("POLICYSQL_COMMIT_CHECK_REJECTED"));
    assert_eq!(engine.observed.validator_calls.len(), 0);
    assert_eq!(logs(&engine, "commit_check_unconfigured"), 1);
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
}

#[test]
fn no_mutation_in_a_configured_resource_triggers_nothing() {
    let mut engine = Engine::new();
    engine.compiler.triggers.insert("projects".to_owned());
    engine.configured = vec!["consistency".to_owned()];
    engine.run(&begin("write"));
    let other = statement_text(1, "INSERT INTO counters (id) VALUES (:id)");
    engine.run(&command("statement", &other));
    let reply = engine.run(&command("commit", &sequence_text(2)));
    assert_eq!(reply["value"]["meta"]["commitChecks"], "not_triggered");
    assert_eq!(engine.observed.validator_calls.len(), 0);
}

#[test]
fn expiry_while_validating_answers_the_commit_now_and_ignores_the_late_verdict() {
    let mut engine = checked();
    validating(&mut engine);
    let validator = engine.outstanding.clone().unwrap_or_default();
    engine.now = T0 + 4_000;
    let replies = engine.observed.replies.len();
    engine.feed(&json!({"type": "timerFired"}));
    // Answered in the timer's own step, before the rollback completes.
    assert_eq!(engine.observed.replies.len(), replies + 1);
    assert_eq!(
        code(&last_reply(&engine)),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
    assert_eq!(
        engine
            .outstanding
            .as_ref()
            .map(|effect| effect["type"].clone()),
        Some(json!("rollback"))
    );
    engine.settle();
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    // The validator answers late: logged and ignored, never a commit.
    engine.outstanding = Some(validator);
    engine.resolve(true, "unknown");
    assert!(
        engine
            .last_effects
            .iter()
            .any(|effect| effect["record"]["event"] == "tx_outcome_ignored")
    );
    assert_eq!(engine.observed.commits_emitted, 0);
    let retry = engine.run(&command("commit", &sequence_text(2)));
    assert_eq!(code(&retry), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
}

#[test]
fn a_late_verdict_after_the_rollback_started_is_ignored() {
    let mut engine = checked();
    validating(&mut engine);
    let validator = engine.outstanding.clone().unwrap_or_default();
    engine.now = T0 + 4_000;
    engine.feed(&json!({"type": "timerFired"}));
    // The verdict arrives while the expiry's ROLLBACK is in flight.
    let rollback = engine.outstanding.take();
    engine.outstanding = Some(validator);
    engine.resolve(true, "unknown");
    assert!(
        engine
            .last_effects
            .iter()
            .any(|effect| effect["record"]["event"] == "tx_outcome_ignored")
    );
    engine.outstanding = rollback;
    engine.settle();
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn owner_loss_while_validating_never_commits() {
    let mut engine = checked();
    validating(&mut engine);
    let token = engine.token();
    engine.lose();
    // The successor holds no capability: the callback changes nothing.
    let callback = engine.run_callback(&token, SELECT);
    assert_eq!(code(&callback), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    assert_eq!(engine.observed.callback_executes, 0);
    let retry = engine.run(&command("commit", &sequence_text(2)));
    assert_eq!(code(&retry), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("validating")
    );
    engine.now = T0 + 4_000;
    engine.run(&json!({"type": "timerFired"}));
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn abandon_while_validating_records_failed() {
    let mut engine = checked();
    validating(&mut engine);
    engine.feed(&json!({"type": "abandon"}));
    engine.resolve(true, "unknown");
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("failed"));
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn a_tampered_capability_ends_the_transaction() {
    for (label, token) in [
        ("other token", "A".repeat(43)),
        ("syntax", "short".to_owned()),
        ("padding", format!("{}=", "A".repeat(42))),
    ] {
        let mut engine = checked();
        validating(&mut engine);
        let reply = engine.run_callback(&token, SELECT);
        assert_eq!(
            code(&reply),
            Some("POLICYSQL_TRANSACTION_UNAVAILABLE"),
            "{label}"
        );
        assert_eq!(engine.observed.callback_executes, 0, "{label}");
        engine.settle();
        assert_eq!(
            code(&last_reply(&engine)),
            Some("POLICYSQL_COMMIT_CHECK_REJECTED"),
            "{label}"
        );
        assert_eq!(
            phase_of(engine.store.as_deref()).as_deref(),
            Some("failed"),
            "{label}"
        );
        // The real token no longer works either.
        let real = engine.token();
        let after = engine.run_callback(&real, SELECT);
        assert_eq!(
            code(&after),
            Some("POLICYSQL_TRANSACTION_UNAVAILABLE"),
            "{label}"
        );
        assert_eq!(engine.observed.commits_emitted, 0, "{label}");
    }
}

#[test]
fn an_expired_capability_ends_the_transaction() {
    let mut engine = checked();
    engine.compiler.checks[0].timeout_ms = 100;
    validating(&mut engine);
    let token = engine.token();
    engine.now += 100;
    let reply = engine.run_callback(&token, SELECT);
    assert_eq!(code(&reply), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    engine.settle();
    assert_eq!(
        code(&last_reply(&engine)),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
}

#[test]
fn callback_limits_end_the_transaction() {
    // Rows: each callback SELECT returns one row; the second exceeds a limit of one.
    let mut engine = checked();
    engine.limits.max_callback_rows = 1;
    validating(&mut engine);
    let token = engine.token();
    assert_eq!(engine.run_callback(&token, &select(1))["ok"], true);
    let over = engine.run_callback(&token, &select(2));
    assert_eq!(code(&over), Some("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED"));
    engine.settle();
    assert_eq!(
        code(&last_reply(&engine)),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
    assert_eq!(engine.observed.commits_emitted, 0);

    // Sequences: no more callback queries than statements per transaction.
    let mut engine = checked();
    engine.limits.max_transaction_statements = 2;
    validating(&mut engine);
    let token = engine.token();
    assert_eq!(engine.run_callback(&token, &select(1))["ok"], true);
    assert_eq!(engine.run_callback(&token, &select(2))["ok"], true);
    let over = engine.run_callback(&token, &select(3));
    assert_eq!(code(&over), Some("POLICYSQL_TRANSACTION_CONFLICT"));
    engine.settle();
    assert_eq!(
        code(&last_reply(&engine)),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );

    // Bytes: the callback replies count against the transaction result-byte limit.
    let mut engine = checked();
    engine.limits.max_transaction_result_bytes = 64;
    validating(&mut engine);
    let token = engine.token();
    let over = engine.run_callback(&token, &select(1));
    assert_eq!(code(&over), Some("POLICYSQL_TRANSACTION_LIMIT_EXCEEDED"));
}

#[test]
fn a_callback_that_is_not_a_single_read_or_out_of_sequence_ends_the_transaction() {
    for (label, text, expected) in [
        ("gap", select(2), "POLICYSQL_TRANSACTION_CONFLICT"),
        (
            "mutation",
            statement_text(1, "DELETE FROM projects"),
            "POLICYSQL_TRANSACTION_CONFLICT",
        ),
        (
            "compile error",
            statement_text(1, "BAD"),
            "POLICYSQL_INVALID_SQL",
        ),
        (
            "extra key",
            r#"{"sequence":1,"sql":"SELECT id FROM projects","params":{},"expect":{}}"#.to_owned(),
            "POLICYSQL_TRANSACTION_UNAVAILABLE",
        ),
        (
            "not JSON",
            "{".to_owned(),
            "POLICYSQL_TRANSACTION_UNAVAILABLE",
        ),
    ] {
        let mut engine = checked();
        validating(&mut engine);
        let token = engine.token();
        let reply = engine.run_callback(&token, &text);
        assert_eq!(code(&reply), Some(expected), "{label}: {reply}");
        assert_eq!(engine.observed.callback_executes, 0, "{label}");
        engine.settle();
        assert_eq!(
            code(&last_reply(&engine)),
            Some("POLICYSQL_COMMIT_CHECK_REJECTED"),
            "{label}"
        );
        assert_eq!(engine.compiler.live_handles(), 0, "{label}");
    }
}

#[test]
fn a_callback_without_a_live_validation_changes_nothing() {
    let mut engine = checked();
    let reply = engine.run_callback(&"A".repeat(43), SELECT);
    assert_eq!(code(&reply), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    assert!(
        engine
            .last_effects
            .iter()
            .all(|effect| effect["type"] == "respond")
    );
    // The transaction is still active and commits.
    validating(&mut engine);
    engine.settle();
    assert_eq!(last_reply(&engine)["value"]["status"], "committed");
    // Another owner's validation id is not this owner's.
    let mut engine = checked();
    validating(&mut engine);
    let token = engine.token();
    let other = engine.feed(&json!({"type": "forwarded", "input": {
        "kind": "callbackQuery", "validationId": format!("cval_{}", "f".repeat(32)),
        "capability": token, "command": SELECT,
    }}));
    assert_eq!(
        code(&other["effects"][0]["reply"]),
        Some("POLICYSQL_TRANSACTION_UNAVAILABLE")
    );
    assert_eq!(engine.run_callback(&token, SELECT)["ok"], true);
}

#[test]
fn a_verdict_while_a_callback_executes_waits_for_the_connection() {
    let mut engine = checked();
    validating(&mut engine);
    let token = engine.token();
    engine.callback(&token, SELECT);
    engine.resolve_callback(true, "unknown"); // binding checked: Execute on the connection
    assert_eq!(
        engine
            .callback_outstanding
            .as_ref()
            .map(|effect| effect["type"].clone()),
        Some(json!("execute"))
    );
    engine.resolve(true, "unknown"); // the verdict: deferred
    assert!(engine.outstanding.is_none());
    assert!(
        engine
            .volatile
            .clone()
            .unwrap_or_default()
            .contains("deferred")
    );
    engine.resolve_callback(true, "unknown");
    // Revoked at the verdict: the query's rows are not returned.
    let callback = engine
        .observed
        .callback_replies
        .last()
        .cloned()
        .unwrap_or_default();
    assert_eq!(code(&callback), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    engine.settle();
    assert_eq!(last_reply(&engine)["value"]["status"], "committed");
    assert_eq!(engine.observed.commits_emitted, 1);
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn expiry_while_a_callback_executes_rolls_back_after_it() {
    let mut engine = checked();
    validating(&mut engine);
    let token = engine.token();
    engine.callback(&token, SELECT);
    engine.resolve_callback(true, "unknown");
    engine.now = T0 + 4_000;
    engine.feed(&json!({"type": "timerFired"}));
    assert_eq!(
        code(&last_reply(&engine)),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
    assert!(
        engine.outstanding.is_none(),
        "no ROLLBACK while the query holds the connection"
    );
    engine.resolve_callback(true, "unknown");
    assert_eq!(
        engine
            .outstanding
            .as_ref()
            .map(|effect| effect["type"].clone()),
        Some(json!("rollback"))
    );
    engine.settle();
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
    assert_eq!(engine.observed.commits_emitted, 0);
    assert_eq!(engine.compiler.live_handles(), 0);
}

#[test]
fn every_check_gets_its_own_capability_in_ascending_order() {
    let mut engine = checked();
    let mut second = engine.compiler.checks[0].clone();
    second.id = "zeta".to_owned();
    second.role = None;
    engine.compiler.checks.push(second);
    engine.configured.push("zeta".to_owned());
    validating(&mut engine);
    let first = engine.token();
    engine.resolve(true, "unknown");
    let calls = &engine.observed.validator_calls;
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1]["check"], "zeta");
    // Without a check role, callbacks run as the commit's role.
    assert_eq!(calls[1]["payload"]["role"], "member");
    let next = engine.token();
    assert_ne!(first, next);
    assert_eq!(
        engine.run_callback(&next, SELECT)["value"]["meta"]["role"],
        "member"
    );
    // The first check's capability was revoked: presenting it now is tampering.
    let stale = engine.run_callback(&first, &select(2));
    assert_eq!(code(&stale), Some("POLICYSQL_TRANSACTION_UNAVAILABLE"));
    engine.settle();
    assert_eq!(
        code(&last_reply(&engine)),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
}

#[test]
fn a_callback_is_compiled_from_its_verified_text() {
    // #70: the callback's parameters keep their exact spelling.
    let mut engine = checked();
    validating(&mut engine);
    let token = engine.token();
    let text =
        r#"{"sequence":1,"sql":"SELECT id FROM projects","params":{"big":9007199254740993}}"#;
    engine.callback(&token, text);
    engine.resolve_callback(true, "unknown");
    let output = engine
        .transcript
        .last()
        .map(|line| line.output.clone())
        .unwrap_or_default();
    assert!(output.contains("9007199254740993"), "{output}");
    let overflow = r#"{"sequence":1,"sql":"SELECT id FROM projects","params":{"x":1e400}}"#;
    let mut engine = checked();
    validating(&mut engine);
    let token = engine.token();
    let reply = engine.run_callback(&token, overflow);
    assert_eq!(code(&reply), Some("POLICYSQL_INVALID_REQUEST"));
}

#[test]
fn persist_failure_of_validating_rejects_without_a_validator() {
    let mut engine = checked();
    engine.feed(&command("commit", &sequence_text(2)));
    engine.resolve(true, "unknown"); // binding checked
    engine.resolve(false, "unknown"); // Persist(validating) failed
    engine.settle();
    assert_eq!(code(&last_reply(&engine)), Some("POLICYSQL_INTERNAL"));
    assert_eq!(engine.observed.validator_calls.len(), 0);
    assert_eq!(engine.observed.commits_emitted, 0);
}

#[test]
fn expiry_before_the_first_validator_rejects_the_commit() {
    let mut engine = checked();
    engine.feed(&command("commit", &sequence_text(2)));
    engine.resolve(true, "unknown"); // binding checked: Persist(validating)
    engine.now = T0 + 4_000;
    let persist = engine.outstanding.clone();
    engine.feed(&json!({"type": "timerFired"}));
    engine.outstanding = persist;
    engine.settle();
    assert_eq!(
        code(&last_reply(&engine)),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
    assert_eq!(engine.observed.validator_calls.len(), 0);
    assert_eq!(
        phase_of(engine.store.as_deref()).as_deref(),
        Some("expired")
    );
}
