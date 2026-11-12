//! `error.detail` and the `rejection_reason` log record at the WASM ABI boundary (#145 pull
//! request C): the public detail of every refusal a compile returns, the identifier-free log
//! record, and the differential of a column or resource that does not exist against one the
//! role cannot see.

use policysql_transaction::machine::io::ErrorDetail;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const CATALOG: &str = r"
version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      name: { type: string }
      status: { type: string }
      private_note: { type: string }
      count: { type: integer, storage: integer }
      payload: { type: bytes }
  tasks:
    source: { table: tasks }
    columns:
      id: { type: string }
      project_id: { type: string }
      tenant_id: { type: string }
      title: { type: string }
  hidden:
    source: { table: hidden }
    columns:
      id: { type: string }
      tenant_id: { type: string }
";

const POLICY: &str = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, name, status, count, payload]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, name, status, count, payload]
          presets:
            tenant_id: { session: tenant_id }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name] }
        update:
          columns: [name, status]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name] }
        delete:
          filter: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id] }
  tasks:
    roles:
      member:
        select:
          columns: [id, project_id, title]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
";

const AUTH: &str = r#"{"principal":"test:user","subject":"u","role":"member","roles":["member"],"access":["execute","explain"],"session":{"tenant_id":"tenant_a"}}"#;
const AUTH_WITHOUT_TENANT: &str = r#"{"principal":"test:user","subject":"u","role":"member","roles":["member"],"access":["execute","explain"],"session":{}}"#;

fn runtime() -> super::PolicySqlRuntime {
    super::PolicySqlRuntime::new(
        CATALOG,
        POLICY,
        "schema_detail",
        "policy_detail",
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"))
}

fn compile_with(auth: &str, statement: &Value, endpoint: &str) -> Value {
    let request = json!({"statements": [statement]}).to_string();
    serde_json::from_str(&runtime().compile_json(auth, &request, endpoint))
        .unwrap_or_else(|_| unreachable!("runtime output is JSON"))
}

/// Compiles `sql` for Execute with every `:name` parameter given a string value.
fn compile(sql: &str) -> Value {
    compile_with(
        AUTH,
        &json!({"sql": sql, "params": parameters(sql)}),
        "execute",
    )
}

fn compile_params(sql: &str, params: &Value) -> Value {
    compile_with(AUTH, &json!({"sql": sql, "params": params}), "execute")
}

fn parameters(sql: &str) -> Value {
    let mut names = BTreeSet::new();
    let bytes = sql.as_bytes();
    for (position, byte) in bytes.iter().enumerate() {
        if *byte == b':' {
            let name: String = sql[position + 1..]
                .chars()
                .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
                .collect();
            if !name.is_empty() {
                names.insert(name);
            }
        }
    }
    Value::Object(names.into_iter().map(|name| (name, json!("x"))).collect())
}

fn code(output: &Value) -> &str {
    output["error"]["code"].as_str().unwrap_or("")
}

/// The detail as the public reply carries it, checked against the table of every boundary.
fn detail(output: &Value) -> Option<&Value> {
    let found = output["error"].get("detail");
    assert!(
        ErrorDetail::allowed(code(output), found),
        "the table refuses {} {found:?}",
        code(output)
    );
    found
}

#[test]
fn an_unsupported_construct_is_named_by_its_syntax() {
    for (sql, feature) in [
        ("SELECT * FROM projects", "star"),
        ("EXPLAIN SELECT id FROM projects", "explain"),
        ("PRAGMA x", "statement"),
        (
            "INSERT OR REPLACE INTO projects (id, name) VALUES (:id, :name)",
            "insert",
        ),
        (
            "INSERT INTO projects (id) SELECT id FROM projects",
            "insert_select",
        ),
        (
            "WITH projects AS (SELECT id FROM tasks) SELECT id FROM projects",
            "cte",
        ),
        (
            "SELECT id FROM projects UNION SELECT id FROM projects",
            "compound_select",
        ),
        ("SELECT DISTINCT id FROM projects", "distinct"),
        ("SELECT id FROM main.projects", "database_qualifier"),
        ("SELECT id FROM projects INDEXED BY x", "indexed_by"),
        ("VALUES (1)", "values"),
        ("SELECT id FROM projects WINDOW w AS ()", "window_clause"),
        ("DELETE FROM projects WHERE id = :id LIMIT 1", "delete"),
        (
            "UPDATE OR REPLACE projects SET name = :n WHERE id = :id",
            "update",
        ),
        ("SELECT id FROM (SELECT id FROM projects)", "derived_table"),
        (
            "SELECT id FROM projects ORDER BY id NULLS FIRST",
            "nulls_ordering",
        ),
        ("SELECT id FROM projects, tasks", "join"),
        ("SELECT nofunc(id) FROM projects", "expression"),
        ("SELECT id FROM projects WHERE id = X'00'", "literal"),
    ] {
        let output = compile(sql);
        assert_eq!(
            code(&output),
            "POLICYSQL_UNSUPPORTED_SQL",
            "{sql}: {output}"
        );
        assert_eq!(detail(&output), Some(&json!({"feature": feature})), "{sql}");
        assert_eq!(output["error"]["path"], "/statements/0", "{sql}");
    }
}

#[test]
fn a_parse_error_carries_the_byte_span_of_the_token_and_other_failures_none() {
    let at = |sql: &str, start: usize, end: usize| {
        let output = compile(sql);
        assert_eq!(code(&output), "POLICYSQL_INVALID_SQL", "{sql}: {output}");
        assert_eq!(
            detail(&output),
            Some(&json!({"span": {"start": start, "end": end}})),
            "{sql}"
        );
        // The span cuts the token out of the UTF-8 bytes.
        let token = &sql.as_bytes()[start..end];
        assert!(!token.is_empty(), "{sql}");
    };
    let unterminated = "SELECT id FROM projects WHERE name = 'abc";
    at(unterminated, unterminated.len() - 4, unterminated.len());
    at("SELECT 1; SELEC 2", 10, 15);
    // Two three-byte characters before the token: the offset is in bytes, not UTF-16 units.
    let multibyte = "SELECT \u{3042} \u{3044} FROM projects WHERE @@ = 1";
    let start = multibyte.find('@').unwrap_or(0);
    assert_eq!(start, 35, "UTF-16 units would put it at 31");
    at(multibyte, start, start + 1);
    for sql in ["SELECT", "SELECT /* x", "SELECT [abc", "", "   "] {
        let output = compile(sql);
        assert_eq!(code(&output), "POLICYSQL_INVALID_SQL", "{sql:?}: {output}");
        assert_eq!(detail(&output), None, "{sql:?}");
    }
    // Several statements are a different code and have no detail.
    let output = compile("SELECT id FROM projects; SELECT id FROM projects");
    assert_eq!(code(&output), "POLICYSQL_MULTIPLE_STATEMENTS");
    assert_eq!(detail(&output), None);
}

#[test]
fn a_parameter_refusal_names_the_reason_and_never_the_parameter() {
    for (sql, params, reason) in [
        (
            "SELECT id FROM projects WHERE id = ?",
            json!({}),
            "positional",
        ),
        (
            "SELECT id FROM projects WHERE id = ?1",
            json!({}),
            "positional",
        ),
        ("SELECT id FROM projects WHERE id = $x", json!({}), "prefix"),
        ("SELECT id FROM projects WHERE id = @x", json!({}), "prefix"),
        ("SELECT id FROM projects WHERE id = 1", json!({}), "type"),
        ("SELECT id FROM projects WHERE id = NULL", json!({}), "null"),
        (
            "SELECT id FROM projects WHERE id = 'se\0ed'",
            json!({}),
            "literal",
        ),
        ("SELECT id FROM projects WHERE id = :x", json!({}), "names"),
        (
            "SELECT id FROM projects WHERE id = :x",
            json!({"x": "a", "y": "b"}),
            "names",
        ),
        (
            "SELECT id FROM projects WHERE id = :x",
            json!({"x": 1}),
            "value",
        ),
        (
            "SELECT id FROM projects WHERE id = :x",
            json!({"x": {"a": 1}}),
            "value",
        ),
        (
            "SELECT id FROM projects WHERE payload = :x",
            json!({"x": "!!"}),
            "value",
        ),
        (
            "SELECT id FROM projects WHERE payload = :x",
            json!({"x": 5}),
            "value",
        ),
        (
            "SELECT id FROM projects WHERE id = :x",
            json!({"1bad": "a"}),
            "name",
        ),
    ] {
        let output = compile_params(sql, &params);
        assert_eq!(
            code(&output),
            "POLICYSQL_INVALID_PARAMETER",
            "{sql} {params}: {output}"
        );
        assert_eq!(
            detail(&output),
            Some(&json!({"reason": reason})),
            "{sql} {params}"
        );
        let text = output.to_string();
        assert!(!text.contains("1bad") && !text.contains("\"x\""), "{text}");
    }
}

#[test]
fn a_declared_expectation_that_cannot_hold_names_which_one() {
    let insert = json!({
        "sql": "INSERT INTO projects (id, name, status) VALUES (:id, :name, :status)",
        "params": {"id": "a", "name": "b", "status": "c"},
        "expect": {"affectedRows": 2},
    });
    let output = compile_with(AUTH, &insert, "execute");
    assert_eq!(code(&output), "POLICYSQL_EXPECTATION_FAILED", "{output}");
    assert_eq!(
        detail(&output),
        Some(&json!({"expectation": "affectedRows"}))
    );
    // An expectation on a SELECT's affected rows is an invalid request, with no detail.
    let select =
        json!({"sql": "SELECT id FROM projects", "params": {}, "expect": {"affectedRows": 1}});
    let output = compile_with(AUTH, &select, "execute");
    assert_eq!(code(&output), "POLICYSQL_INVALID_REQUEST", "{output}");
    assert_eq!(detail(&output), None);
}

#[test]
fn a_complexity_refusal_names_the_cause_and_never_a_position() {
    let long = "a".repeat(50_001);
    let output = compile_params(
        "SELECT id FROM projects WHERE name LIKE :q",
        &json!({"q": long}),
    );
    assert_eq!(code(&output), "POLICYSQL_SQL_TOO_COMPLEX", "{output}");
    assert_eq!(
        detail(&output),
        Some(&json!({"complexity": "like_pattern"}))
    );
    assert!(output["error"]["detail"].get("span").is_none());
    // A complexity refusal has its own log event, not `rejection_reason`.
    assert!(output.get("log").is_none(), "{output}");
}

#[test]
fn codes_without_a_table_row_carry_no_detail() {
    let wide = format!(
        "SELECT {} FROM projects",
        (0..200)
            .map(|index| format!("id AS c{index}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    for (sql, expected) in [
        (wide.as_str(), "POLICYSQL_LIMIT_EXCEEDED"),
        ("SELECT nope FROM projects", "POLICYSQL_FORBIDDEN_COLUMN"),
        (
            "SELECT private_note FROM projects",
            "POLICYSQL_FORBIDDEN_COLUMN",
        ),
        ("SELECT id FROM nope", "POLICYSQL_FORBIDDEN_OPERATION"),
        ("SELECT id FROM hidden", "POLICYSQL_MISSING_POLICY"),
        (
            "SELECT id AS a, name AS a FROM projects",
            "POLICYSQL_DUPLICATE_RESULT_COLUMN",
        ),
        (
            "SELECT id FROM projects WHERE id = :__policysql_x",
            "POLICYSQL_RESERVED_PARAMETER",
        ),
    ] {
        let output = compile(sql);
        assert_eq!(code(&output), expected, "{sql}: {output}");
        assert_eq!(detail(&output), None, "{sql}");
    }
}

fn log(output: &Value) -> &Value {
    assert_eq!(output["log"]["event"], "rejection_reason", "{output}");
    &output["log"]
}

#[test]
#[allow(clippy::too_many_lines)]
fn the_rejection_reason_names_the_stage_and_the_variant_and_no_identifier() {
    for (sql, expected_code, reason, shape) in [
        (
            "SELECT nope FROM projects",
            "POLICYSQL_FORBIDDEN_COLUMN",
            "bind.UnknownColumn",
            Value::Null,
        ),
        (
            "SELECT private_note FROM projects",
            "POLICYSQL_FORBIDDEN_COLUMN",
            "policy.ForbiddenColumn",
            Value::Null,
        ),
        (
            "SELECT id FROM hidden",
            "POLICYSQL_MISSING_POLICY",
            "policy.MissingPolicy",
            Value::Null,
        ),
        (
            "SELECT id FROM nope",
            "POLICYSQL_FORBIDDEN_OPERATION",
            "bind.UnknownResource",
            Value::Null,
        ),
        (
            "SELECT * FROM projects",
            "POLICYSQL_UNSUPPORTED_SQL",
            "bind.Unsupported",
            json!("star projection"),
        ),
        (
            "WITH projects AS (SELECT id FROM tasks) SELECT id FROM projects",
            "POLICYSQL_UNSUPPORTED_SQL",
            "bind.Unsupported",
            json!("CTE shadows protected resource"),
        ),
        (
            "SELECT id FROM projects WHERE id = ?",
            "POLICYSQL_INVALID_PARAMETER",
            "bind.PositionalParameter",
            Value::Null,
        ),
        (
            "SELECT id FROM projects WHERE id = :x AND id = :y",
            "POLICYSQL_INVALID_PARAMETER",
            "compile.ClientParameterMismatch",
            Value::Null,
        ),
        (
            "SELECT",
            "POLICYSQL_INVALID_SQL",
            "bind.InvalidSql",
            Value::Null,
        ),
    ] {
        let params = if reason.starts_with("compile.") {
            json!({"x": "a"})
        } else {
            parameters(sql)
        };
        let output = compile_params(sql, &params);
        assert_eq!(code(&output), expected_code, "{sql}: {output}");
        let record = log(&output);
        assert_eq!(record["code"], expected_code, "{sql}");
        assert_eq!(record["reason"], reason, "{sql}");
        assert_eq!(record["shape"], shape, "{sql}");
        assert_eq!(record["statementIndex"], 0, "{sql}");
        assert_eq!(record["schemaVersion"], "schema_detail", "{sql}");
        assert_eq!(record["policyVersion"], "policy_detail", "{sql}");
        assert_eq!(record["abiVersion"], 21, "{sql}");
        assert!(
            record["reason"]
                .as_str()
                .is_some_and(
                    |reason| reason.split_once('.').is_some_and(|(stage, name)| {
                        !stage.is_empty()
                            && stage.bytes().all(|byte| byte.is_ascii_lowercase())
                            && !name.is_empty()
                            && name.bytes().all(|byte| byte.is_ascii_alphabetic())
                    })
                ),
            "{record}"
        );
    }
    // A session without the value the policy needs is the operator's configuration problem.
    let output = compile_with(
        AUTH_WITHOUT_TENANT,
        &json!({"sql": "SELECT id FROM projects", "params": {}}),
        "execute",
    );
    assert_eq!(code(&output), "POLICYSQL_FORBIDDEN_OPERATION", "{output}");
    assert_eq!(log(&output)["reason"], "policy.MissingSessionValue");
    // The statement index is the failing statement's.
    let request = json!({"statements": [
        {"sql": "SELECT id FROM projects", "params": {}},
        {"sql": "SELECT nope FROM projects", "params": {}},
    ]})
    .to_string();
    let output: Value = serde_json::from_str(&runtime().compile_json(AUTH, &request, "execute"))
        .unwrap_or_default();
    assert_eq!(log(&output)["statementIndex"], 1);
    assert_eq!(output["error"]["path"], "/statements/1");
}

#[test]
fn the_response_and_the_log_never_contain_the_identifiers_of_the_sql() {
    let identifiers = [
        "zzz_secret_column",
        "\"zzz quoted name\"",
        "__policysql_tenant_id",
        "tenant_id",
        "private_note",
        "hidden",
    ];
    for identifier in identifiers {
        for template in [
            "SELECT {} FROM projects",
            "SELECT id FROM projects WHERE {} = :x",
            "SELECT id FROM {}",
            "SELECT id FROM projects WHERE {} = 1",
            "SELECT id FROM projects WHERE id = 1 AND {} = ?",
            "SELECT * FROM {}",
            "WITH {} AS (SELECT id FROM tasks) SELECT {}.id FROM {}",
            "INSERT INTO projects ({}) VALUES (:x)",
            "UPDATE projects SET {} = :x",
            "SELECT id FROM projects WHERE name = '{}",
        ] {
            let sql = template.replace("{}", identifier);
            let output = compile(&sql);
            if output.get("error").is_none() {
                continue;
            }
            let text = output.to_string();
            for name in ["zzz_secret_column", "zzz quoted name", "__policysql_"] {
                assert!(!text.contains(name), "{sql}: {text}");
            }
            // `tenant_id` and `private_note` are the fixture's own names: the response must not
            // echo them unless the fixed text of the error already did (it never does).
            for name in ["tenant_id", "private_note", "hidden"] {
                if !sql.contains(name) {
                    continue;
                }
                assert!(!text.contains(name), "{sql}: {text}");
            }
        }
    }
}

/// A span is only ever the client's own bytes: every refusal that carries one is an
/// `INVALID_SQL` whose range lies within the statement.
#[test]
fn only_a_parse_error_has_a_span_and_it_lies_inside_the_statement() {
    let corpus = [
        "SELECT",
        "SELECT id FROM projects WHERE name = 'abc",
        "SELECT 1; SELEC 2",
        "SELECT \u{3042} \u{3044} FROM projects WHERE @@ = 1",
        "SELECT x\0y",
        "SELECT /* x",
        "SELECT [abc",
        "SELECT id FROM projects WHERE id = 0x",
        "SELECT id FROM projects WHERE id = 1e",
        "SELECT id FROM projects WHERE id ! 1",
        "SELECT id FROM projects WHERE id = :",
        "SELEC id FROM projects",
        "SELECT id FROM projects WHERE",
        "SELECT id FROM projects ORDER",
        "SELECT ( FROM projects",
        "SELECT id FROM projects WHERE id = 1 1",
        "INSERT INTO projects VALUES (",
        "UPDATE projects SET = 1",
        "DELETE projects",
        "\u{1F600}",
        "SELECT '\u{1F600}",
    ];
    let mut spans = 0;
    for sql in corpus {
        let output = compile(sql);
        assert!(output.get("error").is_some(), "{sql:?}: {output}");
        let found = detail(&output);
        if let Some(span) = found.and_then(|found| found.get("span")) {
            spans += 1;
            assert_eq!(code(&output), "POLICYSQL_INVALID_SQL", "{sql:?}");
            let start = span["start"].as_u64().unwrap_or(u64::MAX);
            let end = span["end"].as_u64().unwrap_or(u64::MAX);
            assert!(start <= end, "{sql:?}");
            assert!(
                end <= u64::try_from(sql.len()).unwrap_or(0),
                "{sql:?}: {span}"
            );
        }
    }
    assert!(spans >= 8, "{spans}");
}

/// The policy rewrites the client's statement but keeps every client parameter: the
/// parameter set that the `names` reason compares is the binder's set.
#[test]
fn the_policy_does_not_remove_a_client_parameter() {
    use policysql_parser::SqliteFrontend;
    let catalog = super::activate_catalog(
        CATALOG,
        policysql_core::SnapshotId::new("s").unwrap_or_else(|_| unreachable!()),
    )
    .unwrap_or_else(|_| unreachable!("catalog"));
    for sql in [
        "SELECT id FROM projects WHERE id = :a",
        "SELECT id FROM projects WHERE id = :a AND name = :b ORDER BY id LIMIT 5",
        "SELECT id FROM projects WHERE id IN (:a, :b) OR name LIKE :c",
        "SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.name = :a AND t.title = :b",
        "SELECT id FROM projects WHERE EXISTS (SELECT 1 FROM tasks WHERE tasks.project_id = :a)",
        "INSERT INTO projects (id, name) VALUES (:a, :b) RETURNING id",
        "UPDATE projects SET name = :a WHERE id = :b RETURNING id",
        "DELETE FROM projects WHERE id = :a RETURNING id",
    ] {
        let bound = SqliteFrontend::default()
            .bind_document(sql, &catalog)
            .unwrap_or_else(|error| unreachable!("{sql}: {error}"));
        let output = compile(sql);
        assert!(output.get("error").is_none(), "{sql}: {output}");
        let reported: BTreeSet<String> = output["statements"][0]["clientParameters"]
            .as_object()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default();
        let before: BTreeSet<String> = bound
            .parameters
            .iter()
            .map(|name| name.as_str().to_owned())
            .collect();
        assert_eq!(reported, before, "{sql}");
    }
}

/// Existence pairs: a column or resource that does not exist and one the role cannot see, in
/// every place the name is resolved. The property: where the two answers have the same code,
/// they are the same answer, `detail` included. Where the codes differ, the template is listed
/// below, with the change that closes it; a new difference, or a listed one that disappears,
/// fails the test.
#[test]
#[allow(clippy::too_many_lines)]
fn a_missing_name_and_a_hidden_one_are_answered_alike_where_the_code_is_the_same() {
    // Same code, different `detail`: the binder refuses a CTE named like a Catalog resource
    // before the role is looked at ("CTE shadows protected resource"), while a CTE of a name
    // that is not a resource goes on to its next refusal. Closed by the resource-unification
    // change (#145 proposal 7).
    const DETAIL_SPLITS: [&str; 1] = ["WITH {R} AS (SELECT id FROM projects) SELECT * FROM {R}"];
    // Different codes. A resource without a policy for the role is `MISSING_POLICY`, one that
    // does not exist `FORBIDDEN_OPERATION` (#145 proposal 7: stop telling resources apart).
    const RESOURCE_CODE_SPLITS: [&str; 10] = [
        "SELECT id FROM {R}",
        "SELECT id FROM {R} WHERE id = :v",
        "SELECT {R}.id FROM {R}",
        "SELECT r.id FROM {R} AS r ORDER BY r.id",
        "SELECT id FROM {R} r",
        "INSERT INTO {R} (id) VALUES (:v)",
        "UPDATE {R} SET id = :v WHERE id = :i",
        "DELETE FROM {R} WHERE id = :v",
        "SELECT p.id FROM projects p JOIN {R} r ON r.id = p.id",
        "SELECT id FROM projects WHERE EXISTS (SELECT 1 FROM {R} WHERE {R}.id = :v)",
    ];
    // Different codes: the statement is refused by the policy for a reason of its own
    // (aggregation and windows are off) after the binder resolved every column against the
    // whole Catalog, so a hidden column reaches that refusal and a missing one does not (#154).
    const POLICY_ORDER_CODE_SPLITS: [&str; 2] = [
        "SELECT id, count(*) FROM projects GROUP BY {C}",
        "SELECT row_number() OVER (ORDER BY {C}) FROM projects",
    ];
    // Different codes: the binder refuses a column used as an inserted or assigned value as
    // an unsupported form before it resolves the name, so a hidden column is `UNSUPPORTED_SQL`
    // and a missing one `FORBIDDEN_COLUMN`. Found by this test; the public code was already
    // different before `detail`.
    const VALUE_POSITION_CODE_SPLITS: [&str; 2] = [
        "INSERT INTO projects (id, name) VALUES (:id, {C})",
        "UPDATE projects SET name = {C} WHERE id = :id",
    ];
    let column_templates = [
        "SELECT {C} FROM projects",
        "SELECT {C} AS x FROM projects",
        "SELECT projects.{C} FROM projects",
        "SELECT p.{C} FROM projects p",
        "SELECT upper({C}) FROM projects",
        "SELECT count({C}) FROM projects",
        "SELECT max({C}) FROM projects",
        "SELECT CASE WHEN {C} = :v THEN 1 ELSE 0 END FROM projects",
        "SELECT id FROM projects WHERE {C} = :v",
        "SELECT id FROM projects WHERE {C} IS NULL",
        "SELECT id FROM projects WHERE {C} LIKE :v",
        "SELECT id FROM projects WHERE lower({C}) = :v",
        "SELECT id FROM projects WHERE {C} BETWEEN :a AND :b",
        "SELECT id FROM projects WHERE {C} IN (:a, :b)",
        "SELECT id FROM projects WHERE id = :id AND {C} = :v",
        "SELECT id FROM projects WHERE name = :v OR {C} = :v",
        "SELECT id FROM projects ORDER BY {C}",
        "SELECT id FROM projects ORDER BY {C} DESC LIMIT 5",
        "SELECT id, count(*) FROM projects GROUP BY {C}",
        "SELECT id FROM projects WHERE id IN (SELECT {C} FROM projects)",
        "SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.{C} = :v",
        "SELECT t.id FROM tasks t JOIN projects p ON p.{C} = t.project_id",
        "SELECT id FROM tasks WHERE EXISTS (SELECT 1 FROM projects WHERE projects.{C} = :v)",
        "INSERT INTO projects ({C}) VALUES (:v)",
        "INSERT INTO projects (id, name) VALUES (:id, {C})",
        "INSERT INTO projects (id, name) VALUES (:id, :n) RETURNING {C}",
        "UPDATE projects SET {C} = :v WHERE id = :id",
        "UPDATE projects SET name = {C} WHERE id = :id",
        "UPDATE projects SET name = :v WHERE {C} = :id",
        "UPDATE projects SET name = :v WHERE id = :id RETURNING {C}",
        "DELETE FROM projects WHERE {C} = :v",
        "DELETE FROM projects WHERE id = :id RETURNING {C}",
        "SELECT row_number() OVER (ORDER BY {C}) FROM projects",
    ];
    let resource_templates = [
        "SELECT id FROM {R}",
        "SELECT id FROM {R} WHERE id = :v",
        "SELECT {R}.id FROM {R}",
        "SELECT r.id FROM {R} AS r ORDER BY r.id",
        "SELECT id FROM {R} r",
        "INSERT INTO {R} (id) VALUES (:v)",
        "UPDATE {R} SET id = :v WHERE id = :i",
        "DELETE FROM {R} WHERE id = :v",
        "SELECT p.id FROM projects p JOIN {R} r ON r.id = p.id",
        "SELECT id FROM projects WHERE id IN (SELECT id FROM {R})",
        "SELECT id FROM projects WHERE EXISTS (SELECT 1 FROM {R} WHERE {R}.id = :v)",
        "WITH {R} AS (SELECT id FROM projects) SELECT * FROM {R}",
    ];
    assert!(column_templates.len() + resource_templates.len() >= 30);
    let mut detail_splits = BTreeSet::new();
    let mut code_splits = BTreeSet::new();
    let mut checked = 0;
    for (templates, token, present, absent) in [
        (
            &column_templates[..],
            "{C}",
            "private_note",
            "no_such_column",
        ),
        (&resource_templates[..], "{R}", "hidden", "no_such_table"),
    ] {
        for template in templates {
            for endpoint in ["execute", "explain"] {
                let answer = |name: &str| {
                    let sql = template.replace(token, name);
                    let params = if endpoint == "execute" {
                        parameters(&sql)
                    } else {
                        json!({})
                    };
                    compile_with(AUTH, &json!({"sql": sql, "params": params}), endpoint)
                };
                let (seen, missing) = (answer(present), answer(absent));
                assert!(seen.get("error").is_some(), "{endpoint} {template}: {seen}");
                assert!(
                    missing.get("error").is_some(),
                    "{endpoint} {template}: {missing}"
                );
                // Only the operator-facing log may differ: it names the stage that refused.
                if code(&seen) != code(&missing) {
                    code_splits.insert(*template);
                } else if seen["error"] != missing["error"] {
                    detail_splits.insert(*template);
                }
                checked += 1;
            }
        }
    }
    assert_eq!(
        detail_splits,
        BTreeSet::from(DETAIL_SPLITS),
        "the answers of a hidden name and a missing one differ in `detail` exactly where listed"
    );
    assert_eq!(
        code_splits,
        RESOURCE_CODE_SPLITS
            .into_iter()
            .chain(POLICY_ORDER_CODE_SPLITS)
            .chain(VALUE_POSITION_CODE_SPLITS)
            .collect::<BTreeSet<_>>(),
        "the codes of a hidden name and a missing one differ exactly where listed"
    );
    assert!(checked >= 60, "{checked}");
}
