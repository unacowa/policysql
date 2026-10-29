use super::{
    LogicalType, LogicalValue, encode_parameter_value, encode_result_value, logical_result_value,
    logical_value,
};
use serde_json::{Value, json};

const CATALOG: &str = include_str!("../../../tests/fixtures/bytes/catalog.yaml");
const POLICY: &str = include_str!("../../../tests/fixtures/bytes/policy.yaml");

#[test]
fn byte_presets_are_literals_only_and_do_not_expand_policy_predicates() {
    let snapshot = super::SnapshotId::new("bytes_test").unwrap_or_else(|_| unreachable!());
    let catalog =
        super::activate_catalog(CATALOG, snapshot.clone()).unwrap_or_else(|_| unreachable!());
    assert!(super::PolicyBundle::activate(POLICY, &catalog, snapshot.clone()).is_ok());
    let oversized =
        policysql_core::bytes::encode(&vec![0; policysql_core::bytes::MAX_BYTES_PER_VALUE + 1]);
    assert!(
        super::PolicyBundle::activate(
            &POLICY.replace("AAEC/w==", &oversized),
            &catalog,
            snapshot.clone()
        )
        .is_err()
    );
    for preset in [
        "{ session: tenant_id }",
        "{ literal: 'AB==' }",
        "{ literal: [0, 255] }",
        "{ literal: null }",
        "{ column: state }",
    ] {
        let policy = POLICY.replace("{ literal: \"AAEC/w==\" }", preset);
        assert!(
            super::PolicyBundle::activate(&policy, &catalog, snapshot.clone()).is_err(),
            "{preset}"
        );
    }
    let policy = POLICY.replace(
        "filter: { tenant_id: { eq: { session: tenant_id } } }",
        "filter: { seed: { eq: { literal: 'AAEC/w==' } } }",
    );
    assert!(super::PolicyBundle::activate(&policy, &catalog, snapshot).is_err());
}

#[test]
fn bytes_descriptor_rejects_incompatible_representations() {
    let snapshot = super::SnapshotId::new("bytes_test").unwrap_or_else(|_| unreachable!());
    for representation in ["number", "boolean", "object", "array"] {
        let catalog = CATALOG.replace(
            "type: bytes, nullable: true",
            &format!("type: bytes, nullable: true, representation: {representation}"),
        );
        assert!(super::activate_catalog(&catalog, snapshot.clone()).is_err());
    }
}

// NULL for bytes client parameters is out of scope here (#20/#21): JSON null is
// rejected at every use, and Explain must not advertise nullable bytes parameters.
#[test]
fn null_bytes_parameters_are_rejected_at_every_use() {
    let runtime = super::PolicySqlRuntime::new(
        CATALOG,
        POLICY,
        "bytes_schema",
        "bytes_policy",
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"));
    let auth = r#"{"subject":"u","role":"member","roles":["member"],"access":["execute","explain"],"session":{"tenant_id":"tenant_a"}}"#;
    for sql in [
        "UPDATE projects SET state=:value WHERE id='seed' RETURNING state",
        "INSERT INTO projects(id,name,state) VALUES('n','n',:value)",
        "SELECT id FROM projects WHERE state=:value",
        "SELECT id FROM projects WHERE state IN (:value)",
    ] {
        for endpoint in ["execute", "explain"] {
            let output: Value = serde_json::from_str(&runtime.compile_json(
                auth,
                &json!({"statements":[{"sql":sql,"params":{"value":null}}]}).to_string(),
                endpoint,
            ))
            .unwrap_or_else(|_| unreachable!());
            assert_eq!(
                output["error"]["code"], "POLICYSQL_INVALID_PARAMETER",
                "{endpoint} {sql}: {output}"
            );
        }
    }
    let output: Value = serde_json::from_str(
        &runtime.compile_json(
            auth,
            &json!({"statements":[{
                "sql":"UPDATE projects SET state=:value WHERE id='seed' RETURNING state",
                "params":{}
            }]})
            .to_string(),
            "explain",
        ),
    )
    .unwrap_or_else(|_| unreachable!());
    assert_eq!(
        output["statements"][0]["clientParameterTypes"]["value"], "bytes",
        "{output}"
    );
    assert!(
        output["statements"][0]
            .get("clientParameterNullable")
            .is_none(),
        "{output}"
    );
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/bytes-contract.json"))
        .unwrap_or_else(|error| unreachable!("valid fixture: {error}"))
}

#[test]
fn bytes_ingress_uses_expected_type_and_strict_public_representation() {
    let fixture = fixture();
    for case in fixture["valid"]
        .as_array()
        .unwrap_or_else(|| unreachable!())
    {
        let expected: Vec<u8> = serde_json::from_value(case["bytes"].clone())
            .unwrap_or_else(|error| unreachable!("bytes fixture: {error}"));
        assert_eq!(
            logical_value(case["base64"].clone(), Some(LogicalType::Bytes)).ok(),
            Some(LogicalValue::Bytes(expected))
        );
        assert!(matches!(
            logical_value(case["base64"].clone(), Some(LogicalType::String)),
            Ok(LogicalValue::String(_))
        ));
    }
    for case in fixture["invalid"]
        .as_array()
        .unwrap_or_else(|| unreachable!())
        .iter()
        .chain(
            fixture["wrongTypes"]
                .as_array()
                .unwrap_or_else(|| unreachable!()),
        )
    {
        assert!(
            logical_value(case.clone(), Some(LogicalType::Bytes)).is_err(),
            "{case}"
        );
    }
    assert!(logical_value(Value::Null, Some(LogicalType::Bytes)).is_err());
    assert!(matches!(
        logical_value(json!([0, 255]), Some(LogicalType::Json)),
        Ok(LogicalValue::Json(_))
    ));
}

#[test]
fn bytes_result_requires_physical_blob_identity_and_public_output_is_base64() {
    let bytes = LogicalValue::Bytes(vec![0, 1, 2, 255]);
    let internal = json!({"type": "blob", "base64": "AAEC/w=="});
    assert_eq!(encode_parameter_value(&bytes), internal);
    assert_eq!(encode_result_value(&bytes).ok(), Some(json!("AAEC/w==")));
    assert_eq!(
        logical_result_value(internal.clone(), &[LogicalType::Bytes]).ok(),
        Some(bytes)
    );
    for value in [
        json!("AAEC/w=="),
        json!([0, 1, 2, 255]),
        json!({"type":"text","base64":"AAEC/w=="}),
        json!({"type":"blob","base64":"AB=="}),
        json!({"type":"blob","base64":"AA==","extra":true}),
    ] {
        assert!(logical_result_value(value, &[LogicalType::Bytes]).is_err());
    }
    assert!(logical_result_value(internal.clone(), &[LogicalType::String]).is_err());
    assert!(logical_result_value(internal, &[LogicalType::Json]).is_err());
    assert_eq!(
        logical_result_value(
            json!("AAEC/w=="),
            &[LogicalType::Bytes, LogicalType::String]
        )
        .ok(),
        Some(LogicalValue::String("AAEC/w==".to_owned()))
    );
}

// Regression (PR #19 review): malformed input stays an encoding error however long
// it is; only well-formed oversize input is a limit error, on both the public
// parameter boundary and the private physical-result boundary.
#[test]
fn malformed_large_bytes_and_valid_oversize_have_distinct_error_categories() {
    use super::{RejectionKind, RuntimeError};
    let cases: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/bytes-limits.json"))
            .unwrap_or_else(|_| unreachable!("valid fixture"));
    for case in cases.as_array().unwrap_or_else(|| unreachable!()) {
        let encoded = case["pattern"]
            .as_str()
            .unwrap_or_else(|| unreachable!())
            .repeat(
                serde_json::from_value::<usize>(case["repeat"].clone())
                    .unwrap_or_else(|_| unreachable!()),
            )
            + case["suffix"].as_str().unwrap_or_else(|| unreachable!());
        let input = logical_value(json!(encoded), Some(LogicalType::Bytes));
        let result = logical_result_value(
            json!({"type":"blob","base64":encoded}),
            &[LogicalType::Bytes],
        );
        if case["tooLarge"] == true {
            assert!(
                matches!(
                    input,
                    Err(RuntimeError::Rejected(RejectionKind::LimitExceeded))
                ),
                "{case}"
            );
            assert!(
                matches!(
                    result,
                    Err(RuntimeError::Rejected(RejectionKind::LimitExceeded))
                ),
                "{case}"
            );
        } else {
            assert!(
                matches!(
                    input,
                    Err(RuntimeError::Rejected(RejectionKind::InvalidParameter))
                ),
                "{case}"
            );
            assert!(matches!(result, Err(RuntimeError::RemoteResult)), "{case}");
        }
    }
}

// The private result ABI classifies an oversized physical BLOB as a limit error
// (413), the same category both TypeScript transports produce before calling it.
#[test]
fn oversized_physical_blob_is_a_limit_error_at_the_result_abi() {
    let runtime = super::PolicySqlRuntime::new(
        CATALOG,
        POLICY,
        "bytes_schema",
        "bytes_policy",
        r#"{"max_rows":100,"max_result_bytes":1000000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"));
    let auth = r#"{"subject":"u","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_a"}}"#;
    let oversized =
        policysql_core::bytes::encode(&vec![0; policysql_core::bytes::MAX_BYTES_PER_VALUE + 1]);
    for (base64, code) in [
        (oversized.as_str(), Some("POLICYSQL_LIMIT_EXCEEDED")),
        ("AB==", Some("POLICYSQL_SCHEMA_MISMATCH")),
        ("AAEC/w==", None),
    ] {
        let compiled: Value = serde_json::from_str(&runtime.compile_json(
            auth,
            &json!({"statements":[{"sql":"SELECT state FROM projects","params":{}}]}).to_string(),
            "execute",
        ))
        .unwrap_or_else(|_| unreachable!());
        let handle = compiled["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("{compiled}"));
        let output: Value = serde_json::from_str(
            &runtime.validate_result_json(
                handle,
                0,
                &json!({
                    "columns": ["state"],
                    "rows": [[{"type": "blob", "base64": base64}]],
                    "affectedRows": 0
                })
                .to_string(),
            ),
        )
        .unwrap_or_else(|_| unreachable!());
        assert_eq!(output["error"]["code"].as_str(), code, "{output}");
        runtime.release_execution(handle);
    }
}
