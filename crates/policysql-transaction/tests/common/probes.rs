//! Deterministic atomic scenarios from the review of pull request 6 (#75), shared by
//! `tests/atomic.rs` (which asserts them) and `tests/transcripts.rs` (which checks them in).

use super::{Engine, T0, atomic_input, envelope, execute_request, phase_of};
use serde_json::{Value, json};

pub const KEY: &str = "request-key-0001";
/// A key hash whose first 32 digits name [`super::OWNER`].
pub const KEY_HASH: &str = "0123456789abcdef0123456789abcdef00000000000000000000000000000000";
pub const FINGERPRINT: &str = "f00df00df00df00df00df00df00df00df00df00df00df00df00df00df00df00d";

pub fn project_insert(id: &str) -> Value {
    envelope(&[(
        "INSERT INTO projects (id, name) VALUES (:id, :name)",
        json!({"id": id, "name": id}),
    )])
}

pub fn audit_insert(id: &str) -> Value {
    envelope(&[(
        "INSERT INTO audited (id, note) VALUES (:id, :note)",
        json!({"id": id, "note": id}),
    )])
}

pub fn owner_engine() -> Engine {
    let mut engine = Engine::atomic(true);
    engine.configured = vec!["consistency".to_owned()];
    engine
}

/// `TimerFired` beside the outstanding client-lane effect (the timer lane is not serialized).
pub fn fire_timer(engine: &mut Engine) {
    let outstanding = engine.outstanding.take();
    engine.feed(&json!({"type": "timerFired"}));
    if engine.outstanding.is_none() {
        engine.outstanding = outstanding;
    }
}

/// Resolves `count` outstanding effects successfully.
pub fn advance(engine: &mut Engine, count: usize) {
    for _ in 0..count {
        engine.resolve(true, "unknown");
    }
}

/// P1: the owner holds a readable atomic `active` record of another database id, generation,
/// and snapshot (an earlier execution, lost). A keyed retry ignores it, replays from the row,
/// and replaces the record with its own.
pub fn prior_record_of_another_binding() -> Engine {
    let mut engine = owner_engine();
    let input = atomic_input(&project_insert("p1"), Some([KEY_HASH, FINGERPRINT]));
    engine.run(&input);
    let mut record: Value =
        serde_json::from_str(engine.store.as_deref().unwrap_or("{}")).unwrap_or(Value::Null);
    record["phase"] = json!("active");
    record["expiresAtMs"] = json!(T0 + 60_000);
    record["binding"]["databaseId"] = json!("db_other");
    record["binding"]["generation"] = json!("7");
    record["binding"]["snapshot"] = json!("sqlite-turso-v1:schema_0:policy_0:abi-5");
    record["snapshot"] = json!("sqlite-turso-v1:schema_0:policy_0:abi-5");
    engine.store = Some(record.to_string());
    engine.lose();
    engine.run(&input);
    engine
}

/// P2: the owner's timer fires while the validator is awaited and a callback query holds the
/// connection. The commit is answered at once, the rollback waits for the callback query,
/// the record becomes `expired`, and the late verdict is ignored.
pub fn timer_while_callback_holds_the_connection() -> Engine {
    let mut engine = owner_engine();
    engine.feed(&atomic_input(&audit_insert("a1"), None));
    advance(&mut engine, 5);
    let validator = engine.outstanding.clone().unwrap_or(Value::Null);
    assert_eq!(validator["type"], "callValidator");
    let token = engine.token();
    engine.callback(
        &token,
        r#"{"sequence":1,"sql":"SELECT id, note FROM audited","params":{}}"#,
    );
    engine.resolve_callback(true, "unknown");
    assert_eq!(
        engine
            .callback_outstanding
            .as_ref()
            .map(|effect| effect["type"].clone()),
        Some(json!("execute")),
        "the callback query holds the connection"
    );
    engine.now = T0 + 4_000;
    fire_timer(&mut engine);
    engine.outstanding = None;
    engine.resolve_callback(true, "unknown");
    engine.settle();
    engine.feed(
        &json!({"type": "validatorReplied", "id": validator["id"], "ok": true,
        "decision": {"version": "1", "allowed": true}}),
    );
    engine
}

/// P3: a keyed execution is lost after its `active` record; the successor's timer for that
/// record fires while the keyed retry opens its connection. The retry is not expired by the
/// earlier record and runs once from the lookup.
pub fn successor_timer_races_a_keyed_retry() -> Engine {
    let mut engine = owner_engine();
    let input = atomic_input(&project_insert("p1"), Some([KEY_HASH, FINGERPRINT]));
    engine.feed(&input);
    advance(&mut engine, 3);
    assert_eq!(phase_of(engine.store.as_deref()).as_deref(), Some("active"));
    engine.pending_rows.clear();
    engine.envelope_open = false;
    engine.lose();
    engine.now = T0 + 4_000;
    engine.feed(&input);
    advance(&mut engine, 1);
    fire_timer(&mut engine);
    engine.settle();
    engine
}

/// P4: the owner's timer fires while the idempotency row is being inserted: no COMMIT, the
/// row rolls back with the envelope, the record becomes `expired`.
pub fn timer_during_the_idempotency_insert() -> Engine {
    let mut engine = owner_engine();
    engine.feed(&atomic_input(
        &project_insert("p1"),
        Some([KEY_HASH, FINGERPRINT]),
    ));
    advance(&mut engine, 7);
    let insert = engine.outstanding.clone().unwrap_or(Value::Null);
    assert!(
        insert["statements"][0]["sql"]
            .as_str()
            .is_some_and(|sql| sql.starts_with("INSERT INTO policysql_idempotency"))
    );
    engine.now = T0 + 4_000;
    fire_timer(&mut engine);
    engine.settle();
    engine
}

/// P5: the engine abandons a direct keyed execution while COMMIT is in flight (no reply from
/// the machine; the engine answers 500 itself). The retry with the same key replays when the
/// COMMIT applied (`applied`) and executes once when it did not.
pub fn direct_abandon_during_commit(applied: bool) -> Engine {
    let mut engine = Engine::atomic(false);
    let request = execute_request(&project_insert("p1"), Some(KEY));
    engine.feed(&request);
    advance(&mut engine, 5);
    assert_eq!(
        engine
            .outstanding
            .as_ref()
            .map(|effect| effect["type"].clone()),
        Some(json!("commit"))
    );
    engine.feed(&json!({"type": "abandon"}));
    // The engine closes the connection; whether COMMIT applied is the database's.
    if applied {
        engine.idempotency_rows.append(&mut engine.pending_rows);
        engine.observed.envelope_commits += 1;
    }
    engine.pending_rows.clear();
    engine.envelope_open = false;
    engine.outstanding = None;
    engine.waiting.clear();
    engine.run(&request);
    engine
}
