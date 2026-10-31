//! `maxBytesPerValue` (ADR 0027 pull request 5): one configured limit for the decoded bytes of
//! a bytes value, enforced on every path that carries one, at the default and at the hard
//! maximum. On every path the smallest applicable limit governs; each such path is pinned here
//! at the per-value maximum, so the documentation's per-path statements are tested.

use super::PolicySqlRuntime;
use policysql_core::bytes::{DEFAULT_MAX_BYTES_PER_VALUE, HARD_MAX_BYTES_PER_VALUE, encode};
use serde_json::{Value, json};

const CATALOG: &str = include_str!("../../../tests/fixtures/bytes/catalog.yaml");
const POLICY: &str = include_str!("../../../tests/fixtures/bytes/policy.yaml");
const AUTH: &str = r#"{"principal":"test:user","subject":"u","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_a"}}"#;

/// The per-value limits under test: a small one whose length is not a multiple of three, the
/// default, and the hard maximum.
const LIMITS: [usize; 3] = [1_000, DEFAULT_MAX_BYTES_PER_VALUE, HARD_MAX_BYTES_PER_VALUE];

fn runtime_with(per_value: usize, max_request: usize, max_result: usize) -> PolicySqlRuntime {
    PolicySqlRuntime::new(
        CATALOG,
        POLICY,
        "bytes_schema",
        "bytes_policy",
        &format!(
            r#"{{"max_rows":100,"max_result_bytes":{max_result},"timeout_ms":1000,"max_statements":8,"max_request_bytes":{max_request},"max_bytes_per_value":{per_value}}}"#
        ),
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"))
}

fn compile(runtime: &PolicySqlRuntime, sql: &str, params: &Value) -> Value {
    serde_json::from_str(&runtime.compile_json(
        AUTH,
        &json!({"statements":[{"sql":sql,"params":params}]}).to_string(),
        "execute",
    ))
    .unwrap_or_else(|_| unreachable!())
}

fn code(output: &Value) -> Option<&str> {
    output["error"]["code"].as_str()
}

const INSERT_STATE: &str = "INSERT INTO projects(id,name,state) VALUES('n','n',:v)";
const UPDATE_STATE: &str = "UPDATE projects SET state=:v WHERE id='seed'";

#[test]
fn limits_json_reports_the_configured_value_and_omitting_it_takes_the_default() {
    for limit in LIMITS {
        let runtime = runtime_with(limit, 2_097_152, 10_000);
        let limits: Value = serde_json::from_str(&runtime.limits_json())
            .unwrap_or_else(|_| unreachable!("limits_json"));
        assert_eq!(limits["maxBytesPerValue"], limit);
    }
    let omitted = PolicySqlRuntime::new(
        CATALOG,
        POLICY,
        "bytes_schema",
        "bytes_policy",
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"));
    let limits: Value = serde_json::from_str(&omitted.limits_json())
        .unwrap_or_else(|_| unreachable!("limits_json"));
    assert_eq!(limits["maxBytesPerValue"], DEFAULT_MAX_BYTES_PER_VALUE);
}

/// A bytes parameter at the limit is accepted and one byte over is 413
/// `POLICYSQL_LIMIT_EXCEEDED`, for every padding shape, in INSERT and UPDATE; malformed forms
/// (unpadded, extra padding) stay 400 `POLICYSQL_INVALID_PARAMETER` however long they are.
#[test]
fn a_bytes_parameter_is_bounded_by_the_configured_limit_at_every_padding() {
    for limit in LIMITS {
        let runtime = runtime_with(limit, 2_097_152, 10_000);
        for sql in [INSERT_STATE, UPDATE_STATE] {
            for length in [limit - 2, limit - 1, limit] {
                let output = compile(&runtime, sql, &json!({"v": encode(&vec![9; length])}));
                assert!(output.get("error").is_none(), "{limit} {length}: {output}");
            }
            for length in [limit + 1, limit + 2, limit + 3] {
                let output = compile(&runtime, sql, &json!({"v": encode(&vec![9; length])}));
                assert_eq!(
                    code(&output),
                    Some("POLICYSQL_LIMIT_EXCEEDED"),
                    "{limit} {length}"
                );
                assert!(output["error"]["path"].is_string() || output["error"]["path"].is_null());
            }
            let padded = encode(&vec![9; limit]);
            for malformed in [
                padded.trim_end_matches('=').to_owned(),
                format!("{padded}="),
                format!("{padded}A"),
            ] {
                if malformed == padded {
                    continue;
                }
                let output = compile(&runtime, sql, &json!({"v": malformed}));
                assert_eq!(
                    code(&output),
                    Some("POLICYSQL_INVALID_PARAMETER"),
                    "{limit}"
                );
            }
        }
    }
}

/// The limit is the bytes limit: text and JSON parameters over it are bounded by the request
/// limits only, and a text value is not a bytes value.
#[test]
fn text_and_json_values_are_not_bounded_by_the_bytes_limit() {
    for limit in LIMITS {
        let runtime = runtime_with(limit, 2_097_152, 10_000);
        let text = "a".repeat(limit + 1);
        let output = compile(
            &runtime,
            "INSERT INTO projects(id,name) VALUES('n',:name)",
            &json!({"name": text}),
        );
        assert!(output.get("error").is_none(), "{limit}: {output}");
        let output = compile(
            &runtime,
            "INSERT INTO projects(id,name,metadata) VALUES('n','n',:m)",
            &json!({"m": {"k": "a".repeat(limit + 1)}}),
        );
        assert!(output.get("error").is_none(), "{limit}: {output}");
        // A text parameter cannot stand in for a bytes value, whatever its length.
        let output = compile(&runtime, INSERT_STATE, &json!({"v": 7}));
        assert_eq!(code(&output), Some("POLICYSQL_INVALID_PARAMETER"));
    }
}

/// A parameter is also bounded by the request limit: a value at the hard maximum does not fit a
/// default request, and the engine says so with the request code, not a per-value one.
#[test]
fn the_request_limit_governs_when_it_is_smaller() {
    let runtime = runtime_with(HARD_MAX_BYTES_PER_VALUE, 1_048_576, 10_000);
    let body = json!({"statements":[{"sql":INSERT_STATE,"params":{"v": encode(&vec![9; HARD_MAX_BYTES_PER_VALUE])}}]})
        .to_string();
    assert!(body.len() > 1_048_576);
    let output: Value = serde_json::from_str(&runtime.compile_json(AUTH, &body, "execute"))
        .unwrap_or_else(|_| unreachable!());
    // Core's derived compile bound is `maxRequestBytes` plus the auth and framing; the body is
    // 1,398,104 + envelope bytes, past it.
    assert_eq!(
        code(&output),
        Some("POLICYSQL_REQUEST_TOO_LARGE"),
        "{output}"
    );
    // The largest value a default request carries is a little under three quarters of it.
    let fits = (1_048_576 - 4_096) / 4 * 3;
    let output = compile(
        &runtime,
        INSERT_STATE,
        &json!({"v": encode(&vec![9; fits])}),
    );
    assert!(output.get("error").is_none(), "{output}");
}

fn blob_result(runtime: &PolicySqlRuntime, length: usize) -> Value {
    let compiled = compile(runtime, "SELECT state FROM projects", &json!({}));
    let handle = compiled["executionHandle"]
        .as_u64()
        .unwrap_or_else(|| unreachable!("{compiled}"));
    let output: Value = serde_json::from_str(
        &runtime.validate_result_json(
            handle,
            0,
            &json!({
                "columns": ["state"],
                "rows": [[{"type": "blob", "base64": encode(&vec![5; length])}]],
                "affectedRows": 0
            })
            .to_string(),
        ),
    )
    .unwrap_or_else(|_| unreachable!());
    runtime.release_execution(handle);
    output
}

/// A result cell at the limit is accepted and one over is 413 `POLICYSQL_LIMIT_EXCEEDED`; a
/// value the raw result bound or `maxResultBytes` cannot carry is the same 413 (the result
/// limits govern), never a different code.
#[test]
fn a_result_cell_is_bounded_by_the_configured_limit_and_the_result_bounds() {
    for limit in [1_000, DEFAULT_MAX_BYTES_PER_VALUE] {
        let runtime = runtime_with(limit, 1_048_576, 1_000_000);
        for length in [0, 1, limit - 1, limit] {
            let output = blob_result(&runtime, length);
            assert!(output.get("error").is_none(), "{limit} {length}: {output}");
        }
        for length in [limit + 1, limit + 2, limit + 3] {
            let output = blob_result(&runtime, length);
            assert_eq!(
                code(&output),
                Some("POLICYSQL_LIMIT_EXCEEDED"),
                "{limit} {length}"
            );
        }
    }
    // At the hard maximum the raw database result bound that exists today (1 MiB per statement,
    // replaced by the compiled bound in pull request 6) is smaller than the base64 form of the
    // largest value: a value up to about three quarters of it passes, one above does not.
    let runtime = runtime_with(HARD_MAX_BYTES_PER_VALUE, 2_097_152, 1_000_000_000);
    let raw_bound = policysql_transaction::machine::EVENT_RESULT_BYTES;
    let frame =
        json!({"columns":["state"],"rows":[[{"type":"blob","base64":""}]],"affectedRows":0})
            .to_string()
            .len();
    let largest = (raw_bound - frame) / 4 * 3;
    assert!(blob_result(&runtime, largest).get("error").is_none());
    for length in [largest + 3, HARD_MAX_BYTES_PER_VALUE] {
        let output = blob_result(&runtime, length);
        assert_eq!(code(&output), Some("POLICYSQL_LIMIT_EXCEEDED"), "{length}");
    }
    // `maxResultBytes` also governs, below the per-value limit.
    let runtime = runtime_with(HARD_MAX_BYTES_PER_VALUE, 1_048_576, 64_000);
    assert!(blob_result(&runtime, 64_000).get("error").is_none());
    assert_eq!(
        code(&blob_result(&runtime, 64_001)),
        Some("POLICYSQL_LIMIT_EXCEEDED")
    );
}

/// RETURNING and the check column take the same path as a SELECT: the value of a returned
/// bytes column is bounded by the configured limit.
#[test]
fn a_returned_bytes_value_is_bounded_by_the_configured_limit() {
    for limit in [1_000, DEFAULT_MAX_BYTES_PER_VALUE] {
        let runtime = runtime_with(limit, 1_048_576, 1_000_000);
        let compiled = compile(
            &runtime,
            "UPDATE projects SET state=:v WHERE id='seed' RETURNING state",
            &json!({"v": encode(&[1, 2, 3])}),
        );
        let columns = compiled["statements"][0]["result"]
            .as_array()
            .unwrap_or_else(|| unreachable!("{compiled}"))
            .len();
        let handle = compiled["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("{compiled}"));
        let check = compiled["statements"][0]["operationCheck"] == true;
        let raw = |length: usize| {
            let mut row = vec![json!({"type": "blob", "base64": encode(&vec![5; length])})];
            assert_eq!(columns, 1);
            if check {
                row.push(json!(1));
            }
            let mut names = vec![compiled["statements"][0]["result"][0]["name"].clone()];
            if check {
                names.push(json!("__policysql_check"));
            }
            json!({"columns": names, "rows": [row], "affectedRows": 1}).to_string()
        };
        for (length, expected) in [(limit, None), (limit + 1, Some("POLICYSQL_LIMIT_EXCEEDED"))] {
            let output: Value =
                serde_json::from_str(&runtime.validate_result_json(handle, 0, &raw(length)))
                    .unwrap_or_else(|_| unreachable!());
            match expected {
                Some(expected) => assert_eq!(code(&output), Some(expected), "{limit} {length}"),
                None => assert!(
                    output.get("error").is_none(),
                    "{limit} {length}: {output} {compiled}"
                ),
            }
        }
        runtime.release_execution(handle);
    }
}

/// A bytes preset is bounded by the configured limit at activation; a deployment cannot
/// configure a preset it would refuse to read or write. (A failed runtime construction is a
/// `JsValue`, which only exists on wasm32, so the policy activation the constructor calls is
/// tested directly. The 1 MiB configuration input bounds a preset too, so the hard maximum is
/// not reachable for one: `build_runtime` refuses a catalog and policy over 1 MiB.)
#[test]
fn a_bytes_preset_over_the_configured_limit_fails_activation() {
    let snapshot = super::SnapshotId::new("bytes_test").unwrap_or_else(|_| unreachable!());
    let catalog =
        super::activate_catalog(CATALOG, snapshot.clone()).unwrap_or_else(|_| unreachable!());
    for limit in [1_000, 1_024, DEFAULT_MAX_BYTES_PER_VALUE] {
        let policy = POLICY.replace("AAEC/w==", &encode(&vec![0; limit]));
        let activate = |per_value: usize| {
            super::PolicyBundle::activate_with_value_limit(
                &policy,
                &catalog,
                snapshot.clone(),
                per_value,
            )
        };
        assert!(activate(limit).is_ok(), "{limit}");
        assert!(activate(limit - 1).is_err(), "{limit}");
        assert!(activate(HARD_MAX_BYTES_PER_VALUE).is_ok(), "{limit}");
    }
    // The update preset ("/wA=", two bytes) is bounded the same way.
    let update = POLICY.replace("/wA=", &encode(&vec![0; 1_000]));
    assert!(
        super::PolicyBundle::activate_with_value_limit(&update, &catalog, snapshot.clone(), 1_000)
            .is_ok()
    );
    assert!(
        super::PolicyBundle::activate_with_value_limit(&update, &catalog, snapshot, 999).is_err()
    );
}
