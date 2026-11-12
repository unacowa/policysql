//! The time a compile takes from the host facts of the step that compiles (ADR 0031): the
//! engine's direct placement, the engine and the owner of a forwarded envelope, a keyed replay,
//! and the statements of an interactive transaction.

mod common;

use common::{
    Engine, T0, atomic_input, begin, command, envelope, execute_request, phase_of, sequence_text,
    statement_text,
};
use policysql_transaction::machine::CompileFacts;
use serde_json::{Value, json};

const KEY: &str = "request-key-0001";
const KEY_HASH: &str = "0123456789abcdef0123456789abcdef00000000000000000000000000000000";
const FINGERPRINT: &str = "f00df00df00df00df00df00df00df00df00df00df00df00df00df00df00df00d";

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

fn times(engine: &Engine) -> Vec<u64> {
    engine
        .compiler
        .contexts
        .borrow()
        .iter()
        .map(|facts: &CompileFacts| facts.now_ms)
        .collect()
}

#[test]
fn a_direct_atomic_compile_takes_the_time_of_its_step() {
    let mut engine = Engine::atomic(false);
    engine.now = T0 + 123;
    let reply = engine.run(&execute_request(&insert("p1"), None));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(times(&engine), [T0 + 123]);
}

#[test]
fn a_forwarded_envelope_is_compiled_by_each_side_with_its_own_time_and_only_the_owner_runs_it() {
    let mut engine = Engine::atomic(false);
    engine.now = T0 + 1_000;
    engine.forward_reply =
        json!({"ok": true, "value": {"transactionId": "atomic_y", "status": "committed"}});
    let reply = engine.run(&execute_request(&audit("a1"), Some(KEY)));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(
        times(&engine),
        [T0 + 1_000],
        "the engine compiled to decide"
    );
    assert_eq!(
        engine.compiler.live_handles(),
        0,
        "the engine's handle is released before the forward"
    );
    assert_eq!(
        engine.observed.envelope_executes, 0,
        "the engine ran nothing: the plan it compiled is never executed"
    );

    let mut owner = Engine::atomic(true);
    owner.configured = vec!["consistency".to_owned()];
    owner.now = T0 + 9_000;
    let reply = owner.run(&atomic_input(&audit("a1"), Some([KEY_HASH, FINGERPRINT])));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(
        times(&owner),
        [T0 + 9_000],
        "the owner compiles with its own time"
    );
    assert_eq!(owner.observed.envelope_executes, 1);
    assert_eq!(owner.compiler.live_handles(), 0);
    assert_eq!(
        phase_of(owner.store.as_deref()).as_deref(),
        Some("committed")
    );
}

#[test]
fn a_keyed_replay_returns_the_stored_reply_whatever_the_time_has_become() {
    let mut engine = Engine::atomic(false);
    let first = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(engine.observed.envelope_executes, 1);
    engine.now = T0 + 60_000;
    let replay = engine.run(&execute_request(&insert("p1"), Some(KEY)));
    assert_eq!(replay["value"]["results"], first["value"]["results"]);
    assert_eq!(
        replay["value"].to_string(),
        first["value"].to_string(),
        "the stored response, byte for byte"
    );
    assert_eq!(
        engine.observed.envelope_executes, 1,
        "the replay executes nothing"
    );
    assert_eq!(engine.observed.commits_emitted, 1);
    assert_eq!(
        times(&engine),
        [T0, T0 + 60_000],
        "the replay compiled with the new time and discarded the plan"
    );
}

#[test]
fn each_statement_of_an_interactive_transaction_takes_the_time_of_its_own_step() {
    let mut engine = Engine::new();
    let started = engine.run(&begin("write"));
    assert_eq!(started["ok"], true, "{started}");
    let first_text = statement_text(1, "INSERT INTO projects (id) VALUES (:id)");
    engine.now = T0 + 1_000;
    let first = engine.run(&command("statement", &first_text));
    assert_eq!(first["ok"], true, "{first}");
    engine.now = T0 + 2_000;
    let second_text = statement_text(2, "INSERT INTO projects (id) VALUES (:id)");
    let second = engine.run(&command("statement", &second_text));
    assert_eq!(second["ok"], true, "{second}");
    assert_eq!(times(&engine)[..2], [T0 + 1_000, T0 + 2_000]);

    // The retry of the last statement (the owner records only the last command) gets the recorded reply and executes nothing.
    let executes = engine
        .observed
        .awaited
        .iter()
        .filter(|kind| *kind == "execute")
        .count();
    engine.now = T0 + 3_000;
    let replay = engine.run(&command("statement", &second_text));
    assert_eq!(replay, second, "an exact retry replays the recorded reply");
    assert_eq!(
        engine
            .observed
            .awaited
            .iter()
            .filter(|kind| *kind == "execute")
            .count(),
        executes
    );
    let committed = engine.run(&command("commit", &sequence_text(3)));
    assert_eq!(committed["value"]["status"], "committed", "{committed}");
}
