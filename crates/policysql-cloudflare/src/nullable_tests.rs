//! NULL named parameters at the WASM ABI boundary (issue #20).
//!
//! The shared fixture is also driven through real WASM, JWT, HTTP and SQLite by
//! `deploy/cloudflare/test/nullable.test.mjs`. Here it pins that execute and
//! Explain accept exactly the same NULLs and that Explain's nullable metadata is
//! the compiler proof, independent of the supplied sample value.

use serde_json::{Value, json};

const CASES: &str = include_str!("../../../tests/fixtures/nullable/cases.json");

fn runtime() -> super::PolicySqlRuntime {
    super::PolicySqlRuntime::new_with_physical_schema(
        include_str!("../../../tests/fixtures/nullable/catalog.yaml"),
        include_str!("../../../tests/fixtures/nullable/policy.yaml"),
        "nullable_schema",
        "nullable_policy",
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
        include_str!("../../../tests/fixtures/nullable/physical-schema.json"),
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"))
}

const AUTH: &str = r#"{"subject":"u","role":"member","roles":["member"],"access":["execute","explain"],"session":{"tenant_id":"tenant_a"}}"#;

fn compile(runtime: &super::PolicySqlRuntime, sql: &str, params: &Value, endpoint: &str) -> Value {
    serde_json::from_str(&runtime.compile_json(
        AUTH,
        &json!({"statements":[{"sql":sql,"params":params}]}).to_string(),
        endpoint,
    ))
    .unwrap_or_else(|_| unreachable!("runtime output is JSON"))
}

fn cases() -> Vec<Value> {
    serde_json::from_str::<Value>(CASES)
        .ok()
        .and_then(|cases| cases.as_array().cloned())
        .unwrap_or_else(|| unreachable!("fixture cases"))
}

#[test]
fn execute_and_explain_accept_exactly_the_proven_nulls() {
    let runtime = runtime();
    for case in cases() {
        let sql = case["sql"].as_str().unwrap_or_else(|| unreachable!());
        let accepted = case["accepted"] == true;
        for endpoint in ["execute", "explain"] {
            let output = compile(&runtime, sql, &case["params"], endpoint);
            assert_eq!(
                output.get("error").is_none(),
                accepted,
                "{endpoint} {sql}: {output}"
            );
            if accepted {
                let statement = &output["statements"][0];
                for (name, value) in case["params"].as_object().into_iter().flatten() {
                    assert_eq!(&statement["clientParameters"][name], value, "{sql}");
                }
            } else if case.get("nullable").is_some() {
                // Binder and policy accept the statement: only the NULL is wrong,
                // and it fails like any other invalid parameter value.
                assert_eq!(
                    output["error"]["code"], "POLICYSQL_INVALID_PARAMETER",
                    "{endpoint} {sql}: {output}"
                );
            }
        }
    }
}

#[test]
fn explain_nullable_metadata_is_the_proof_not_the_sample() {
    let runtime = runtime();
    for case in cases() {
        let Some(expected) = case.get("nullable") else {
            continue;
        };
        let sql = case["sql"].as_str().unwrap_or_else(|| unreachable!());
        // Type discovery without values. Omitted proven-nullable parameters use
        // a NULL placeholder, so formatted types such as `date` also explain.
        let output = compile(&runtime, sql, &json!({}), "explain");
        assert!(output.get("error").is_none(), "{sql}: {output}");
        let statement = &output["statements"][0];
        assert_eq!(&statement["clientParameterNullable"], expected, "{sql}");
        if case["accepted"] == true {
            // A real sample, NULL or not, never changes the descriptor.
            let sampled = compile(&runtime, sql, &case["params"], "explain");
            assert_eq!(
                &sampled["statements"][0]["clientParameterNullable"], expected,
                "{sql}: {sampled}"
            );
            assert_eq!(
                sampled["statements"][0]["clientParameterTypes"], statement["clientParameterTypes"],
                "{sql}"
            );
        }
    }
}

#[test]
fn issue_example_binds_sql_null_in_the_sealed_plan() {
    let runtime = runtime();
    let output = compile(
        &runtime,
        "UPDATE nullabletexts SET state=:value WHERE id=:id RETURNING state",
        &json!({"id":"target","value":null}),
        "execute",
    );
    let statement = &output["statements"][0];
    assert_eq!(
        statement["clientParameters"]["value"],
        Value::Null,
        "{output}"
    );
    assert_eq!(statement["clientParameterNullable"]["value"], true);
    assert_eq!(statement["clientParameterNullable"]["id"], false);
    assert_eq!(statement["operationCheck"], true);
    assert_eq!(statement["result"][0]["nullable"], true);
    let protected = statement["protectedSql"]
        .as_str()
        .unwrap_or_else(|| unreachable!());
    assert!(protected.contains(r#""state" = :value"#), "{protected}");
    assert!(
        !protected.contains("NULL"),
        "NULL travels as a bound parameter: {protected}"
    );
}
