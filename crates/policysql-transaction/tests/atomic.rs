//! Atomic execution in the step machine (ADR 0024 pull request 6): the direct placement in the
//! engine and the owner placement with commit checks, keyed and unkeyed, replay, conflict,
//! rollback on a failed expectation, the cumulative result limits, and COMMIT outcomes.

mod common;

use common::{
    Engine, OWNER, STATEMENT_LIMITS, T0, atomic_input, code, envelope, execute_request, phase_of,
};
use policysql_transaction::machine::io::ErrorDetail;
use policysql_transaction::machine::{CoreError, StatementLimits};
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
/// `POLICYSQL_INTERNAL` on the idempotency lookup and insert. A stored response over the lookup
/// bound (a row written before the bounds existed) belongs to a request that may have committed:
/// reading it is an unknown outcome (500), never a definite 413 (ADR 0007), never
/// `IDEMPOTENCY_CONFLICT`, and the request never runs again.
#[test]
fn a_limit_failure_is_limit_exceeded_on_the_envelope_and_internal_on_the_lookup_and_the_insert() {
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

/// Issue #97: a reply the transport could not read (a response over its bound, a BLOB over the
/// value bound, a stalled body) leaves the pipeline's outcome open. Hrana keeps running the rest
/// of a pipeline after an error, and an error can make SQLite roll the explicit transaction back;
/// a later write then runs in autocommit and commits. A `limit` on an envelope with a write after
/// its first statement is therefore 500 `POLICYSQL_INTERNAL` (an unknown outcome), never a
/// definite 413. A write at the first statement only, or a read-only envelope, keeps 413: an
/// auto-rollback of the transaction leaves no later write that could commit.
#[test]
fn a_limit_failure_after_a_later_write_is_internal_not_a_definite_rejection() {
    let write = |id: &str| {
        (
            "INSERT INTO projects (id, name) VALUES (:id, :name)",
            json!({"id": id, "name": id}),
        )
    };
    let read = ("SELECT id, name FROM projects", json!({}));
    let update = ("UPDATE projects SET name = 'x'", json!({}));
    let delete = ("DELETE FROM projects", json!({}));
    for (label, statements, expected) in [
        (
            "read then insert",
            vec![read.clone(), write("p2")],
            "POLICYSQL_INTERNAL",
        ),
        (
            "insert then insert",
            vec![write("p1"), write("p2")],
            "POLICYSQL_INTERNAL",
        ),
        (
            "read then update",
            vec![read.clone(), update],
            "POLICYSQL_INTERNAL",
        ),
        (
            "read then delete",
            vec![read.clone(), delete],
            "POLICYSQL_INTERNAL",
        ),
        (
            "insert then read",
            vec![write("p1"), read.clone()],
            "POLICYSQL_LIMIT_EXCEEDED",
        ),
        (
            "read then read",
            vec![read.clone(), read],
            "POLICYSQL_LIMIT_EXCEEDED",
        ),
    ] {
        // Direct and owner: the classification does not depend on the placement. An owner runs
        // write envelopes only, so the read-only envelope is direct-only.
        let write_envelope = statements.iter().any(|(sql, _)| !sql.starts_with("SELECT"));
        for owner in [false, true] {
            if owner && !write_envelope {
                continue;
            }
            let mut engine = Engine::atomic(owner);
            let body = envelope(&statements);
            let input = if owner {
                atomic_input(&body, None)
            } else {
                execute_request(&body, None)
            };
            engine.feed(&input);
            // Direct: checkBinding, open. Owner: checkBinding, open, persist, setTimer.
            for _ in 0..if owner { 4 } else { 2 } {
                engine.resolve(true, "unknown");
            }
            assert_eq!(
                engine
                    .outstanding
                    .as_ref()
                    .map(|effect| effect["type"].clone()),
                Some(json!("execute")),
                "{label} owner={owner}: awaited {:?}",
                engine.observed.awaited
            );
            engine.resolve(false, "limit");
            engine.settle();
            let reply = engine.last_reply().cloned().unwrap_or(Value::Null);
            assert_eq!(
                code(&reply),
                Some(expected),
                "{label} owner={owner}: {reply}"
            );
            assert_eq!(engine.observed.commits_emitted, 0, "{label} owner={owner}");
            assert_eq!(
                engine.observed.rollbacks_emitted, 1,
                "{label} owner={owner}"
            );
            assert_eq!(engine.compiler.live_handles(), 0, "{label} owner={owner}");
        }
    }
}

/// ADR 0027 pull request 4: the database's complexity refusal (`complex` with the statement
/// index) is the client's `POLICYSQL_SQL_TOO_COMPLEX` on the envelope, rolled back before COMMIT,
/// `POLICYSQL_INTERNAL` on the idempotency lookup or insert, and never a COMMIT's outcome.
#[test]
fn a_complexity_refusal_is_too_complex_on_the_envelope_and_never_on_commit_or_the_idempotency_row()
{
    // Effects of a keyed write: checkBinding, open, lookup, envelope, insert, commit.
    for (successes, expected) in [
        (2, "POLICYSQL_INTERNAL"),
        (3, "POLICYSQL_SQL_TOO_COMPLEX"),
        (4, "POLICYSQL_INTERNAL"),
    ] {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), Some(KEY)));
        for _ in 0..successes {
            engine.resolve(true, "unknown");
        }
        let effect = engine.outstanding.take().unwrap_or(Value::Null);
        engine.feed(&json!({
            "type": "executeFailed", "id": effect["id"], "class": "complex",
            "statement": 0, "cause": "columns",
        }));
        let log = engine
            .transcript
            .last()
            .map(|line| line.output.clone())
            .unwrap_or_default();
        engine.settle();
        let reply = engine.last_reply().cloned().unwrap_or(Value::Null);
        assert_eq!(
            code(&reply),
            Some(expected),
            "after {successes} effects: {reply}"
        );
        if expected == "POLICYSQL_SQL_TOO_COMPLEX" {
            assert_eq!(reply["error"]["path"], "/statements/0");
            assert_eq!(reply["error"]["detail"], json!({"complexity": "columns"}));
            assert!(
                ErrorDetail::allowed("POLICYSQL_SQL_TOO_COMPLEX", reply["error"].get("detail")),
                "{reply}"
            );
            assert!(log.contains("\"event\":\"sql_too_complex\""), "{log}");
            assert!(log.contains("\"cause\":\"columns\""), "{log}");
        } else {
            assert!(!log.contains("sql_too_complex"), "{log}");
        }
        assert_eq!(engine.observed.commits_emitted, 0);
        assert_eq!(engine.observed.rollbacks_emitted, 1);
        assert_eq!(engine.idempotency_rows, Vec::<[String; 3]>::new());
        assert_eq!(engine.compiler.live_handles(), 0);
    }
    // A COMMIT is never classified as complexity: its failure stays `POLICYSQL_INTERNAL`.
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&insert("p1"), None));
    for _ in 0..3 {
        engine.resolve(true, "unknown");
    }
    engine.resolve(false, "complex");
    engine.settle();
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_INTERNAL")
    );
    // The index of the failed statement is the event's, bounded by the envelope limit.
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&insert("p1"), None));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    let effect = engine.outstanding.take().unwrap_or(Value::Null);
    engine.feed(&json!({
        "type": "executeFailed", "id": effect["id"], "class": "complex", "statement": 4_000_000_000_u64,
    }));
    engine.settle();
    assert_eq!(
        engine
            .last_reply()
            .map(|reply| reply["error"]["path"].clone()),
        Some(json!("/statements/0"))
    );
    // A cause the adapter did not name (or named outside the list) is `database`.
    assert_eq!(
        engine
            .last_reply()
            .map(|reply| reply["error"]["detail"].clone()),
        Some(json!({"complexity": "database"}))
    );
}

/// A complexity class outside a statement's execution (the binding check, the open) is answered
/// with its required detail, so the code never leaves the machine without one (#145 pull request C).
#[test]
fn a_complexity_class_outside_a_statement_still_carries_its_detail() {
    for successes in [0, 1] {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), Some(KEY)));
        for _ in 0..successes {
            engine.resolve(true, "unknown");
        }
        engine.resolve(false, "complex");
        engine.settle();
        let reply = engine.last_reply().cloned().unwrap_or(Value::Null);
        assert_eq!(
            code(&reply),
            Some("POLICYSQL_SQL_TOO_COMPLEX"),
            "after {successes} effects: {reply}"
        );
        assert!(
            ErrorDetail::allowed("POLICYSQL_SQL_TOO_COMPLEX", reply["error"].get("detail")),
            "{reply}"
        );
        assert_eq!(reply["error"]["detail"], json!({"complexity": "database"}));
    }
}

/// ADR 0030: the database's constraint violation (`constraint` with the statement index and a
/// kind) is the client's 409 `POLICYSQL_CONSTRAINT_VIOLATION` on the envelope, rolled back before
/// COMMIT, with a fixed message and `detail` per kind and a log record with fixed keys;
/// `POLICYSQL_INTERNAL` on the idempotency lookup or insert; and never a COMMIT's outcome.
#[test]
fn a_constraint_violation_is_a_conflict_on_the_envelope_and_never_on_commit_or_the_idempotency_row()
{
    // Effects of a keyed write: checkBinding, open, lookup, envelope, insert, commit.
    for (successes, expected) in [
        (2, "POLICYSQL_INTERNAL"),
        (3, "POLICYSQL_CONSTRAINT_VIOLATION"),
        (4, "POLICYSQL_INTERNAL"),
    ] {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), Some(KEY)));
        for _ in 0..successes {
            engine.resolve(true, "unknown");
        }
        let effect = engine.outstanding.take().unwrap_or(Value::Null);
        engine.feed(&json!({
            "type": "executeFailed", "id": effect["id"], "class": "constraint",
            "statement": 0, "constraint": "unique", "databaseCode": "SQLITE_CONSTRAINT",
        }));
        let log = engine
            .transcript
            .last()
            .map(|line| line.output.clone())
            .unwrap_or_default();
        engine.settle();
        let reply = engine.last_reply().cloned().unwrap_or(Value::Null);
        assert_eq!(
            code(&reply),
            Some(expected),
            "after {successes} effects: {reply}"
        );
        if expected == "POLICYSQL_CONSTRAINT_VIOLATION" {
            assert_eq!(reply["error"]["path"], "/statements/0");
            assert_eq!(
                reply["error"]["message"],
                "The statement violates a unique constraint."
            );
            assert_eq!(reply["error"]["detail"], json!({"constraint": "unique"}));
            assert!(
                log.contains("\"event\":\"database_constraint_violation\""),
                "{log}"
            );
            assert!(log.contains("\"constraint\":\"unique\""), "{log}");
            assert!(
                log.contains("\"databaseCode\":\"SQLITE_CONSTRAINT\""),
                "{log}"
            );
            assert!(log.contains("\"statementIndex\":0"), "{log}");
            assert!(!log.contains("database_error_unclassified"), "{log}");
        } else {
            assert!(reply["error"].get("detail").is_none(), "{reply}");
            assert!(!log.contains("database_constraint_violation"), "{log}");
            // The 500 is traceable: the database's code only, as `database_error_unclassified`.
            assert!(
                log.contains("\"event\":\"database_error_unclassified\""),
                "{log}"
            );
            assert!(log.contains("\"code\":\"SQLITE_CONSTRAINT\""), "{log}");
        }
        assert_eq!(engine.observed.commits_emitted, 0);
        assert_eq!(engine.observed.rollbacks_emitted, 1);
        assert_eq!(engine.idempotency_rows, Vec::<[String; 3]>::new());
        assert_eq!(engine.compiler.live_handles(), 0);
    }
    // A COMMIT is never classified as a constraint violation, deferred foreign key or not.
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&insert("p1"), None));
    for _ in 0..3 {
        engine.resolve(true, "unknown");
    }
    engine.resolve(false, "constraint");
    engine.settle();
    assert_eq!(
        code(engine.last_reply().unwrap_or(&Value::Null)),
        Some("POLICYSQL_INTERNAL")
    );
    // The same class on every other effect is never a 409 (open, binding check, forward).
    for failing in 0..2 {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), Some(KEY)));
        for _ in 0..failing {
            engine.resolve(true, "unknown");
        }
        engine.resolve(false, "constraint");
        engine.settle();
        let reply = engine.last_reply().cloned().unwrap_or(Value::Null);
        assert_eq!(code(&reply), Some("POLICYSQL_INTERNAL"), "{reply}");
        assert_eq!(engine.observed.commits_emitted, 0);
    }
}

/// The kind and the index come from the event and are bounded: an unknown or empty name, or no
/// name, is `other`; an index at or over the envelope limit is the first statement.
#[test]
fn the_kind_and_the_index_of_a_constraint_violation_are_bounded() {
    let kinds = [
        (json!("unique"), "unique", "unique"),
        (json!("not_null"), "not_null", "NOT NULL"),
        (json!("foreign_key"), "foreign_key", "foreign key"),
        (json!("check"), "check", "CHECK"),
        (json!("other"), "other", "database constraint"),
        (json!("primary_key"), "other", "database constraint"),
        (json!(""), "other", "database constraint"),
        (json!("UNIQUE"), "other", "database constraint"),
        (Value::Null, "other", "database constraint"),
    ];
    for (name, kind, text) in kinds {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), None));
        engine.resolve(true, "unknown");
        engine.resolve(true, "unknown");
        let effect = engine.outstanding.take().unwrap_or(Value::Null);
        engine.feed(&json!({
            "type": "executeFailed", "id": effect["id"], "class": "constraint", "constraint": name,
        }));
        engine.settle();
        let reply = engine.last_reply().cloned().unwrap_or(Value::Null);
        assert_eq!(
            code(&reply),
            Some("POLICYSQL_CONSTRAINT_VIOLATION"),
            "{name}: {reply}"
        );
        assert_eq!(
            reply["error"]["detail"],
            json!({"constraint": kind}),
            "{name}"
        );
        assert!(
            reply["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains(text)),
            "{name}: {reply}"
        );
        assert_eq!(reply["error"]["path"], "/statements/0");
    }
    // No `constraint` field at all.
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&insert("p1"), None));
    engine.resolve(true, "unknown");
    engine.resolve(true, "unknown");
    let effect = engine.outstanding.take().unwrap_or(Value::Null);
    engine.feed(&json!({"type": "executeFailed", "id": effect["id"], "class": "constraint"}));
    engine.settle();
    assert_eq!(
        engine
            .last_reply()
            .map(|reply| reply["error"]["detail"].clone()),
        Some(json!({"constraint": "other"}))
    );
    // An index over the envelope limit is the first statement; one inside it is kept.
    for (statement, path) in [
        (4_000_000_000_u64, "/statements/0"),
        (8, "/statements/0"),
        (7, "/statements/7"),
        (1, "/statements/1"),
    ] {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), None));
        engine.resolve(true, "unknown");
        engine.resolve(true, "unknown");
        let effect = engine.outstanding.take().unwrap_or(Value::Null);
        engine.feed(&json!({
            "type": "executeFailed", "id": effect["id"], "class": "constraint",
            "statement": statement, "constraint": "check",
        }));
        engine.settle();
        assert_eq!(
            engine
                .last_reply()
                .map(|reply| reply["error"]["path"].clone()),
            Some(json!(path))
        );
    }
    // The log's database code is the safe form or UNKNOWN, never the raw text.
    for (reported, logged) in [
        ("SQLITE_CONSTRAINT", "\"SQLITE_CONSTRAINT\""),
        ("has space\n", "\"UNKNOWN\""),
    ] {
        let mut engine = Engine::atomic(false);
        engine.feed(&execute_request(&insert("p1"), None));
        engine.resolve(true, "unknown");
        engine.resolve(true, "unknown");
        let effect = engine.outstanding.take().unwrap_or(Value::Null);
        engine.feed(&json!({
            "type": "executeFailed", "id": effect["id"], "class": "constraint",
            "constraint": "unique", "databaseCode": reported,
        }));
        let log = engine
            .transcript
            .last()
            .map(|line| line.output.clone())
            .unwrap_or_default();
        assert!(log.contains(&format!("\"databaseCode\":{logged}")), "{log}");
    }
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

/// ADR 0030: a forwarded owner reply carries `detail` only as the table of its code allows.
#[test]
fn a_forwarded_reply_keeps_a_valid_detail_and_rejects_a_forged_one() {
    let violation = |detail: Option<Value>| {
        let mut error = json!({
            "code": "POLICYSQL_CONSTRAINT_VIOLATION", "message": "m", "path": "/statements/0",
        });
        if let Some(detail) = detail {
            error["detail"] = detail;
        }
        json!({"ok": false, "error": error})
    };
    let valid = violation(Some(json!({"constraint": "unique"})));
    let mut engine = Engine::atomic(false);
    engine.forward_reply = valid.clone();
    let reply = engine.run(&execute_request(&audit("a1"), None));
    assert_eq!(reply, valid, "a valid detail is relayed as it is");
    for forged in [
        violation(None),
        violation(Some(json!({}))),
        violation(Some(json!({"constraint": "unique", "column": "x"}))),
        violation(Some(json!({"constraint": "unique", "cause": null}))),
        violation(Some(json!({"constraint": "primary_key"}))),
        violation(Some(json!({"constraint": null}))),
        violation(Some(json!(["unique"]))),
        violation(Some(json!("unique"))),
        violation(Some(Value::Null)),
        json!({"ok": false, "error": {
            "code": "POLICYSQL_FORBIDDEN_COLUMN", "message": "m", "path": null,
            "detail": {"constraint": "unique"},
        }}),
        json!({"ok": false, "error": {
            "code": "POLICYSQL_FORBIDDEN_COLUMN", "message": "m", "path": null, "detail": null,
        }}),
        json!({"ok": false, "error": {
            "code": "POLICYSQL_FORBIDDEN_COLUMN", "message": "m", "path": null, "detail": {},
        }}),
        json!({"ok": false, "error": {
            "code": "POLICYSQL_CONSTRAINT_VIOLATION", "message": "m", "path": null,
            "detail": {"constraint": "unique"}, "extra": 1,
        }}),
    ] {
        let mut engine = Engine::atomic(false);
        engine.forward_reply = forged.clone();
        let reply = engine.run(&execute_request(&audit("a2"), None));
        assert_eq!(
            code(&reply),
            Some("POLICYSQL_INTERNAL"),
            "{forged} -> {reply}"
        );
        let logged = engine
            .transcript
            .iter()
            .any(|line| line.output.contains("owner_reply_rejected"));
        assert!(logged, "{forged}: the rejection is logged");
    }
    // A code outside the table without a detail still passes.
    engine.forward_reply = json!({"ok": false, "error": {"code": "POLICYSQL_FORBIDDEN_COLUMN", "message": "m", "path": null}});
    let plain = engine.run(&execute_request(&audit("a3"), None));
    assert_eq!(code(&plain), Some("POLICYSQL_FORBIDDEN_COLUMN"));
}

/// ADR 0030 amendment: a forwarded `POLICYSQL_OUTCOME_UNKNOWN` is relayed only with its `cause`
/// in the fixed form; anything else an owner could say is a forgery.
#[test]
#[allow(clippy::too_many_lines)]
fn a_forwarded_outcome_unknown_keeps_a_valid_cause_and_rejects_a_forged_one() {
    let unknown = |detail: Option<Value>| {
        let mut error = json!({
            "code": "POLICYSQL_OUTCOME_UNKNOWN", "message": "m", "path": null,
        });
        if let Some(detail) = detail {
            error["detail"] = detail;
        }
        json!({"ok": false, "error": error})
    };
    let cause =
        |code: Value, path: Value| json!({"cause": {"code": code, "path": path, "detail": null}});
    let detailed = |code: &str, detail: Value| json!({"cause": {"code": code, "path": "/statements/0", "detail": detail}});
    for valid in [
        unknown(Some(detailed(
            "POLICYSQL_UNSUPPORTED_SQL",
            json!({"feature": "star"}),
        ))),
        unknown(Some(detailed(
            "POLICYSQL_INVALID_SQL",
            json!({"span": {"start": 7, "end": 11}}),
        ))),
        unknown(Some(detailed(
            "POLICYSQL_SQL_TOO_COMPLEX",
            json!({"complexity": "height"}),
        ))),
        unknown(Some(cause(
            json!("POLICYSQL_MISSING_POLICY"),
            json!("/statements/0"),
        ))),
        unknown(Some(cause(
            json!("POLICYSQL_FORBIDDEN_ACCESS"),
            Value::Null,
        ))),
        unknown(Some(cause(
            json!("POLICYSQL_REQUEST_TOO_LARGE"),
            json!("/statements/12/sql"),
        ))),
    ] {
        let mut engine = Engine::atomic(false);
        engine.forward_reply = valid.clone();
        let reply = engine.run(&execute_request(&audit("a1"), None));
        assert_eq!(reply, valid, "a valid cause is relayed as it is");
    }
    for forged in [
        unknown(Some(detailed("POLICYSQL_UNSUPPORTED_SQL", Value::Null))),
        unknown(Some(detailed(
            "POLICYSQL_INVALID_SQL",
            json!({"feature": "star"}),
        ))),
        unknown(Some(detailed(
            "POLICYSQL_UNSUPPORTED_SQL",
            json!({"feature": "nope"}),
        ))),
        unknown(Some(detailed(
            "POLICYSQL_INVALID_SQL",
            json!({"span": {"start": 3, "end": 2}}),
        ))),
        unknown(Some(detailed(
            "POLICYSQL_FORBIDDEN_COLUMN",
            json!({"feature": "star"}),
        ))),
        unknown(Some(detailed(
            "POLICYSQL_INVALID_SQL",
            json!({"cause": {"code": "POLICYSQL_INVALID_SQL", "path": null, "detail": null}}),
        ))),
        unknown(None),
        unknown(Some(json!({}))),
        unknown(Some(json!({"cause": null}))),
        unknown(Some(json!({"cause": []}))),
        unknown(Some(json!({"cause": "x"}))),
        unknown(Some(json!({"constraint": "unique"}))),
        unknown(Some(json!({
            "cause": {"code": "POLICYSQL_INVALID_SQL", "path": null}, "constraint": "unique",
        }))),
        unknown(Some(json!({"cause": {"code": "POLICYSQL_INVALID_SQL"}}))),
        unknown(Some(json!({"cause": {"path": null}}))),
        unknown(Some(json!({
            "cause": {"code": "POLICYSQL_INVALID_SQL", "path": null, "message": "x"},
        }))),
        unknown(Some(cause(
            json!("POLICYSQL_CONSTRAINT_VIOLATION"),
            Value::Null,
        ))),
        unknown(Some(cause(json!("POLICYSQL_SCHEMA_MISMATCH"), Value::Null))),
        unknown(Some(cause(json!("FORBIDDEN_COLUMN"), Value::Null))),
        unknown(Some(cause(json!(7), Value::Null))),
        unknown(Some(cause(
            json!("POLICYSQL_INVALID_SQL"),
            json!("/statements/01"),
        ))),
        unknown(Some(cause(
            json!("POLICYSQL_INVALID_SQL"),
            json!("/statements/0/params"),
        ))),
        unknown(Some(cause(json!("POLICYSQL_INVALID_SQL"), json!(0)))),
        json!({"ok": false, "error": {
            "code": "POLICYSQL_CONSTRAINT_VIOLATION", "message": "m", "path": "/statements/0",
            "detail": {"constraint": "unique", "cause": {"code": "POLICYSQL_INVALID_SQL", "path": null}},
        }}),
        json!({"ok": false, "error": {
            "code": "POLICYSQL_INVALID_SQL", "message": "m", "path": null,
            "detail": {"cause": {"code": "POLICYSQL_INVALID_SQL", "path": null}},
        }}),
    ] {
        let mut engine = Engine::atomic(false);
        engine.forward_reply = forged.clone();
        let reply = engine.run(&execute_request(&audit("a2"), None));
        assert_eq!(
            code(&reply),
            Some("POLICYSQL_INTERNAL"),
            "{forged} -> {reply}"
        );
        let logged = engine
            .transcript
            .iter()
            .any(|line| line.output.contains("owner_reply_rejected"));
        assert!(logged, "{forged}: the rejection is logged");
    }
}

/// A forward that fails with the class `constraint` is an adapter fault, not a 409.
#[test]
fn a_constraint_class_on_a_failed_forward_is_internal() {
    let mut engine = Engine::atomic(false);
    engine.feed(&execute_request(&audit("a1"), Some(KEY)));
    engine.resolve(true, "unknown");
    let forward = engine.outstanding.clone().unwrap_or_default();
    assert_eq!(forward["type"], "forward");
    engine.resolve(false, "constraint");
    engine.settle();
    let reply = engine.last_reply().cloned().unwrap_or(Value::Null);
    assert_eq!(code(&reply), Some("POLICYSQL_INTERNAL"), "{reply}");
    assert!(reply["error"].get("detail").is_none(), "{reply}");
}

/// The owner placement's execute path has the same rule: a constraint violation of the envelope
/// is a 409, on no other effect.
#[test]
fn the_owner_answers_a_constraint_violation_of_the_envelope_and_of_nothing_else() {
    for failing in 0..11 {
        let mut engine = owner_engine();
        engine.feed(&atomic_input(&audit("a1"), None));
        for _ in 0..failing {
            if engine.resolve(true, "unknown").is_none() {
                break;
            }
        }
        let Some(effect) = engine.outstanding.clone() else {
            continue;
        };
        let envelope = effect["type"] == "execute";
        engine.resolve(false, "constraint");
        engine.settle();
        let reply = engine.last_reply().cloned().unwrap_or(Value::Null);
        if envelope {
            assert_eq!(
                code(&reply),
                Some("POLICYSQL_CONSTRAINT_VIOLATION"),
                "effect {failing}: {reply}"
            );
        } else {
            assert_ne!(
                code(&reply),
                Some("POLICYSQL_CONSTRAINT_VIOLATION"),
                "effect {failing} ({}): {reply}",
                effect["type"]
            );
        }
        // Only a failure of the envelope itself stops short of COMMIT.
        if envelope {
            assert_eq!(engine.observed.commits_emitted, 0);
        }
    }
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

const NEXT_SNAPSHOT: &str = "sqlite-turso-v1:schema_2:policy_2:abi-15";

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

// ---- #85 path 1: a keyed compile failure after a committed write ------------------------------

/// A keyed execute that committed, then a deployment whose compile rejects it (a policy, role,
/// schema, or `expected` change): the retry is the unknown outcome, never the compile error.
/// The stored result is not replayed (the current authorization did not pass), nothing is
/// looked up, and a later deployment that compiles it again replays it.
#[test]
fn a_keyed_compile_failure_after_a_commit_is_the_unknown_outcome_on_both_placements() {
    for (owner, error_code) in [
        (false, "POLICYSQL_FORBIDDEN_OPERATION"),
        (false, "POLICYSQL_STALE_OPERATION"),
        (false, "POLICYSQL_INVALID_SQL"),
        (true, "POLICYSQL_FORBIDDEN_OPERATION"),
        (true, "POLICYSQL_STALE_OPERATION"),
        (true, "POLICYSQL_INVALID_SQL"),
    ] {
        let mut engine = placed(owner);
        let first = engine.run(&keyed(owner, &insert("p1")));
        assert_eq!(first["ok"], true, "owner={owner}: {first}");
        assert_eq!(engine.observed.envelope_executes, 1, "owner={owner}");
        assert_eq!(engine.idempotency_rows.len(), 1, "owner={owner}");
        let awaited = engine.observed.awaited.len();

        let mut refusal = CoreError::new(error_code, "The operation is no longer permitted.");
        refusal.path = Some("/statements/0".to_owned());
        engine.compiler.reject = Some(refusal);
        let retry = engine.run(&keyed(owner, &insert("p1")));
        assert_eq!(
            code(&retry),
            Some("POLICYSQL_OUTCOME_UNKNOWN"),
            "owner={owner}, {error_code}: {retry}"
        );
        assert_eq!(
            retry["error"]["message"],
            "This request was not executed. The outcome of an earlier request with the same \
             Idempotency-Key is unknown.",
            "owner={owner}, {error_code}"
        );
        assert_eq!(retry["error"]["path"], Value::Null);
        assert_eq!(
            retry["error"]["detail"],
            json!({"cause": {"code": error_code, "path": "/statements/0", "detail": null}}),
            "owner={owner}, {error_code}: the compile's code and path"
        );
        assert!(
            ErrorDetail::allowed(
                retry["error"]["code"].as_str().unwrap_or_default(),
                retry["error"].get("detail")
            ),
            "owner={owner}, {error_code}: a reader accepts the reply"
        );
        assert_eq!(
            engine.observed.awaited[awaited..].to_vec(),
            ["checkBinding"],
            "owner={owner}, {error_code}: no lookup, envelope, or COMMIT"
        );
        assert_eq!(
            engine.observed.envelope_executes, 1,
            "owner={owner}, {error_code}: never executes again"
        );
        assert_eq!(
            engine.observed.commits_emitted, 1,
            "owner={owner}, {error_code}: no second COMMIT"
        );
        assert_eq!(
            engine.idempotency_rows.len(),
            1,
            "owner={owner}, {error_code}: the row is untouched"
        );
        assert!(
            engine.pending_rows.is_empty(),
            "owner={owner}, {error_code}"
        );
        assert_eq!(engine.compiler.live_handles(), 0, "owner={owner}");

        // A deployment that compiles the request again replays the stored result: the earlier
        // unknown answer did not consume the key.
        engine.compiler.reject = None;
        engine.observed.awaited.clear();
        let replay = engine.run(&keyed(owner, &insert("p1")));
        assert_eq!(replay["ok"], true, "owner={owner}, {error_code}: {replay}");
        assert_eq!(
            replay["value"]["transactionId"],
            first["value"]["transactionId"]
        );
        assert_eq!(replay["value"]["results"], first["value"]["results"]);
        assert_eq!(
            engine.observed.envelope_executes, 1,
            "owner={owner}, {error_code}: the replay ran nothing"
        );
        assert_eq!(engine.observed.commits_emitted, 1);
        assert_eq!(engine.compiler.live_handles(), 0);
    }
}

/// The same rule on a request that never committed: a keyed request whose compile fails before
/// any attempt has run is still the unknown outcome, because the engine cannot tell it from a
/// retry of one that committed under an earlier deployment (and an absent row does not prove
/// there was no commit). The key is not inspected.
#[test]
fn a_keyed_compile_failure_without_a_prior_commit_is_also_the_unknown_outcome() {
    for owner in [false, true] {
        let mut events = vec![("valid", keyed(owner, &insert("p1")))];
        if !owner {
            // The engine's key is text: a malformed key that core would reject on a successful
            // compile is not inspected here, because a deployment that accepted it earlier may
            // have committed under it.
            events.push(("malformed", execute_request(&insert("p1"), Some("short"))));
        }
        for (label, event) in events {
            let mut engine = placed(owner);
            engine.compiler.reject = Some(CoreError::new(
                "POLICYSQL_INVALID_SQL",
                "The SQL statement cannot be parsed.",
            ));
            let reply = engine.run(&event);
            assert_eq!(
                code(&reply),
                Some("POLICYSQL_OUTCOME_UNKNOWN"),
                "owner={owner}, {label}: {reply}"
            );
            assert_eq!(
                reply["error"]["detail"],
                json!({"cause": {"code": "POLICYSQL_INVALID_SQL", "path": null, "detail": null}}),
                "owner={owner}, {label}"
            );
            assert_eq!(engine.observed.envelope_executes, 0);
            assert_eq!(engine.observed.commits_emitted, 0);
            assert_eq!(engine.idempotency_rows.len(), 0);
            assert_eq!(engine.observed.awaited, ["checkBinding"]);
        }
    }
}

/// An unkeyed execute has no replay contract: its compile error stays definite, so a client is
/// not told the outcome is unknown when nothing could have committed.
#[test]
fn an_unkeyed_compile_failure_keeps_its_definite_error_on_both_placements() {
    for owner in [false, true] {
        let mut engine = placed(owner);
        engine.compiler.reject = Some(CoreError::new(
            "POLICYSQL_INVALID_SQL",
            "The SQL statement cannot be parsed.",
        ));
        let event = if owner {
            atomic_input(&insert("p1"), None)
        } else {
            execute_request(&insert("p1"), None)
        };
        let reply = engine.run(&event);
        assert_eq!(
            code(&reply),
            Some("POLICYSQL_INVALID_SQL"),
            "owner={owner}: {reply}"
        );
        assert!(
            reply["error"].get("detail").is_none(),
            "owner={owner}: an unkeyed refusal carries no detail: {reply}"
        );
        assert_eq!(engine.observed.envelope_executes, 0, "owner={owner}");
        assert_eq!(engine.observed.commits_emitted, 0, "owner={owner}");
        assert_eq!(
            engine.observed.awaited,
            ["checkBinding"],
            "owner={owner}: nothing ran"
        );
        assert_eq!(engine.compiler.live_handles(), 0);
    }
}

/// The snapshot check that runs before the compile (the request's pinned snapshot against the
/// deployment's) is unchanged: it is answered before the idempotency key matters, by the
/// engine's stale operation or the owner's version skew, and it never looks up the stored row.
#[test]
fn a_snapshot_mismatch_is_answered_before_the_keyed_compile_rule() {
    let mut engine = Engine::atomic(false);
    engine.compiler.snapshot = NEXT_SNAPSHOT.to_owned();
    engine.compiler.reject = Some(CoreError::new(
        "POLICYSQL_INVALID_SQL",
        "The SQL statement cannot be parsed.",
    ));
    let stale = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(code(&stale), Some("POLICYSQL_STALE_OPERATION"), "{stale}");
    assert!(
        engine.observed.awaited.is_empty(),
        "answered before any check"
    );
    assert_eq!(engine.idempotency_rows.len(), 0);
}

// ---------------------------------------------------------------------------------------------
// ADR 0027 pull request 6: the result and response budget.

/// The `maxResponseBytes` of every `execute` effect the engine emitted, in order.
fn read_caps(engine: &Engine) -> Vec<u64> {
    engine
        .transcript
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(&line.output).ok())
        .flat_map(|output| output["effects"].as_array().cloned().unwrap_or_default())
        .filter(|effect| effect["type"] == "execute")
        .filter_map(|effect| effect["maxResponseBytes"].as_u64())
        .collect()
}

/// The bytes of a committed reply's `value`, which is the response body.
fn response_bytes(reply: &Value) -> u64 {
    u64::try_from(reply["value"].to_string().len()).unwrap_or(u64::MAX)
}

#[test]
fn every_execute_effect_carries_its_read_cap() {
    use policysql_transaction::bounds::{LOOKUP_BYTES, NO_RESULT_BYTES};
    let mut engine = Engine::atomic(false);
    let reply = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(reply["ok"], true, "{reply}");
    // Lookup, envelope, idempotency insert: the lookup's cap derives from the hard maximum of
    // `maxResponseBytes`, the envelope's is the compiled raw bound (the fake's), and the insert
    // returns no result data.
    assert_eq!(
        read_caps(&engine),
        [
            u64::try_from(LOOKUP_BYTES).unwrap_or(0),
            common::FAKE_RAW_BOUND,
            u64::try_from(NO_RESULT_BYTES).unwrap_or(0),
        ]
    );
    assert_eq!(read_caps(&engine)[0], 1_183_744);
}

/// A keyed request on the direct placement (`owner` false) or forwarded to the owner.
fn keyed(owner: bool, body: &Value) -> Value {
    if owner {
        atomic_input(body, Some([KEY_HASH, FINGERPRINT]))
    } else {
        execute_request(body, Some(KEY))
    }
}

fn placed(owner: bool) -> Engine {
    if owner {
        owner_engine()
    } else {
        Engine::atomic(false)
    }
}

#[test]
fn a_response_over_max_response_bytes_rolls_back_before_commit_and_leaves_no_record() {
    let reserve = policysql_transaction::bounds::RESPONSE_RESERVE_BYTES as u64;
    for owner in [false, true] {
        // Measure the response of the keyed write on this placement (the owner's transaction id
        // is longer than the direct one).
        let mut probe = placed(owner);
        let committed = probe.run(&keyed(owner, &insert("p1")));
        assert_eq!(committed["ok"], true, "{committed}");
        let length = response_bytes(&committed);
        // At the cap: the response plus the reserve is exactly `max_response_bytes`: it commits.
        let mut at = placed(owner);
        at.limits.max_response_bytes = length + reserve;
        let reply = at.run(&keyed(owner, &insert("p1")));
        assert_eq!(reply["ok"], true, "owner={owner}: {reply}");
        assert_eq!(at.observed.commits_emitted, 1);
        assert_eq!(at.idempotency_rows.len(), 1);

        // One byte under: 413, no COMMIT was ever sent, no idempotency row, no handle leaked.
        let mut over = placed(owner);
        over.limits.max_response_bytes = length + reserve - 1;
        let reply = over.run(&keyed(owner, &insert("p1")));
        assert_eq!(code(&reply), Some("POLICYSQL_LIMIT_EXCEEDED"), "{reply}");
        assert_eq!(over.observed.commits_emitted, 0, "no COMMIT is ever sent");
        assert_eq!(over.observed.rollbacks_emitted, 1);
        assert!(over.idempotency_rows.is_empty() && over.pending_rows.is_empty());
        assert_eq!(over.compiler.live_handles(), 0);
        // The idempotency INSERT was never emitted: the effects are lookup and envelope only.
        assert_eq!(read_caps(&over).len(), 2, "owner={owner}");
        // A retry runs again as a new attempt (the first left nothing to replay).
        let before = over.observed.awaited.len();
        let again = over.run(&keyed(owner, &insert("p1")));
        assert_eq!(code(&again), Some("POLICYSQL_LIMIT_EXCEEDED"), "{again}");
        assert_eq!(
            over.observed.awaited[before..]
                .iter()
                .filter(|kind| *kind == "execute")
                .count(),
            2,
            "the retry looked up and executed again"
        );
        // Raising the limit lets the same request commit as the first attempt (the request ids
        // of later steps are longer, so with a little room).
        over.limits.max_response_bytes = length + reserve + 16;
        let last = over.run(&keyed(owner, &insert("p1")));
        assert_eq!(last["ok"], true, "{last}");
        assert_eq!(over.idempotency_rows.len(), 1);
        assert_eq!(over.observed.commits_emitted, 1);
    }
}

#[test]
fn a_committed_request_replays_after_the_response_limit_is_lowered() {
    for owner in [false, true] {
        let mut engine = placed(owner);
        let first = engine.run(&keyed(owner, &insert("p1")));
        assert_eq!(first["ok"], true, "{first}");
        // Lower the limit below what the stored response needs: the response fitted when it was
        // committed, so the retry returns it unchanged and executes nothing.
        engine.limits.max_response_bytes = 1;
        engine.limits.max_result_bytes = 1;
        engine.observed.awaited.clear();
        let replay = engine.run(&keyed(owner, &insert("p1")));
        assert_eq!(
            replay["value"]["results"], first["value"]["results"],
            "owner={owner}: {replay}"
        );
        assert_eq!(
            replay["value"]["transactionId"],
            first["value"]["transactionId"]
        );
        assert_eq!(
            types(&engine)
                .iter()
                .filter(|kind| *kind == "execute")
                .count(),
            1,
            "only the lookup ran"
        );
        assert_eq!(engine.idempotency_rows.len(), 1);
    }
}

#[test]
fn the_result_values_of_an_envelope_are_counted_cumulatively_and_stop_at_the_limit() {
    // `SELECT id, name FROM projects`: two descriptors and one row of two cells = 4 raw values.
    let two = envelope(&[
        ("SELECT id, name FROM projects", json!({})),
        ("SELECT id, name FROM projects", json!({})),
    ]);
    for (limit, expected_ok) in [(8, true), (7, false)] {
        let mut engine = Engine::atomic(false);
        engine.limits.max_json_values = limit;
        let reply = engine.run(&execute_request(&two, None));
        if expected_ok {
            assert_eq!(reply["ok"], true, "limit {limit}: {reply}");
        } else {
            assert_eq!(
                code(&reply),
                Some("POLICYSQL_LIMIT_EXCEEDED"),
                "limit {limit}"
            );
            assert_eq!(engine.observed.commits_emitted, 0);
            assert_eq!(engine.observed.rollbacks_emitted, 1);
        }
    }
    // One statement: 4 values at the limit, 3 over it.
    for (limit, expected_ok) in [(4, true), (3, false)] {
        let mut engine = Engine::atomic(false);
        engine.limits.max_json_values = limit;
        let reply = engine.run(&execute_request(&select(), None));
        assert_eq!(reply["ok"], expected_ok, "limit {limit}: {reply}");
    }
}

#[test]
fn the_derived_event_and_volatile_bounds_follow_the_limits() {
    use policysql_transaction::bounds;
    let limits = common::LIMITS;
    // The event holds at most the larger of the envelope raw bound at the limits' maxima and the
    // idempotency lookup, plus the escaped body, the auth, the binding, and framing.
    let raw_max = bounds::raw_result_bound_max(64_000, 65_536, 8);
    assert_eq!(raw_max, 128_000 + 64 * 65_536 + 512 * 8 + 1_048_576 + 1_024);
    assert_eq!(
        limits.max_event_bytes(),
        bounds::event_bytes(1_048_576, raw_max)
    );
    // At the hard maxima the lookup is no larger than the raw bound, and the volatile state holds
    // the lookup or twice the response, whichever is larger.
    let maxima = policysql_transaction::machine::Limits {
        max_statements: 64,
        max_result_bytes: 524_288,
        max_json_values: 131_072,
        max_response_bytes: 589_824,
        ..limits
    };
    assert!(maxima.largest_read_bytes() >= bounds::LOOKUP_BYTES);
    assert_eq!(
        maxima.max_volatile_bytes(),
        262_144 + 2 * 1_048_576 + 1_183_744
    );
}
