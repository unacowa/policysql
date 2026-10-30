//! Checked-in transcripts (ADR 0024 "Determinism and purity"): one JSON line per step with
//! all four inputs and the output. Replaying `step_json` over the inputs must reproduce every
//! output byte for byte, and each scenario must still produce its transcript. They are the
//! regression fixtures of the inconsistencies ADR 0024 resolves and of #70.
//!
//! Regenerate with `WRITE_TX_TRANSCRIPTS=1 cargo test -p policysql-transaction --test
//! transcripts` after an intended change, and review the diff.

mod common;

use common::{
    Engine, FakeCompiler, LIMITS, OWNER, TranscriptLine, atomic_input, begin, command, envelope,
    execute_request, sequence_text, statement_text,
};
use policysql_transaction::machine::step_json;
use serde_json::json;
use std::path::PathBuf;

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/transactions")
}

fn begun() -> Engine {
    let mut engine = Engine::new();
    engine.run(&begin("write"));
    engine
}

/// COMMIT sent, then the owner is lost before its outcome; a successor answers the retry.
fn owner_lost_after_commit() -> Engine {
    let mut engine = begun();
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.lose();
    engine.run(&command("commit", &sequence_text(1)));
    engine.run(&command("commit", &sequence_text(1)));
    engine
}

/// COMMIT applied but the terminal record could not be stored.
fn terminal_put_failed() -> Engine {
    let mut engine = begun();
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.resolve(false, "unknown");
    engine.run(&command("commit", &sequence_text(1)));
    engine
}

/// The engine abandons its state while COMMIT is in flight; a late outcome is ignored.
fn abandon_after_commit() -> Engine {
    let mut engine = begun();
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    let commit = engine.outstanding.clone();
    engine.feed(&json!({"type": "abandon"}));
    engine.resolve(true, "unknown");
    engine.outstanding = commit;
    engine.resolve(true, "unknown");
    engine.lose();
    engine.run(&command("commit", &sequence_text(1)));
    engine
}

/// A transport error during COMMIT (inconsistency 4).
fn commit_transport_error() -> Engine {
    let mut engine = begun();
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.resolve(false, "unavailable");
    engine.settle();
    engine.run(&command("commit", &sequence_text(1)));
    engine
}

/// The timer fires while COMMIT is in flight (inconsistency 6): nothing expires it.
fn timer_during_commit() -> Engine {
    let mut engine = begun();
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    let commit = engine.outstanding.clone();
    engine.now += 10_000;
    engine.feed(&json!({"type": "timerFired"}));
    engine.outstanding = commit;
    engine.settle();
    engine.run(&command("commit", &sequence_text(1)));
    engine
}

/// The deadline passes while `committing` is being stored: no COMMIT, `expired` first.
fn deadline_after_committing() -> Engine {
    let mut engine = begun();
    engine.feed(&command("commit", &sequence_text(1)));
    engine.resolve(true, "unknown");
    engine.now += 4_000;
    engine.settle();
    engine.run(&command("commit", &sequence_text(1)));
    engine
}

/// #70: the statement is compiled and hashed from its verified text: `1e400` is rejected
/// instead of becoming NULL, and 9007199254740993 keeps its digits.
fn issue_70() -> Engine {
    let mut engine = begun();
    engine.run(&command(
        "statement",
        r#"{"sequence":1,"sql":"INSERT INTO counters (id, big) VALUES (:id, :value)","params":{"id":"x","value":9007199254740993}}"#,
    ));
    engine.run(&command(
        "statement",
        r#"{"sequence":1,"sql":"INSERT INTO counters (id, big) VALUES (:id, :value)","params":{"id":"x","value":9007199254740992}}"#,
    ));
    let mut overflow = begun();
    overflow.run(&command(
        "statement",
        r#"{"sequence":1,"sql":"INSERT INTO counters (id, ratio) VALUES (:id, :value)","params":{"id":"y","value":1e400}}"#,
    ));
    engine
        .transcript
        .extend(overflow.transcript.into_iter().map(|mut line| {
            line.isolate += 100;
            line
        }));
    engine
}

/// A record written before the switch-over (no `v`) is discarded and answered alike.
fn old_format_record() -> Engine {
    let mut engine = Engine::new();
    let old = json!({"transactionId": OWNER, "status": "committing", "commitSent": {"sequence": 1, "digest": "d"}})
        .to_string();
    engine.store = Some(old.clone());
    engine.durable = Some(old);
    engine.run(&command("commit", &sequence_text(1)));
    engine.run(&command(
        "statement",
        &statement_text(1, "SELECT id FROM projects"),
    ));
    engine
}

/// Begin, a statement and its exact retry, commit, and the commit's retry.
fn exact_retry_and_commit() -> Engine {
    let mut engine = begun();
    let text = statement_text(1, "INSERT INTO projects (id) VALUES (:id)");
    engine.run(&command("statement", &text));
    engine.run(&command("statement", &text));
    engine.run(&command("commit", &sequence_text(2)));
    engine.run(&command("commit", &sequence_text(2)));
    engine
}

/// Owner loss and timer expiry before any commit.
fn owner_loss_and_expiry() -> Engine {
    let mut engine = begun();
    engine.run(&command(
        "statement",
        &statement_text(1, "SELECT id FROM projects"),
    ));
    engine.lose();
    engine.run(&command(
        "statement",
        &statement_text(1, "SELECT id FROM projects"),
    ));
    engine.run(&command(
        "statement",
        &statement_text(2, "SELECT id FROM projects"),
    ));
    let mut expiring = begun();
    expiring.now += 4_000;
    expiring.run(&json!({"type": "timerFired"}));
    expiring.run(&command("commit", &sequence_text(1)));
    engine
        .transcript
        .extend(expiring.transcript.into_iter().map(|mut line| {
            line.isolate += 100;
            line
        }));
    engine
}

/// A statement's completion cannot be stored: `failed` is recorded from the record before it,
/// so its retry is unavailable, never replayed as done (#71 review).
fn statement_completion_put_failed() -> Engine {
    let mut engine = begun();
    let text = statement_text(1, "INSERT INTO projects (id) VALUES (:id)");
    engine.feed(&command("statement", &text));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    engine.resolve(false, "unknown");
    engine.settle();
    engine.run(&command("statement", &text));
    engine.lose();
    engine.run(&command("statement", &text));
    engine
}

const CALLBACK: &str = r#"{"sequence":1,"sql":"SELECT id FROM projects","params":{}}"#;

/// A write transaction whose insert into `audited` triggers `consistency`, with the commit fed
/// and run to its validator call.
fn validating() -> Engine {
    let mut engine = Engine::new();
    engine.configured = vec!["consistency".to_owned()];
    engine.run(&begin("write"));
    engine.run(&command(
        "statement",
        &statement_text(1, "INSERT INTO audited (id) VALUES (:id)"),
    ));
    engine.feed(&command("commit", &sequence_text(2)));
    engine.resolve(true, "unknown"); // binding checked: Persist(validating)
    engine.resolve(true, "unknown"); // validating stored: CallValidator
    engine
}

/// The validator queries the open transaction twice (the second an exact retry) and allows.
fn check_allowed_with_callbacks() -> Engine {
    let mut engine = validating();
    let token = engine.token();
    engine.run_callback(&token, CALLBACK);
    engine.run_callback(&token, CALLBACK);
    engine.settle();
    engine.run(&command("commit", &sequence_text(2)));
    engine
}

fn check_denied() -> Engine {
    let mut engine = validating();
    engine.decide(true, &json!({"version": "1", "allowed": false}));
    engine.settle();
    engine.run(&command("commit", &sequence_text(2)));
    engine
}

fn check_validator_timeout() -> Engine {
    let mut engine = validating();
    engine.resolve(false, "timeout");
    engine.settle();
    engine
}

fn check_validator_transport_error() -> Engine {
    let mut engine = validating();
    engine.resolve(false, "unavailable");
    engine.settle();
    engine
}

/// The owner is lost while its validator runs: the successor holds no capability, commands
/// are unavailable, and the timer expires the record.
fn check_owner_loss_while_validating() -> Engine {
    let mut engine = validating();
    let token = engine.token();
    engine.lose();
    engine.run_callback(&token, CALLBACK);
    engine.run(&command("commit", &sequence_text(2)));
    engine.now += 4_000;
    engine.run(&json!({"type": "timerFired"}));
    engine
}

/// The deadline passes while the validator runs: the commit is answered at once, the
/// transaction rolls back, and the validator's late allow is ignored.
fn check_expiry_and_late_verdict() -> Engine {
    let mut engine = validating();
    let validator = engine.outstanding.clone();
    engine.now += 4_000;
    engine.feed(&json!({"type": "timerFired"}));
    engine.settle();
    engine.outstanding = validator;
    engine.resolve(true, "unknown");
    engine.run(&command("commit", &sequence_text(2)));
    engine
}

/// After the verdict the capability is revoked: a callback with it is unavailable.
fn check_callback_after_revoke() -> Engine {
    let mut engine = validating();
    let token = engine.token();
    engine.settle();
    engine.run_callback(&token, CALLBACK);
    engine
}

/// Callback queries past the per-check limit (the statement limit, 8) end the transaction.
fn check_callback_limit_exhaustion() -> Engine {
    let mut engine = validating();
    let token = engine.token();
    for sequence in 1..=9 {
        let text = json!({"sequence": sequence, "sql": "SELECT id FROM projects", "params": {}});
        engine.run_callback(&token, &text.to_string());
    }
    engine.settle();
    engine
}

/// A callback with a token other than the live capability ends the transaction.
fn check_capability_tampering() -> Engine {
    let mut engine = validating();
    let token = engine.token();
    let mut tampered = token.clone().into_bytes();
    tampered[0] = if tampered[0] == b'A' { b'B' } else { b'A' };
    let tampered = String::from_utf8(tampered).unwrap_or_default();
    engine.run_callback(&tampered, CALLBACK);
    engine.settle();
    engine.run_callback(&token, CALLBACK);
    engine
}

type Scenario = fn() -> Engine;

const SCENARIOS: [(&str, Scenario); 24] = [
    (
        "commit-check-allowed-with-callbacks",
        check_allowed_with_callbacks,
    ),
    ("commit-check-denied", check_denied),
    ("commit-check-validator-timeout", check_validator_timeout),
    (
        "commit-check-validator-transport-error",
        check_validator_transport_error,
    ),
    (
        "commit-check-owner-loss-while-validating",
        check_owner_loss_while_validating,
    ),
    (
        "commit-check-expiry-and-late-verdict",
        check_expiry_and_late_verdict,
    ),
    (
        "commit-check-callback-after-revoke",
        check_callback_after_revoke,
    ),
    (
        "commit-check-callback-limit-exhaustion",
        check_callback_limit_exhaustion,
    ),
    (
        "commit-check-capability-tampering",
        check_capability_tampering,
    ),
    (
        "inconsistency-3-owner-lost-after-commit",
        owner_lost_after_commit,
    ),
    ("inconsistency-3-terminal-put-failed", terminal_put_failed),
    ("inconsistency-3-abandon-after-commit", abandon_after_commit),
    (
        "inconsistency-4-commit-transport-error",
        commit_transport_error,
    ),
    ("inconsistency-6-timer-during-commit", timer_during_commit),
    ("deadline-after-committing", deadline_after_committing),
    ("issue-70-statement-body-text", issue_70),
    ("old-format-record-discarded", old_format_record),
    ("exact-retry-and-commit", exact_retry_and_commit),
    ("owner-loss-and-expiry", owner_loss_and_expiry),
    (
        "statement-completion-put-failed",
        statement_completion_put_failed,
    ),
    ("atomic-direct-keyed-replay", atomic_direct_keyed_replay),
    ("atomic-expectation-rollback", atomic_expectation_rollback),
    ("atomic-commit-failure", atomic_commit_failure),
    ("atomic-owner-commit-check", atomic_owner_commit_check),
];

// ---- atomic execution (pull request 6) ------------------------------------------------------

const ATOMIC_KEY: &str = "request-key-0001";
const OWNER_KEY_HASH: &str = "0123456789abcdef0123456789abcdef00000000000000000000000000000000";
const OWNER_FINGERPRINT: &str = "f00df00df00df00df00df00df00df00df00df00df00df00df00df00df00df00d";

fn project_insert(id: &str) -> serde_json::Value {
    envelope(&[(
        "INSERT INTO projects (id, name) VALUES (:id, :name)",
        json!({"id": id, "name": id}),
    )])
}

/// Direct placement: a keyed write, its replay, and a conflicting body on the same key.
fn atomic_direct_keyed_replay() -> Engine {
    let mut engine = Engine::atomic(false);
    engine.run(&execute_request(&project_insert("p1"), Some(ATOMIC_KEY)));
    engine.run(&execute_request(&project_insert("p1"), Some(ATOMIC_KEY)));
    engine.run(&execute_request(&project_insert("p2"), Some(ATOMIC_KEY)));
    engine
}

/// Direct placement: an expectation fails, the envelope rolls back, nothing is stored.
fn atomic_expectation_rollback() -> Engine {
    let mut engine = Engine::atomic(false);
    let body = json!({"statements": [{"sql": "INSERT INTO projects (id, name) VALUES (:id, :name)",
        "params": {"id": "p1", "name": "p1"}, "expect": {"affectedRows": 2}}]});
    engine.run(&execute_request(&body, Some(ATOMIC_KEY)));
    engine
}

/// Direct placement: COMMIT fails in transport; the reply is not a rejection.
fn atomic_commit_failure() -> Engine {
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&project_insert("p1"), Some(ATOMIC_KEY)));
    for _ in 0..5 {
        engine.resolve(true, "unknown");
    }
    engine.resolve(false, "unavailable");
    engine.settle();
    engine
}

/// Owner placement: a keyed write whose commit check allows it, then its retry, which
/// resolves through the idempotency row.
fn atomic_owner_commit_check() -> Engine {
    let mut engine = Engine::atomic(true);
    engine.configured = vec!["consistency".to_owned()];
    let body = envelope(&[(
        "INSERT INTO audited (id, note) VALUES (:id, :note)",
        json!({"id": "a1", "note": "a1"}),
    )]);
    let input = atomic_input(&body, Some([OWNER_KEY_HASH, OWNER_FINGERPRINT]));
    engine.run(&input);
    engine.run(&input);
    engine
}

fn jsonl(lines: &[TranscriptLine]) -> String {
    lines
        .iter()
        .map(|line| serde_json::to_string(line).unwrap_or_default() + "\n")
        .collect()
}

#[test]
fn transcripts_replay_byte_for_byte() {
    let write = std::env::var_os("WRITE_TX_TRANSCRIPTS").is_some();
    for (name, scenario) in SCENARIOS {
        let path = directory().join(format!("{name}.jsonl"));
        let generated = jsonl(&scenario().transcript);
        if write {
            std::fs::create_dir_all(directory()).unwrap_or_else(|_| unreachable!());
            std::fs::write(&path, &generated).unwrap_or_else(|_| unreachable!());
        }
        let stored = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            stored, generated,
            "{name}: the scenario no longer produces its transcript"
        );
        let mut compiler = FakeCompiler::new();
        let mut isolate = None;
        for (number, text) in stored.lines().enumerate() {
            let line: TranscriptLine =
                serde_json::from_str(text).unwrap_or_else(|_| unreachable!());
            if isolate != Some(line.isolate) {
                compiler = FakeCompiler::new();
                isolate = Some(line.isolate);
            }
            let output = step_json(
                &compiler,
                &LIMITS,
                line.durable.as_deref(),
                line.volatile.as_deref(),
                &line.event,
                &line.host,
            );
            assert_eq!(output, line.output, "{name}:{}", number + 1);
        }
    }
}

#[test]
#[allow(clippy::too_many_lines)]
fn transcripts_record_the_decided_answers() {
    let answers = |engine: &Engine| -> Vec<String> {
        engine
            .observed
            .replies
            .iter()
            .map(|(_, reply)| {
                reply["error"]["code"].as_str().map_or_else(
                    || reply["value"]["status"].as_str().unwrap_or("").to_owned(),
                    str::to_owned,
                )
            })
            .collect()
    };
    assert_eq!(
        answers(&owner_lost_after_commit()),
        [
            "active",
            "POLICYSQL_COMMIT_OUTCOME_UNKNOWN",
            "POLICYSQL_COMMIT_OUTCOME_UNKNOWN"
        ]
    );
    assert_eq!(
        answers(&terminal_put_failed()),
        ["active", "committed", "POLICYSQL_COMMIT_OUTCOME_UNKNOWN"]
    );
    assert_eq!(
        answers(&abandon_after_commit()),
        ["active", "POLICYSQL_COMMIT_OUTCOME_UNKNOWN"]
    );
    assert_eq!(
        answers(&commit_transport_error()),
        [
            "active",
            "POLICYSQL_COMMIT_OUTCOME_UNKNOWN",
            "POLICYSQL_COMMIT_OUTCOME_UNKNOWN"
        ]
    );
    assert_eq!(
        answers(&timer_during_commit()),
        ["active", "committed", "committed"]
    );
    assert_eq!(
        answers(&deadline_after_committing()),
        [
            "active",
            "POLICYSQL_TRANSACTION_UNAVAILABLE",
            "POLICYSQL_TRANSACTION_UNAVAILABLE"
        ]
    );
    assert_eq!(
        answers(&issue_70()),
        ["active", "active", "POLICYSQL_TRANSACTION_CONFLICT"]
    );
    assert_eq!(
        answers(&old_format_record()),
        [
            "POLICYSQL_COMMIT_OUTCOME_UNKNOWN",
            "POLICYSQL_TRANSACTION_UNAVAILABLE"
        ]
    );
    let callbacks = |engine: &Engine| -> Vec<String> {
        engine
            .observed
            .callback_replies
            .iter()
            .map(|reply| {
                reply["error"]["code"]
                    .as_str()
                    .map_or_else(|| "ok".to_owned(), str::to_owned)
            })
            .collect()
    };
    let allowed = check_allowed_with_callbacks();
    assert_eq!(
        answers(&allowed),
        ["active", "active", "committed", "committed"]
    );
    assert_eq!(callbacks(&allowed), ["ok", "ok"]);
    assert_eq!(
        answers(&check_denied()),
        [
            "active",
            "active",
            "POLICYSQL_COMMIT_CHECK_REJECTED",
            "POLICYSQL_TRANSACTION_UNAVAILABLE"
        ]
    );
    for engine in [check_validator_timeout(), check_validator_transport_error()] {
        assert_eq!(
            answers(&engine),
            ["active", "active", "POLICYSQL_COMMIT_CHECK_REJECTED"]
        );
    }
    let lost = check_owner_loss_while_validating();
    assert_eq!(
        answers(&lost),
        ["active", "active", "POLICYSQL_TRANSACTION_UNAVAILABLE"]
    );
    assert_eq!(callbacks(&lost), ["POLICYSQL_TRANSACTION_UNAVAILABLE"]);
    assert_eq!(
        answers(&check_expiry_and_late_verdict()),
        [
            "active",
            "active",
            "POLICYSQL_COMMIT_CHECK_REJECTED",
            "POLICYSQL_TRANSACTION_UNAVAILABLE"
        ]
    );
    let revoked = check_callback_after_revoke();
    assert_eq!(answers(&revoked), ["active", "active", "committed"]);
    assert_eq!(callbacks(&revoked), ["POLICYSQL_TRANSACTION_UNAVAILABLE"]);
    let exhausted = check_callback_limit_exhaustion();
    assert_eq!(
        callbacks(&exhausted).last().map(String::as_str),
        Some("POLICYSQL_TRANSACTION_CONFLICT")
    );
    assert_eq!(callbacks(&exhausted).len(), 9);
    assert_eq!(
        answers(&exhausted).last().map(String::as_str),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
    let tampered = check_capability_tampering();
    assert_eq!(
        callbacks(&tampered),
        [
            "POLICYSQL_TRANSACTION_UNAVAILABLE",
            "POLICYSQL_TRANSACTION_UNAVAILABLE"
        ]
    );
    assert_eq!(
        answers(&tampered).last().map(String::as_str),
        Some("POLICYSQL_COMMIT_CHECK_REJECTED")
    );
    for engine in [&allowed, &revoked] {
        assert_eq!(engine.observed.commits_emitted, 1);
    }
    for engine in [&lost, &exhausted, &tampered] {
        assert_eq!(engine.observed.commits_emitted, 0);
    }
    assert_eq!(
        answers(&atomic_direct_keyed_replay()),
        ["committed", "committed", "POLICYSQL_IDEMPOTENCY_CONFLICT"]
    );
    let expectation = atomic_expectation_rollback();
    assert_eq!(answers(&expectation), ["POLICYSQL_EXPECTATION_FAILED"]);
    assert_eq!(expectation.observed.commits_emitted, 0);
    assert_eq!(expectation.observed.rollbacks_emitted, 1);
    assert_eq!(
        answers(&atomic_commit_failure()),
        ["POLICYSQL_DATABASE_UNAVAILABLE"]
    );
    let owner = atomic_owner_commit_check();
    assert_eq!(answers(&owner), ["committed", "committed"]);
    assert_eq!(owner.observed.commits_emitted, 1);
    assert_eq!(owner.observed.validator_calls.len(), 1);
    assert_eq!(
        answers(&statement_completion_put_failed()),
        [
            "active",
            "POLICYSQL_INTERNAL",
            "POLICYSQL_TRANSACTION_UNAVAILABLE",
            "POLICYSQL_TRANSACTION_UNAVAILABLE"
        ]
    );
}
