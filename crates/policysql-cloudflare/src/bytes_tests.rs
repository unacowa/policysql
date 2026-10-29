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

#[test]
fn nullable_bytes_are_checked_at_every_parameter_use() {
    let runtime = super::PolicySqlRuntime::new(
        CATALOG,
        POLICY,
        "bytes_schema",
        "bytes_policy",
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"));
    let auth = r#"{"subject":"u","role":"member","roles":["member"],"access":["execute","explain"],"session":{"tenant_id":"tenant_a"}}"#;
    for (sql, accepted) in [
        (
            "UPDATE projects SET state=:value WHERE id='seed' RETURNING state",
            true,
        ),
        ("SELECT id FROM projects WHERE state=:value", true),
        ("SELECT id FROM projects WHERE seed=:value", false),
        (
            "SELECT id FROM projects WHERE state=:value AND seed=:value",
            false,
        ),
        (
            "SELECT id FROM projects WHERE state IN (:value) AND seed IN (:value)",
            false,
        ),
    ] {
        let output: Value = serde_json::from_str(&runtime.compile_json(
            auth,
            &json!({"statements":[{"sql":sql,"params":{"value":null}}]}).to_string(),
            "execute",
        ))
        .unwrap_or_else(|_| unreachable!());
        assert_eq!(output.get("error").is_none(), accepted, "{sql}: {output}");
        if let Some(handle) = output["executionHandle"].as_u64() {
            assert_eq!(
                output["statements"][0]["clientParameterTypes"]["value"],
                "bytes"
            );
            runtime.release_execution(handle);
        }
    }
    for (sql, nullable) in [
        (
            "UPDATE projects SET state=:value WHERE id='seed' RETURNING state",
            true,
        ),
        (
            "SELECT id FROM projects WHERE state=:value AND seed=:value",
            false,
        ),
    ] {
        let output: Value = serde_json::from_str(&runtime.compile_json(
            auth,
            &json!({"statements":[{"sql":sql,"params":{}}]}).to_string(),
            "explain",
        ))
        .unwrap_or_else(|_| unreachable!());
        assert_eq!(
            output["statements"][0]["clientParameterTypes"]["value"], "bytes",
            "{output}"
        );
        assert_eq!(
            output["statements"][0]["clientParameterNullable"]["value"], nullable,
            "{output}"
        );
    }
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
    assert_eq!(
        logical_value(Value::Null, Some(LogicalType::Bytes)).ok(),
        Some(LogicalValue::Null)
    );
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
