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
      private_int: { type: integer, storage: integer }
      private_json: { type: json, representation: object, storage: text }
      private_bool: { type: boolean, storage: integer }
      private_bytes: { type: bytes }
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
    // A complexity refusal has its own log event, not `rejection_reason`, and Explain's
    // `compile_json` carries it like any other refusal's record.
    assert_eq!(output["log"]["event"], "sql_too_complex", "{output}");
    assert_eq!(output["log"]["cause"], "like_pattern");
    assert_eq!(output["log"]["statementIndex"], 0);
    assert!(output["log"].get("requestId").is_none());
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
        ("SELECT id FROM nope", "POLICYSQL_MISSING_POLICY"),
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
            "bind.UnknownResource",
            Value::Null,
        ),
        (
            "SELECT id FROM nope",
            "POLICYSQL_MISSING_POLICY",
            "bind.UnknownResource",
            Value::Null,
        ),
        (
            "DELETE FROM tasks WHERE id = :v",
            "POLICYSQL_MISSING_POLICY",
            "policy.MissingPolicy",
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
        assert_eq!(record["abiVersion"], 23, "{sql}");
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

/// How a hidden name and a missing one are answered, per template.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Pair {
    /// The same answer (or the same error code and the same detail).
    Alike,
    /// The same code, a different `detail`.
    DetailSplit,
    /// Different codes.
    CodeSplit,
    /// The hidden name compiles and the missing one is refused.
    HiddenAccepted,
    /// Both compile, to the same statements.
    BothAccepted,
}

/// Existence pairs: a column or resource that does not exist and one the role cannot see, in
/// every place the name is resolved, for a hidden column of each logical type. The property:
/// where the two answers have the same code, they are the same answer, `detail` included.
/// Everywhere else the template is listed below, with the change that closes it; a new
/// difference, or a listed one that disappears, fails the test.
#[test]
#[allow(clippy::too_many_lines)]
fn a_missing_name_and_a_hidden_one_are_answered_alike_where_the_code_is_the_same() {
    // A resource the role has no policy on is not in the Catalog its SQL is bound against, so it
    // is the same input as a name that does not exist (#145 pull request D): every resource
    // template is answered alike, except the CTEs named like it, which both compile.
    const BOTH_ACCEPTED: [&str; 4] = [
        "WITH {R} AS (SELECT id FROM projects) SELECT id FROM {R}",
        "WITH {R} AS (SELECT id FROM projects) SELECT {R}.id FROM {R}",
        "WITH {R} AS (SELECT id FROM projects) SELECT p.id FROM {R} AS p",
        "SELECT {R}.id FROM projects AS {R}",
    ];
    // Different codes: the statement is refused by the policy for a reason of its own
    // (aggregation, windows and JSON collections are off) after the binder resolved every
    // column of the role's resources, so a hidden column reaches that refusal and a missing
    // one does not (#154).
    const POLICY_ORDER_CODE_SPLITS: [&str; 5] = [
        "SELECT id, count(*) FROM projects GROUP BY {C}",
        "SELECT row_number() OVER (ORDER BY {C}) FROM projects",
        "SELECT id FROM projects GROUP BY id HAVING {C} IS NULL",
        "SELECT id FROM projects GROUP BY id HAVING {C} = :v",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.{C}, '$') AS j",
    ];
    // Different codes: the binder and the decoding of the values run against the role's Binding
    // Catalog before the policy, so the type of a hidden column shows in the code
    // (`INVALID_PARAMETER` for a literal or value of another type, `FORBIDDEN_COLUMN` for a
    // column that does not exist). Documented in the ADR 0030 amendment and the security model;
    // the root fix is #154. A single request already tells the same fact from the code.
    const TYPE_CODE_SPLITS: [&str; 3] = [
        "SELECT id FROM projects WHERE {C} = 1",
        "SELECT id FROM projects WHERE {C} = TRUE",
        "SELECT id FROM projects WHERE {C} = 'a'",
    ];
    // Different codes: the binder refuses a column used as an inserted or assigned value as
    // an unsupported form before it resolves the name, so a hidden column is `UNSUPPORTED_SQL`
    // and a missing one `FORBIDDEN_COLUMN`. Found by this test; the public code was already
    // different before `detail`.
    const VALUE_POSITION_CODE_SPLITS: [&str; 2] = [
        "INSERT INTO projects (id, name) VALUES (:id, {C})",
        "UPDATE projects SET name = {C} WHERE id = :id",
    ];
    // The hidden name compiles and the missing one is refused: a column that a derived table
    // or a CTE carries but the outer statement does not use is not checked (#141).
    const ACCEPTED_HIDDEN_SPLITS: [&str; 2] = [
        "WITH c AS (SELECT id, {C} FROM projects) SELECT id FROM c",
        "SELECT d.id FROM (SELECT id, {C} FROM projects) AS d",
    ];
    // A hidden column of another type is run with the templates that do not themselves ask for a
    // type (a value or a function argument), so that what differs is the name and not a
    // parameter value of the wrong type; the literal comparisons are the type probes.
    const TYPED_TEMPLATES: [&str; 22] = [
        "SELECT {C} FROM projects",
        "SELECT projects.{C} FROM projects",
        "SELECT id FROM projects WHERE {C} IS NULL",
        "SELECT id FROM projects ORDER BY {C}",
        "UPDATE projects SET name = :v WHERE {C} IS NULL",
        "DELETE FROM projects WHERE {C} IS NULL",
        "INSERT INTO projects (id, name) VALUES (:id, :n) RETURNING {C}",
        "SELECT id FROM projects WHERE {C} = 'a'",
        "SELECT id FROM projects WHERE {C} = 1",
        "SELECT id FROM projects WHERE {C} = TRUE",
        "WITH c AS (SELECT id, {C} FROM projects) SELECT id FROM c",
        "WITH c AS (SELECT id, {C} FROM projects) SELECT {C} FROM c",
        "WITH c AS (SELECT id, {C} FROM projects) SELECT c.{C} FROM c",
        "SELECT d.id FROM (SELECT id, {C} FROM projects) AS d",
        "SELECT d.{C} FROM (SELECT id, {C} FROM projects) AS d",
        "SELECT id FROM projects GROUP BY id HAVING {C} IS NULL",
        "SELECT id, count(*) FROM projects GROUP BY id HAVING count({C}) > 1",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.{C}, '$') AS j",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.id, :path) AS j WHERE p.{C} IS NULL",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.id, '$') AS j WHERE j.{C} IS NULL",
        "SELECT id, count(*) FROM projects GROUP BY {C}",
        "SELECT row_number() OVER (ORDER BY {C}) FROM projects",
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
        "SELECT id FROM projects WHERE {C} = 'a'",
        "SELECT id FROM projects WHERE {C} = 1",
        "SELECT id FROM projects WHERE {C} = TRUE",
        "WITH c AS (SELECT id, {C} FROM projects) SELECT id FROM c",
        "WITH c AS (SELECT id, {C} FROM projects) SELECT {C} FROM c",
        "WITH c AS (SELECT id, {C} FROM projects) SELECT c.{C} FROM c",
        "SELECT d.id FROM (SELECT id, {C} FROM projects) AS d",
        "SELECT d.{C} FROM (SELECT id, {C} FROM projects) AS d",
        "SELECT id FROM projects GROUP BY id HAVING {C} IS NULL",
        "SELECT id FROM projects GROUP BY id HAVING {C} = :v",
        "SELECT id, count(*) FROM projects GROUP BY id HAVING count({C}) > 1",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.{C}, '$') AS j",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.id, :path) AS j WHERE p.{C} IS NULL",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.id, '$') AS j WHERE j.{C} IS NULL",
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
        "SELECT nope FROM {R}",
        "SELECT {R}.nope FROM {R}",
        "SELECT * FROM {R}",
        "SELECT id FROM {R} WHERE tenant_id = 1",
        "SELECT id FROM {R} WHERE tenant_id = TRUE",
        "SELECT id FROM {R} WHERE id = NULL",
        "SELECT id FROM {R} ORDER BY nope",
        "SELECT count(*) FROM {R}",
        "SELECT id, count(*) FROM {R} GROUP BY id",
        "SELECT row_number() OVER (ORDER BY id) FROM {R}",
        "SELECT upper(nope) FROM {R}",
        "INSERT INTO {R} (id, nope) VALUES (:a, :b)",
        "INSERT INTO {R} (id) VALUES (1)",
        "INSERT INTO {R} (id) VALUES (:v) RETURNING nope",
        "UPDATE {R} SET nope = :v",
        "UPDATE {R} SET id = 1 WHERE id = :i",
        "DELETE FROM {R} WHERE nope = :v",
        "DELETE FROM {R} WHERE id = :v RETURNING nope",
        "SELECT p.id FROM projects p JOIN {R} r ON r.nope = p.id",
        "SELECT p.id FROM projects p LEFT JOIN {R} r ON r.id = p.id",
        "SELECT id FROM projects WHERE EXISTS (SELECT 1 FROM {R} WHERE {R}.nope = projects.id)",
        "SELECT id FROM projects WHERE EXISTS (SELECT 1 FROM {R} r WHERE r.id = projects.id)",
        "SELECT d.id FROM (SELECT id FROM {R}) AS d",
        "WITH c AS (SELECT id FROM {R}) SELECT id FROM c",
        "WITH {R} AS (SELECT id FROM projects) SELECT id FROM {R}",
        "WITH {R} AS (SELECT id FROM projects) SELECT {R}.id FROM {R}",
        "SELECT json_group_array(j.value) AS items FROM {R} AS r, json_each(r.id, '$') AS j",
        "SELECT {R}.id FROM projects",
        "SELECT {R}.id FROM projects AS {R}",
        "SELECT id FROM \"{R}\"",
        "WITH {R} AS (SELECT id FROM {R}) SELECT id FROM {R}",
        "WITH {R} AS (SELECT id FROM projects) SELECT p.id FROM {R} AS p",
        "WITH c AS (SELECT id FROM {R}) SELECT p.id FROM projects p JOIN c ON c.id = p.id",
        "DELETE FROM projects WHERE EXISTS (SELECT 1 FROM {R} r WHERE r.id = projects.id)",
    ];
    assert!(column_templates.len() + resource_templates.len() >= 55);
    let answer = |template: &str, token: &str, name: &str, endpoint: &str| {
        let sql = template.replace(token, name);
        let params = if endpoint == "execute" {
            parameters(&sql)
        } else {
            json!({})
        };
        compile_with(AUTH, &json!({"sql": sql, "params": params}), endpoint)
    };
    let mut seen: std::collections::BTreeMap<Pair, BTreeSet<&str>> =
        std::collections::BTreeMap::new();
    let mut checked = 0;
    let mut cases: Vec<(&str, &str, &str)> = Vec::new();
    for template in &column_templates {
        cases.push((template, "{C}", "private_note"));
        if TYPED_TEMPLATES.contains(template) {
            for hidden in [
                "private_int",
                "private_json",
                "private_bool",
                "private_bytes",
            ] {
                cases.push((template, "{C}", hidden));
            }
        }
    }
    // The names are also written in capitals: a name is looked up without regard to case.
    let mut named: Vec<(&str, &str, &str, &str)> = cases
        .into_iter()
        .map(|(template, token, hidden)| (template, token, hidden, "no_such_column"))
        .collect();
    for template in &resource_templates {
        named.push((template, "{R}", "hidden", "no_such_table"));
        named.push((template, "{R}", "HIDDEN", "NO_SUCH_TABLE"));
    }
    let mut only_missing: BTreeSet<&str> = BTreeSet::new();
    for (template, token, hidden, absent) in named {
        for endpoint in ["execute", "explain"] {
            let (seen_answer, missing) = (
                answer(template, token, hidden, endpoint),
                answer(template, token, absent, endpoint),
            );
            let pair = if seen_answer.get("error").is_none() && missing.get("error").is_none() {
                assert_eq!(
                    seen_answer["statements"], missing["statements"],
                    "{endpoint} {template}"
                );
                Pair::BothAccepted
            } else if missing.get("error").is_none() {
                only_missing.insert(template);
                continue;
            } else if seen_answer.get("error").is_none() {
                Pair::HiddenAccepted
            } else if code(&seen_answer) != code(&missing) {
                Pair::CodeSplit
            } else if seen_answer["error"] != missing["error"] {
                Pair::DetailSplit
            } else {
                Pair::Alike
            };
            seen.entry(pair).or_default().insert(template);
            checked += 1;
        }
    }
    let listed = |lists: &[&[&'static str]]| -> BTreeSet<&'static str> {
        lists.iter().flat_map(|list| list.iter().copied()).collect()
    };
    let got = |pair: Pair| -> BTreeSet<&str> { seen.get(&pair).cloned().unwrap_or_default() };
    assert_eq!(
        only_missing,
        BTreeSet::new(),
        "a name that does not exist never compiles where a hidden one is refused"
    );
    assert_eq!(
        got(Pair::DetailSplit),
        BTreeSet::new(),
        "the answers of a hidden name and a missing one never differ in `detail`"
    );
    assert_eq!(
        got(Pair::CodeSplit),
        listed(&[
            &POLICY_ORDER_CODE_SPLITS,
            &TYPE_CODE_SPLITS,
            &VALUE_POSITION_CODE_SPLITS,
        ]),
        "the codes of a hidden name and a missing one differ exactly where listed"
    );
    assert_eq!(
        got(Pair::HiddenAccepted),
        listed(&[&ACCEPTED_HIDDEN_SPLITS]),
        "a hidden name compiles where a missing one is refused exactly where listed"
    );
    assert_eq!(
        got(Pair::BothAccepted),
        listed(&[&BOTH_ACCEPTED]),
        "a hidden resource and a missing one both compile exactly where listed"
    );
    assert!(checked >= 438, "{checked}");
}

/// A request over several statements, for one endpoint.
fn compile_statements(statements: &Value, endpoint: &str) -> Value {
    let request = json!({"statements": statements}).to_string();
    serde_json::from_str(&runtime().compile_json(AUTH, &request, endpoint))
        .unwrap_or_else(|_| unreachable!("runtime output is JSON"))
}

const NOT_PERMITTED: &str = "No policy permits this operation, or the resource does not exist.";

/// A resource the role has no policy on and one that does not exist are one answer: the code,
/// the message, the path and the (absent) detail, on Execute and Explain (#145 pull request D).
#[test]
fn a_resource_without_a_policy_is_the_same_answer_as_one_that_does_not_exist() {
    for endpoint in ["execute", "explain"] {
        let answers: Vec<Value> = ["hidden", "no_such_table"]
            .iter()
            .map(|name| {
                let sql = format!("SELECT id FROM {name}");
                compile_with(AUTH, &json!({"sql": sql, "params": {}}), endpoint)
            })
            .collect();
        assert_eq!(answers[0]["error"], answers[1]["error"], "{endpoint}");
        let error = &answers[0]["error"];
        assert_eq!(error["code"], "POLICYSQL_MISSING_POLICY", "{endpoint}");
        assert_eq!(error["message"], NOT_PERMITTED, "{endpoint}");
        assert_eq!(error["path"], "/statements/0", "{endpoint}");
        assert_eq!(detail(&answers[0]), None, "{endpoint}");
    }
}

/// The operation without a policy on a resource the role can use keeps its own reason in the log.
#[test]
fn a_missing_operation_policy_and_a_missing_resource_share_a_code_not_a_reason() {
    let output = compile_params("DELETE FROM tasks WHERE id = :v", &json!({"v": "x"}));
    assert_eq!(code(&output), "POLICYSQL_MISSING_POLICY", "{output}");
    assert_eq!(output["error"]["message"], NOT_PERMITTED);
    assert_eq!(log(&output)["reason"], "policy.MissingPolicy");
    // `tasks` is a resource the role has a policy on: its columns are still checked.
    let output = compile_params("DELETE FROM tasks WHERE nope = :v", &json!({"v": "x"}));
    assert_eq!(code(&output), "POLICYSQL_FORBIDDEN_COLUMN", "{output}");
    let output = compile_params("SELECT nope FROM projects", &json!({}));
    assert_eq!(code(&output), "POLICYSQL_FORBIDDEN_COLUMN", "{output}");
    assert_eq!(log(&output)["reason"], "bind.UnknownColumn");
}

/// The parameter values and the position of the statement in the envelope do not tell a hidden
/// resource from a missing one.
#[test]
fn a_value_and_a_second_statement_do_not_tell_a_hidden_resource_from_a_missing_one() {
    for value in [json!(1), json!("a"), json!(null)] {
        let answers: Vec<Value> = ["hidden", "no_such_table"]
            .iter()
            .map(|name| {
                compile_params(
                    &format!("SELECT id FROM {name} WHERE id = :v"),
                    &json!({"v": value}),
                )
            })
            .collect();
        assert_eq!(answers[0]["error"], answers[1]["error"], "{value}");
        assert_eq!(code(&answers[0]), "POLICYSQL_MISSING_POLICY", "{value}");
    }
    let answers: Vec<Value> = ["hidden", "no_such_table"]
        .iter()
        .map(|name| {
            compile_statements(
                &json!([
                    {"sql": "SELECT id FROM projects", "params": {}},
                    {"sql": format!("SELECT nope FROM {name}"), "params": {}},
                ]),
                "execute",
            )
        })
        .collect();
    assert_eq!(answers[0]["error"], answers[1]["error"]);
    assert_eq!(answers[0]["error"]["path"], "/statements/1");
}

/// A CTE named like a resource the role can use is refused; one named like a resource it cannot
/// use is a name that does not exist, and compiles to the same protected SQL.
#[test]
fn a_cte_named_like_a_hidden_resource_is_accepted_and_one_named_like_a_visible_one_is_not() {
    let output = compile("WITH projects AS (SELECT id FROM tasks) SELECT id FROM projects");
    assert_eq!(code(&output), "POLICYSQL_UNSUPPORTED_SQL", "{output}");
    assert_eq!(detail(&output), Some(&json!({"feature": "cte"})));
    let hidden = compile("WITH hidden AS (SELECT id FROM projects) SELECT id FROM hidden");
    let missing =
        compile("WITH no_such_name AS (SELECT id FROM projects) SELECT id FROM no_such_name");
    assert!(hidden.get("error").is_none(), "{hidden}");
    assert_eq!(hidden["statements"], missing["statements"]);
    let protected = hidden["statements"][0]["protectedSql"]
        .as_str()
        .unwrap_or_else(|| unreachable!("a compiled statement has protected SQL: {hidden}"));
    assert!(!protected.contains("hidden"), "{protected}");
    assert!(!protected.contains("WITH"), "{protected}");
}

/// Every refusal the compiler can produce, as a production site builds it, has the detail its
/// code requires. The match functions fail to compile when a variant is added, so a new one has to
/// be placed here.
#[test]
#[allow(clippy::too_many_lines)]
fn every_production_refusal_carries_the_detail_its_code_requires() {
    use policysql_execution::{ComplexityCause, VerificationError};
    use policysql_gateway::{classify_bind_error, compile_failure, policy_rejection};
    use policysql_parser::{BindError, UnsupportedFeature};
    use policysql_policy::PolicyError;
    use policysql_sqlite::{CompileError, EmitError};

    const fn covered_bind(error: &BindError) {
        match error {
            BindError::Empty
            | BindError::InvalidSql(_)
            | BindError::MultipleStatements
            | BindError::Unsupported(..)
            | BindError::MissingFrom
            | BindError::UnknownResource
            | BindError::UnknownColumn
            | BindError::AmbiguousColumn
            | BindError::DuplicateAlias
            | BindError::ImplicitRowId
            | BindError::ProjectionLimit
            | BindError::JoinLimit
            | BindError::ParameterLimit
            | BindError::ExpressionDepth
            | BindError::PositionalParameter
            | BindError::UnsupportedParameterPrefix
            | BindError::InvalidParameterName
            | BindError::ReservedParameterNamespace
            | BindError::UnprovableParameterType
            | BindError::IncompatibleTypes
            | BindError::InvalidLiteral
            | BindError::NullComparison
            | BindError::InvalidLimit
            | BindError::InvalidResultName
            | BindError::DuplicateResultName
            | BindError::DuplicateWriteColumn
            | BindError::InsertArity => {}
        }
    }
    const fn covered_policy(error: &PolicyError) {
        match error {
            PolicyError::InvalidBundle
            | PolicyError::InvalidRole
            | PolicyError::UnknownResource
            | PolicyError::UnknownColumn
            | PolicyError::UnknownOperator
            | PolicyError::InvalidPredicate
            | PolicyError::IncompatibleOperand
            | PolicyError::BytesPresetTooLarge
            | PolicyError::NullComparison
            | PolicyError::UnsupportedCapability
            | PolicyError::UnsupportedRedaction
            | PolicyError::DuplicateColumnPermission
            | PolicyError::PresetColumnOverlap
            | PolicyError::DuplicatePolicy
            | PolicyError::TooManyPolicies
            | PolicyError::MissingPolicy
            | PolicyError::ForbiddenColumn
            | PolicyError::ForbiddenColumnContext
            | PolicyError::MissingSessionValue
            | PolicyError::InvalidSessionKey
            | PolicyError::InvariantViolation(_) => {}
        }
    }
    const fn covered_emit(error: &EmitError) {
        match error {
            EmitError::UnsupportedStatement
            | EmitError::UnknownResource
            | EmitError::UnknownColumn
            | EmitError::MissingServerParameter(_)
            | EmitError::LiteralRequiresParameter
            | EmitError::UnsupportedValue
            | EmitError::TooManyLiterals
            | EmitError::Formatting
            | EmitError::InvariantViolation(_)
            | EmitError::TooComplex(_)
            | EmitError::ReparseFailed => {}
        }
    }
    const fn covered_verification(error: &VerificationError) {
        match error {
            VerificationError::EmptyProtectedSql
            | VerificationError::ProfileMismatch
            | VerificationError::InvariantViolation(_) => {}
        }
    }

    let mut binds = vec![
        BindError::Empty,
        BindError::InvalidSql(None),
        BindError::InvalidSql(Some(policysql_parser::SourceSpan { start: 1, end: 3 })),
        BindError::MultipleStatements,
        BindError::MissingFrom,
        BindError::UnknownResource,
        BindError::UnknownColumn,
        BindError::AmbiguousColumn,
        BindError::DuplicateAlias,
        BindError::ImplicitRowId,
        BindError::ProjectionLimit,
        BindError::JoinLimit,
        BindError::ParameterLimit,
        BindError::ExpressionDepth,
        BindError::PositionalParameter,
        BindError::UnsupportedParameterPrefix,
        BindError::InvalidParameterName,
        BindError::ReservedParameterNamespace,
        BindError::UnprovableParameterType,
        BindError::IncompatibleTypes,
        BindError::InvalidLiteral,
        BindError::NullComparison,
        BindError::InvalidLimit,
        BindError::InvalidResultName,
        BindError::DuplicateResultName,
        BindError::DuplicateWriteColumn,
        BindError::InsertArity,
    ];
    binds.extend(UnsupportedFeature::ALL.map(|feature| BindError::Unsupported(feature, "shape")));
    let policies = [
        PolicyError::InvalidBundle,
        PolicyError::InvalidRole,
        PolicyError::UnknownResource,
        PolicyError::UnknownColumn,
        PolicyError::UnknownOperator,
        PolicyError::InvalidPredicate,
        PolicyError::IncompatibleOperand,
        PolicyError::BytesPresetTooLarge,
        PolicyError::NullComparison,
        PolicyError::UnsupportedCapability,
        PolicyError::UnsupportedRedaction,
        PolicyError::DuplicateColumnPermission,
        PolicyError::PresetColumnOverlap,
        PolicyError::DuplicatePolicy,
        PolicyError::TooManyPolicies,
        PolicyError::MissingPolicy,
        PolicyError::ForbiddenColumn,
        PolicyError::ForbiddenColumnContext,
        PolicyError::MissingSessionValue,
        PolicyError::InvalidSessionKey,
        PolicyError::InvariantViolation("x".to_owned()),
    ];
    let emits = [
        EmitError::UnsupportedStatement,
        EmitError::UnknownResource,
        EmitError::UnknownColumn,
        EmitError::MissingServerParameter("x".to_owned()),
        EmitError::LiteralRequiresParameter,
        EmitError::UnsupportedValue,
        EmitError::TooManyLiterals,
        EmitError::Formatting,
        EmitError::InvariantViolation("x".to_owned()),
        EmitError::TooComplex(ComplexityCause::Height),
        EmitError::ReparseFailed,
    ];
    let verifications = [
        VerificationError::EmptyProtectedSql,
        VerificationError::ProfileMismatch,
        VerificationError::InvariantViolation("x".to_owned()),
    ];
    for error in &binds {
        covered_bind(error);
    }
    for error in &policies {
        covered_policy(error);
    }
    for error in &emits {
        covered_emit(error);
    }
    for error in &verifications {
        covered_verification(error);
    }

    let mut answers: Vec<(String, super::RuntimeError)> = Vec::new();
    for error in &binds {
        answers.push((
            format!("{error:?}"),
            super::RuntimeError::RejectedAt(classify_bind_error(error), 0),
        ));
    }
    for error in &policies {
        answers.push((
            format!("{error:?}"),
            super::RuntimeError::RejectedAt(policy_rejection(error), 0),
        ));
    }
    let mut compiles = vec![
        CompileError::ClientParameterMismatch,
        CompileError::ClientParameterTypeMismatch,
    ];
    compiles.extend(emits.into_iter().map(CompileError::Emit));
    compiles.extend(verifications.into_iter().map(CompileError::Verification));
    for error in &compiles {
        answers.push((
            format!("{error:?}"),
            super::runtime_gateway_error(compile_failure(error, 0)),
        ));
    }
    assert!(answers.len() > 80, "{}", answers.len());
    for (label, answer) in answers {
        let body = super::error_body(answer);
        let found = body
            .detail
            .as_ref()
            .map(|detail| serde_json::to_value(detail).unwrap_or_default());
        assert!(
            ErrorDetail::allowed(body.code, found.as_ref()),
            "{label}: {} {found:?}",
            body.code
        );
    }
}

/// The enumerations of the public detail table are the Rust types', variant for variant.
#[test]
fn the_detail_enumerations_are_the_rust_types_and_core_keeps_them() {
    use policysql_execution::ComplexityCause;
    use policysql_gateway::ParameterReason;
    use policysql_parser::UnsupportedFeature;
    use policysql_transaction::machine::io::{
        COMPLEXITY_CAUSES, COMPLEXITY_DETAILS, EXPECTATIONS, PARAMETER_REASONS,
        UNSUPPORTED_FEATURES,
    };

    assert_eq!(
        UnsupportedFeature::ALL.map(UnsupportedFeature::name),
        UNSUPPORTED_FEATURES
    );
    assert_eq!(
        ParameterReason::ALL.map(ParameterReason::name),
        PARAMETER_REASONS
    );
    assert_eq!(
        policysql_core::ExpectationKind::ALL.map(policysql_core::ExpectationKind::name),
        EXPECTATIONS
    );
    // The complexity values are the compile causes, the database's, and `database`, in this
    // order, and nothing else.
    let expected: Vec<&str> = ComplexityCause::ALL
        .map(ComplexityCause::name)
        .into_iter()
        .chain(COMPLEXITY_CAUSES)
        .chain(["database"])
        .collect();
    let mut sorted = expected.clone();
    sorted.sort_unstable();
    let mut listed = COMPLEXITY_DETAILS.to_vec();
    listed.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted, listed);
}
