//! ADR 0031 through the real runtime: `compile_json` takes a request context and `step_json`
//! compiles a `now` preset with the host fact of the step that compiles.

use proptest::prelude::*;
use serde_json::{Value, json};

const CATALOG: &str = include_str!("../../../tests/fixtures/now/catalog.yaml");
const POLICY: &str = include_str!("../../../tests/fixtures/now/policy.yaml");
const AUTH: &str = r#"{"principal":"test:user","subject":"u","role":"member","roles":["member"],"access":["execute","explain"],"session":{"tenant_id":"tenant_a"}}"#;
const LIMITS: &str =
    r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#;
const UPDATE: &str = r#"{"statements":[{"sql":"UPDATE projects SET name = :name WHERE id = :id RETURNING id, updated_at","params":{"name":"n","id":"p1"}}]}"#;
const INSERT: &str = r#"{"statements":[{"sql":"INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, updated_at","params":{"id":"p9","name":"n"}}]}"#;

fn runtime() -> super::PolicySqlRuntime {
    super::PolicySqlRuntime::new(CATALOG, POLICY, "schema_1", "policy_1", LIMITS)
        .unwrap_or_else(|_| unreachable!("valid runtime"))
}

fn compile(runtime: &super::PolicySqlRuntime, body: &str, context: &str) -> Value {
    serde_json::from_str(&runtime.compile_json(AUTH, body, "execute", context))
        .unwrap_or_else(|_| unreachable!("compile_json answers JSON"))
}

#[test]
fn a_now_preset_compiles_with_the_context_time() {
    let runtime = runtime();
    let output = compile(&runtime, UPDATE, super::TEST_CONTEXT);
    let server = &output["statements"][0]["serverParameters"];
    assert_eq!(
        server["__policysql_now_rfc3339"],
        "2026-10-30T13:14:56.789Z"
    );
    assert_eq!(
        server["__policysql_now_sqlite_datetime"],
        "2026-10-30 13:14:56"
    );
    assert_eq!(server["__policysql_now_epoch_ms"], 1_793_366_096_789_u64);
    let other = compile(&runtime, UPDATE, r#"{"nowMs":0}"#);
    assert_eq!(
        other["statements"][0]["serverParameters"]["__policysql_now_rfc3339"],
        "1970-01-01T00:00:00.000Z"
    );
}

#[test]
fn a_malformed_context_is_an_internal_error_without_detail() {
    let runtime = runtime();
    // Valid JSON padded with spaces: only the length bound can refuse it.
    let padded = |bytes: usize| {
        let body = r#"{"nowMs":1"#;
        format!("{body}{}}}", " ".repeat(bytes - body.len() - 1))
    };
    let too_long = padded(257);
    assert_eq!(too_long.len(), 257);
    for context in [
        "",
        "{}",
        r#"{"nowMs":-1}"#,
        r#"{"nowMs":1.5}"#,
        r#"{"nowMs":"1"}"#,
        r#"{"nowMs":253402300800000}"#,
        r#"{"nowMs":1,"entropy":"00"}"#,
        too_long.as_str(),
    ] {
        let output = compile(&runtime, UPDATE, context);
        assert_eq!(output["error"]["code"], "POLICYSQL_INTERNAL", "{context}");
        assert!(output["error"].get("detail").is_none(), "{context}");
        assert!(output.get("statements").is_none(), "{context}");
    }
    let exact = padded(256);
    assert_eq!(exact.len(), 256);
    assert_eq!(
        compile(&runtime, UPDATE, &exact)["statements"][0]["serverParameters"]["__policysql_now_rfc3339"],
        "1970-01-01T00:00:00.001Z"
    );
    let edge = compile(&runtime, UPDATE, r#"{"nowMs":253402300799999}"#);
    assert_eq!(
        edge["statements"][0]["serverParameters"]["__policysql_now_rfc3339"],
        "9999-12-31T23:59:59.999Z"
    );
}

#[test]
fn the_time_is_not_a_member_of_the_clients_body() {
    let body = r#"{"nowMs":0,"statements":[{"sql":"SELECT id FROM projects","params":{}}]}"#;
    let output = compile(&runtime(), body, super::TEST_CONTEXT);
    assert_eq!(output["error"]["code"], "POLICYSQL_INVALID_REQUEST");
}

#[test]
fn a_client_cannot_name_or_pass_a_now_parameter() {
    let runtime = runtime();
    let reserved = r#"{"statements":[{"sql":"UPDATE projects SET name = :__policysql_now_rfc3339 WHERE id = :id","params":{"id":"p1"}}]}"#;
    assert_eq!(
        compile(&runtime, reserved, super::TEST_CONTEXT)["error"]["code"],
        "POLICYSQL_RESERVED_PARAMETER"
    );
    let unused = r#"{"statements":[{"sql":"UPDATE projects SET name = :name WHERE id = :id","params":{"name":"n","id":"p1","__policysql_now_rfc3339":"x"}}]}"#;
    assert_eq!(
        compile(&runtime, unused, super::TEST_CONTEXT)["error"]["code"],
        "POLICYSQL_INVALID_PARAMETER"
    );
    let assigned = r#"{"statements":[{"sql":"UPDATE projects SET updated_at = :t WHERE id = :id","params":{"t":"2000-01-01T00:00:00.000Z","id":"p1"}}]}"#;
    assert_eq!(
        compile(&runtime, assigned, super::TEST_CONTEXT)["error"]["code"],
        "POLICYSQL_FORBIDDEN_COLUMN"
    );
}

// The core spelling and the machine's `expiresAt` spelling are the same function of the time.
proptest! {
    #![proptest_config(ProptestConfig { cases: 2000, ..ProptestConfig::default() })]
    #[test]
    fn core_and_machine_spell_the_same_time(ms in 0..=policysql_transaction::machine::MAX_TIME_MS) {
        prop_assert_eq!(
            policysql_core::time::rfc3339_millis(ms),
            policysql_transaction::machine::time::iso_from_ms(ms)
        );
    }
}

/// A direct atomic `execute` of `body` stepped in an engine whose host fact is `now_ms`; the
/// arguments of the first `execute` effect that writes `projects`.
fn first_write_args(body: &str, now_ms: u64) -> Value {
    // Without the commit check: a write that triggers one is forwarded to an owner.
    let policy = POLICY.split("commit_checks:").next().unwrap_or(POLICY);
    let runtime = super::PolicySqlRuntime::new(CATALOG, policy, "schema_1", "policy_1", LIMITS)
        .unwrap_or_else(|_| unreachable!("valid runtime"));
    let snapshot = runtime.snapshot();
    let auth: Value = serde_json::from_str(AUTH).unwrap_or_default();
    let binding = json!({"version": 1, "scope": "tenant", "databaseId": "db_a", "generation": "1", "snapshot": snapshot});
    let mut event = json!({"type": "request", "operation": {
        "kind": "execute", "auth": auth, "databaseBinding": binding,
        "snapshot": snapshot, "bodyText": body,
    }});
    let mut volatile: Option<String> = None;
    for request in 1_u64..20 {
        let host = json!({
            "nowMs": now_ms, "entropy": format!("{request:064x}"),
            "requestId": format!("req_{request}"), "owner": null,
        });
        let output = runtime.step_json(
            None,
            volatile.clone(),
            &event.to_string(),
            &host.to_string(),
        );
        let parsed: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
        volatile = parsed["volatile"].as_str().map(str::to_owned);
        let Some(effect) = parsed["effects"]
            .as_array()
            .and_then(|effects| effects.last().cloned())
        else {
            break;
        };
        let id = effect["id"].clone();
        event = match effect["type"].as_str() {
            Some("checkBinding") => json!({"type": "bindingChecked", "id": id, "allowed": true}),
            Some("open") => json!({"type": "opened", "id": id}),
            Some("execute") => return effect["statements"][0]["args"].clone(),
            other => unreachable!("unexpected {other:?}: {parsed}"),
        };
    }
    unreachable!("the atomic write reaches its execute effect")
}

#[test]
fn a_direct_atomic_write_binds_the_host_time_of_its_step() {
    let at = |now_ms| first_write_args(INSERT, now_ms);
    let first = at(1_793_366_096_789);
    assert_eq!(
        first["__policysql_now_rfc3339"], "2026-10-30T13:14:56.789Z",
        "{first}"
    );
    assert_eq!(
        first["__policysql_now_sqlite_datetime"], "2026-10-30 13:14:56",
        "{first}"
    );
    let second = at(1_000);
    assert_eq!(
        second["__policysql_now_rfc3339"], "1970-01-01T00:00:01.000Z",
        "{second}"
    );
    assert_ne!(
        first["__policysql_now_epoch_ms"],
        second["__policysql_now_epoch_ms"]
    );
}
