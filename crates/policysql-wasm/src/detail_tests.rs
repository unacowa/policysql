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
    serde_json::from_str(&runtime().compile_json(auth, &request, endpoint, crate::TEST_CONTEXT))
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
    for (sql, expected) in [
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
        assert_eq!(record["abiVersion"], 26, "{sql}");
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
    let output: Value = serde_json::from_str(&runtime().compile_json(
        AUTH,
        &request,
        "execute",
        crate::TEST_CONTEXT,
    ))
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
    // Different codes: the binder resolves a hidden name and goes on to refuse a later part of the
    // statement for a reason of its own (an unsupported form), while a missing name stops at the
    // name. The value positions are decided on their syntax first (#155), but a name anywhere else
    // is resolved in the binder's walk order; the root fix is #154.
    const LATER_REFUSAL_CODE_SPLITS: [&str; 3] = [
        "SELECT {C} FROM projects WHERE id = 1 + 1",
        "UPDATE projects SET {C} = :v WHERE id = 1 + 1",
        "UPDATE projects SET {C} = lower(:v) WHERE id = :id",
    ];
    // The hidden name compiles and the missing one is refused: a column that a derived table
    // or a CTE carries but the outer statement does not use is not checked (#141).
    const ACCEPTED_HIDDEN_SPLITS: [&str; 2] = [
        "WITH c AS (SELECT id, {C} FROM projects) SELECT id FROM c",
        "SELECT d.id FROM (SELECT id, {C} FROM projects) AS d",
    ];
    // A hidden column of another type is run with the templates that do not themselves ask for a
    // type (a value or a function argument), so that what differs is the name and not a
    // parameter value of the wrong type; the literal comparisons are the type probes. The value
    // positions are refused on their syntax before a type is looked at, so they are here too.
    const TYPED_TEMPLATES: [&str; 29] = [
        "SELECT {C} FROM projects",
        "SELECT projects.{C} FROM projects",
        "INSERT INTO projects (id, name) VALUES (:id, {C})",
        "INSERT INTO projects (id, name) VALUES (:id, :n), (:id2, {C})",
        "SELECT id FROM projects LIMIT {C}",
        "SELECT id FROM projects LIMIT 1 OFFSET {C}",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.id, {C}) AS j",
        "UPDATE projects SET name = {C} WHERE id = :id",
        "UPDATE projects SET name = lower({C}) WHERE id = :id",
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
        "INSERT INTO projects (id, name) VALUES (:id, lower({C}))",
        "INSERT INTO projects (id, name) VALUES (:id, :n), (:id2, {C})",
        "SELECT id FROM projects LIMIT {C}",
        "SELECT id FROM projects LIMIT 1 OFFSET {C}",
        "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.id, {C}) AS j",
        "INSERT INTO projects (id, name) VALUES (:id, :n) RETURNING {C}",
        "UPDATE projects SET {C} = :v WHERE id = :id",
        "UPDATE projects SET {C} = :v WHERE id = 1 + 1",
        "UPDATE projects SET {C} = lower(:v) WHERE id = :id",
        "SELECT {C} FROM projects WHERE id = 1 + 1",
        "UPDATE projects SET name = {C} WHERE id = :id",
        "UPDATE projects SET name = lower({C}) WHERE id = :id",
        "UPDATE projects SET name = CASE WHEN {C} = :v THEN :a ELSE :b END WHERE id = :id",
        "UPDATE projects SET name = ({C}) WHERE id = :id",
        "UPDATE projects SET name = \"{C}\" WHERE id = :id",
        "UPDATE projects SET count = {C} + 1 WHERE id = :id",
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
            &LATER_REFUSAL_CODE_SPLITS,
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
    assert!(checked >= 520, "{checked}");
}

/// A request over several statements, for one endpoint.
fn compile_statements(statements: &Value, endpoint: &str) -> Value {
    let request = json!({"statements": statements}).to_string();
    serde_json::from_str(&runtime().compile_json(AUTH, &request, endpoint, crate::TEST_CONTEXT))
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
        COMPLEXITY_CAUSES, COMPLEXITY_DETAILS, EXCEEDED_LIMITS, EXPECTATIONS, PARAMETER_REASONS,
        REQUEST_LIMITS, ResultLimitName, TRANSACTION_LIMITS, TransactionLimitName,
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
    // The limit names are the Rust types', and every one is in the list of its code. The three
    // lists hold no other name.
    let named: BTreeSet<&str> = policysql_core::LimitName::ALL
        .map(policysql_core::LimitName::name)
        .into_iter()
        .chain(ResultLimitName::ALL.map(ResultLimitName::name))
        .collect();
    let listed_names: BTreeSet<&str> = EXCEEDED_LIMITS.into_iter().chain(REQUEST_LIMITS).collect();
    assert_eq!(named, listed_names);
    assert_eq!(
        TransactionLimitName::ALL.map(TransactionLimitName::name),
        TRANSACTION_LIMITS
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

// ---------------------------------------------------------------------------------------------
// `detail.limit` of the three limit codes (#145 pull request F)
// ---------------------------------------------------------------------------------------------

/// The limits are small so that each is crossed by a short statement; the ones a test does not
/// name keep the defaults.
const SMALL_LIMITS: &str = r#"{"max_rows":2,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":2,"max_parameters":2,"max_joins":1,"max_projections":2,"max_expression_depth":4,"max_sql_bytes":1024}"#;

fn runtime_with(limits: &str) -> super::PolicySqlRuntime {
    super::PolicySqlRuntime::new(CATALOG, POLICY, "schema_detail", "policy_detail", limits)
        .unwrap_or_else(|_| unreachable!("valid runtime"))
}

fn compile_on(runtime: &super::PolicySqlRuntime, statements: &Value, endpoint: &str) -> Value {
    let request = json!({"statements": statements}).to_string();
    serde_json::from_str(&runtime.compile_json(AUTH, &request, endpoint, crate::TEST_CONTEXT))
        .unwrap_or_else(|_| unreachable!("runtime output is JSON"))
}

/// One statement with every `:name` parameter given a string value.
fn one(sql: &str) -> Value {
    json!([{"sql": sql, "params": parameters(sql)}])
}

fn limit_of(output: &Value) -> Option<&str> {
    detail(output)?["limit"].as_str()
}

/// A case of the test below: the name, the statements, the code, the path, the limit, and the log
/// reason (empty when there is none to check).
type CompileLimitCase = (
    &'static str,
    Value,
    &'static str,
    Option<&'static str>,
    &'static str,
    &'static str,
);

/// Each limit the compile checks names itself, on Execute and Explain, with the code, path and
/// log reason it had before the detail.
#[test]
fn a_compile_limit_names_the_configured_limit() {
    let small = runtime_with(SMALL_LIMITS);
    let long_sql = format!(
        "SELECT id FROM projects WHERE name = '{}'",
        "a".repeat(1_100)
    );
    let cases: Vec<CompileLimitCase> = vec![
        (
            "statements",
            json!([
                {"sql": "SELECT id FROM projects", "params": {}},
                {"sql": "SELECT id FROM projects", "params": {}},
                {"sql": "SELECT id FROM projects", "params": {}},
            ]),
            "POLICYSQL_LIMIT_EXCEEDED",
            None,
            "maxStatements",
            "request.StatementLimit",
        ),
        (
            "sql bytes",
            json!([{"sql": long_sql, "params": {}}]),
            "POLICYSQL_REQUEST_TOO_LARGE",
            Some("/statements/0/sql"),
            "maxSqlBytes",
            "",
        ),
        (
            "sql bytes of the second statement",
            json!([
                {"sql": "SELECT id FROM projects", "params": {}},
                {"sql": long_sql, "params": {}},
            ]),
            "POLICYSQL_REQUEST_TOO_LARGE",
            Some("/statements/1/sql"),
            "maxSqlBytes",
            "",
        ),
        (
            "projections",
            one("SELECT id, name, status FROM projects"),
            "POLICYSQL_LIMIT_EXCEEDED",
            Some("/statements/0"),
            "maxProjections",
            "bind.ProjectionLimit",
        ),
        (
            "joins",
            one(
                "SELECT p.id FROM projects p JOIN tasks t ON t.project_id = p.id JOIN tasks u ON u.project_id = p.id",
            ),
            "POLICYSQL_LIMIT_EXCEEDED",
            Some("/statements/0"),
            "maxJoins",
            "bind.JoinLimit",
        ),
        (
            "parameters",
            one("SELECT id FROM projects WHERE id = :a OR id = :b OR id = :c"),
            "POLICYSQL_LIMIT_EXCEEDED",
            Some("/statements/0"),
            "maxParameters",
            "bind.ParameterLimit",
        ),
        (
            "expression depth",
            one("SELECT id FROM projects WHERE ((((( id IS NULL)))))"),
            "POLICYSQL_LIMIT_EXCEEDED",
            Some("/statements/0"),
            "maxExpressionDepth",
            "bind.ExpressionDepth",
        ),
    ];
    for (name, statements, expected_code, path, limit, reason) in cases {
        let mut answers = Vec::new();
        for endpoint in ["execute", "explain"] {
            let output = compile_on(&small, &statements, endpoint);
            assert_eq!(code(&output), expected_code, "{name} {endpoint}: {output}");
            assert_eq!(
                output["error"]["path"],
                path.map_or(Value::Null, |path| json!(path)),
                "{name} {endpoint}"
            );
            assert_eq!(detail(&output), Some(&json!({"limit": limit})), "{name}");
            if !reason.is_empty() {
                assert_eq!(log(&output)["reason"], reason, "{name} {endpoint}");
            }
            answers.push(output["error"].clone());
        }
        assert_eq!(answers[0], answers[1], "{name}: Execute and Explain agree");
    }
}

/// A bytes parameter over `maxBytesPerValue` names it.
#[test]
fn a_bytes_parameter_over_the_value_limit_names_it() {
    let runtime = runtime_with(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":2,"max_bytes_per_value":3}"#,
    );
    let statements = json!([{
        "sql": "SELECT id FROM projects WHERE payload = :p",
        "params": {"p": "AAAAAA=="},
    }]);
    let output = compile_on(&runtime, &statements, "execute");
    assert_eq!(code(&output), "POLICYSQL_LIMIT_EXCEEDED", "{output}");
    assert_eq!(limit_of(&output), Some("maxBytesPerValue"), "{output}");
    // Three bytes are within the limit.
    let statements = json!([{
        "sql": "SELECT id FROM projects WHERE payload = :p",
        "params": {"p": "AAAA"},
    }]);
    assert!(
        compile_on(&runtime, &statements, "execute")
            .get("error")
            .is_none()
    );
}

/// What carries no `detail.limit` is pinned, so that a later change names it on purpose: the
/// derived compile input.
/// An empty statement is `INVALID_SQL`, not `INVALID_REQUEST`, so the envelope check on an empty
/// SQL (`EnvelopeAt`) is not reachable from a client.
#[test]
fn a_bound_without_a_capabilities_key_carries_no_limit() {
    let small = runtime_with(
        r#"{"max_rows":2,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":2,"max_request_bytes":65536}"#,
    );
    // A SELECT without a result column is not a projection limit: the parser refuses it.
    let output = compile_on(&small, &one("SELECT FROM projects"), "execute");
    assert_eq!(code(&output), "POLICYSQL_INVALID_SQL", "{output}");
    // A blank statement is an invalid SQL, never an invalid request.
    for sql in ["", "   ", "\n\t"] {
        let output = compile_on(&small, &one(sql), "execute");
        assert_eq!(code(&output), "POLICYSQL_INVALID_SQL", "{sql:?}: {output}");
    }
    // The compile input bound is derived from `max_request_bytes` (65,536 at the smallest).
    let request = format!(
        r#"{{"statements":[{{"sql":"SELECT id FROM projects","params":{{}}}}],"pad":"{}"}}"#,
        "x".repeat(200_000)
    );
    let output: Value =
        serde_json::from_str(&small.compile_json(AUTH, &request, "execute", crate::TEST_CONTEXT))
            .unwrap_or_default();
    assert_eq!(code(&output), "POLICYSQL_REQUEST_TOO_LARGE", "{output}");
    assert_eq!(output["error"]["path"], Value::Null);
    assert_eq!(detail(&output), None);
}

/// A `LIMIT` / `OFFSET` is a non-negative integer, as a literal and as a parameter value (#136):
/// anything else is the answer of a parameter value that breaks its contract, and a form that is
/// neither a literal nor a parameter is unsupported, refused without resolving a name in it.
#[test]
fn a_limit_or_offset_that_is_not_a_non_negative_integer_is_an_invalid_parameter() {
    for sql in [
        "SELECT id FROM projects LIMIT -1",
        "SELECT id FROM projects LIMIT 1 OFFSET -1",
        "SELECT id FROM projects LIMIT 5, -1",
        "SELECT id FROM projects LIMIT 'x'",
        "SELECT id FROM projects LIMIT 1.5",
        "SELECT id FROM projects LIMIT NULL",
    ] {
        let output = compile(sql);
        assert_eq!(
            code(&output),
            "POLICYSQL_INVALID_PARAMETER",
            "{sql}: {output}"
        );
        assert_eq!(detail(&output), Some(&json!({"reason": "value"})), "{sql}");
        assert_eq!(log(&output)["reason"], "bind.InvalidLimit", "{sql}");
        assert_eq!(output["error"]["path"], "/statements/0", "{sql}");
    }
    for (sql, params) in [
        ("SELECT id FROM projects LIMIT :n", json!({"n": -1})),
        (
            "SELECT id FROM projects LIMIT :n",
            json!({"n": -9_223_372_036_854_775_808_i64}),
        ),
        (
            "SELECT id FROM projects LIMIT 5 OFFSET :o",
            json!({"o": -1}),
        ),
        (
            "SELECT id FROM projects LIMIT :n OFFSET :n",
            json!({"n": -1}),
        ),
    ] {
        let output = compile_params(sql, &params);
        assert_eq!(
            code(&output),
            "POLICYSQL_INVALID_PARAMETER",
            "{sql} {params}: {output}"
        );
        assert_eq!(detail(&output), Some(&json!({"reason": "value"})));
        assert_eq!(
            log(&output)["reason"],
            "compile.ClientParameterTypeMismatch",
            "{sql} {params}"
        );
        let text = output.to_string();
        assert!(!text.contains("\"n\"") && !text.contains("-1"), "{text}");
    }
    for sql in [
        "SELECT id FROM projects LIMIT id",
        "SELECT id FROM projects LIMIT private_note",
        "SELECT id FROM projects LIMIT nope",
        "SELECT id FROM projects LIMIT (5)",
        "SELECT id FROM projects LIMIT 1 + 1",
    ] {
        let output = compile(sql);
        assert_eq!(
            code(&output),
            "POLICYSQL_UNSUPPORTED_SQL",
            "{sql}: {output}"
        );
        assert_eq!(
            detail(&output),
            Some(&json!({"feature": "expression"})),
            "{sql}"
        );
    }
    assert_eq!(
        compile("SELECT id FROM projects LIMIT private_note")["error"],
        compile("SELECT id FROM projects LIMIT nope")["error"]
    );
    for value in [0, 5, 1000] {
        let output = compile_params("SELECT id FROM projects LIMIT :n", &json!({"n": value}));
        assert!(output.get("error").is_none(), "{value}: {output}");
        assert!(
            output.to_string().contains("LIMIT MIN (:n, 100)"),
            "{value}: {output}"
        );
    }
    let explain = compile_with(
        AUTH,
        &json!({"sql": "SELECT id FROM projects LIMIT :n", "params": {}}),
        "explain",
    );
    assert!(explain.get("error").is_none(), "{explain}");
}

/// A body over `maxRequestBytes` or `maxJsonValues` names it, through both body checks; the other
/// refusals of a body carry no detail.
#[test]
fn a_body_limit_names_the_configured_limit() {
    // The smallest request limits, so that a short body crosses them.
    let runtime = runtime_with(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":2,"max_request_bytes":65536,"max_json_values":1024}"#,
    );
    let big = format!(r#"{{"mode":"read","pad":"{}"}}"#, "x".repeat(70_000));
    let many = format!("[{}]", vec!["0"; 1_100].join(","));
    for (body, expected_code, expected) in [
        (
            big.as_str(),
            "POLICYSQL_REQUEST_TOO_LARGE",
            Some("maxRequestBytes"),
        ),
        (
            many.as_str(),
            "POLICYSQL_REQUEST_TOO_LARGE",
            Some("maxJsonValues"),
        ),
        ("{", "POLICYSQL_INVALID_REQUEST", None),
        (r#"{"a":1,"a":2}"#, "POLICYSQL_INVALID_REQUEST", None),
    ] {
        for output in [runtime.check_body_json(body), runtime.begin_body_json(body)] {
            let output: Value = serde_json::from_str(&output).unwrap_or_default();
            assert_eq!(code(&output), expected_code, "{output}");
            assert_eq!(
                detail(&output),
                expected.map(|limit| json!({"limit": limit})).as_ref(),
                "{output}"
            );
        }
    }
    // A begin body of the wrong shape is an invalid request without a detail.
    let output: Value = serde_json::from_str(&runtime.begin_body_json("[]")).unwrap_or_default();
    assert_eq!(code(&output), "POLICYSQL_INVALID_REQUEST", "{output}");
    assert_eq!(detail(&output), None);
    // The depth limit is another code and carries nothing.
    let deep = format!("{}1{}", "[".repeat(200), "]".repeat(200));
    let output: Value = serde_json::from_str(&runtime.check_body_json(&deep)).unwrap_or_default();
    assert_eq!(code(&output), "POLICYSQL_JSON_TOO_DEEP", "{output}");
    assert_eq!(detail(&output), None);
}

/// A result the runtime refuses names the limit it crossed, except the raw bound, which is
/// derived from several limits.
#[test]
fn a_result_limit_names_the_configured_limit() {
    let validate = |runtime: &super::PolicySqlRuntime, sql: &str, raw: &str| -> Value {
        let compiled = compile_on(runtime, &one(sql), "execute");
        let handle = compiled["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("{sql}: {compiled}"));
        let output: Value =
            serde_json::from_str(&runtime.validate_result_json(handle, 0, raw)).unwrap_or_default();
        runtime.release_execution(handle);
        output
    };
    let rows = |count: usize, cell: &str| {
        json!({
            "columns": ["id", "name"],
            "rows": vec![vec![cell, cell]; count],
            "affectedRows": 0,
        })
        .to_string()
    };
    // Rows: `max_rows` is 2.
    let small = runtime_with(SMALL_LIMITS);
    let sql = "SELECT id, name FROM projects";
    assert!(validate(&small, sql, &rows(2, "a")).get("error").is_none());
    let output = validate(&small, sql, &rows(3, "a"));
    assert_eq!(code(&output), "POLICYSQL_LIMIT_EXCEEDED", "{output}");
    assert_eq!(limit_of(&output), Some("maxRows"), "{output}");
    // Bytes: `max_result_bytes` is 10, and a row of two 6-byte cells crosses it.
    let bytes = runtime_with(
        r#"{"max_rows":100,"max_result_bytes":10,"timeout_ms":1000,"max_statements":2}"#,
    );
    let output = validate(&bytes, sql, &rows(1, "aaaaaa"));
    assert_eq!(code(&output), "POLICYSQL_LIMIT_EXCEEDED", "{output}");
    assert_eq!(limit_of(&output), Some("maxResultBytes"), "{output}");
    // Values: 1,024 is the smallest `max_json_values`; 600 rows of two cells are 1,202 values.
    let values = runtime_with(
        r#"{"max_rows":1000,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":2,"max_json_values":1024}"#,
    );
    let output = validate(&values, sql, &rows(600, "a"));
    assert_eq!(code(&output), "POLICYSQL_LIMIT_EXCEEDED", "{output}");
    assert_eq!(limit_of(&output), Some("maxJsonValues"), "{output}");
    // A BLOB cell over `max_bytes_per_value`.
    let blobs = runtime_with(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":2,"max_bytes_per_value":3}"#,
    );
    let raw = json!({
        "columns": ["payload"],
        "rows": [[{"type": "blob", "base64": "AAAAAA=="}]],
        "affectedRows": 0,
    })
    .to_string();
    let output = validate(&blobs, "SELECT payload FROM projects", &raw);
    assert_eq!(code(&output), "POLICYSQL_LIMIT_EXCEEDED", "{output}");
    assert_eq!(limit_of(&output), Some("maxBytesPerValue"), "{output}");
    // The raw text over its derived bound has no name: it is a sum of several limits.
    let junk = "x".repeat(2_000_000);
    let output = validate(&small, sql, &junk);
    assert_eq!(code(&output), "POLICYSQL_LIMIT_EXCEEDED", "{output}");
    assert_eq!(detail(&output), None, "{output}");
    assert_eq!(output["error"].get("detail"), None);
}

/// The limits' numbers never reach the answer: it holds the name and nothing else.
#[test]
fn a_limit_answer_holds_the_name_and_not_the_configured_number() {
    let runtime = runtime_with(
        r#"{"max_rows":7,"max_result_bytes":7777,"timeout_ms":1000,"max_statements":2,"max_sql_bytes":1777,"max_joins":1}"#,
    );
    let long_sql = format!(
        "SELECT id FROM projects WHERE name = '{}'",
        "a".repeat(1_800)
    );
    for statements in [
        one(
            "SELECT p.id FROM projects p JOIN tasks t ON t.project_id = p.id JOIN tasks u ON u.project_id = p.id",
        ),
        json!([{"sql": long_sql, "params": {}}]),
    ] {
        let output = compile_on(&runtime, &statements, "execute");
        let error = output["error"].as_object().cloned().unwrap_or_default();
        assert_eq!(
            error["detail"].as_object().map(serde_json::Map::len),
            Some(1)
        );
        let text = output["error"].to_string();
        for number in ["7777", "1777", "limits", "transactions"] {
            assert!(!text.contains(number), "{number}: {text}");
        }
    }
}

/// A client's own words never become the name: a parameter, a comment and a column alias that
/// spell a limit leave the name to the place that checked.
#[test]
fn a_client_string_does_not_choose_the_limit_name() {
    let small = runtime_with(SMALL_LIMITS);
    let output = compile_on(
        &small,
        &json!([{
            "sql": "SELECT id FROM projects /* maxSqlBytes */ WHERE id = :max_rows OR id = :b OR id = :c",
            "params": {"max_rows": "x", "b": "x", "c": "x"},
        }]),
        "execute",
    );
    assert_eq!(code(&output), "POLICYSQL_LIMIT_EXCEEDED", "{output}");
    assert_eq!(limit_of(&output), Some("maxParameters"), "{output}");
    let output = compile_on(
        &small,
        &one("SELECT id AS maxRows, name AS maxJoins, status AS max_rows FROM projects"),
        "execute",
    );
    assert_eq!(limit_of(&output), Some("maxProjections"), "{output}");
}

/// A binder limit and the column resolution: where a hidden column and a missing one are answered
/// with the same code, the answers are the same (`detail.limit` included); a template whose codes
/// differ is listed with the reason. The binder walks in a fixed order and stops at the first
/// failure, so a limit reached before the column is resolved is the same limit for both.
#[test]
fn a_limit_is_the_same_answer_for_a_hidden_column_and_a_missing_one() {
    // Different codes: the binder walks the statement in order and stops at the first failure. A
    // hidden column resolves (the role's Binding Catalog has it), so the walk goes on to the third
    // parameter and stops at `maxParameters`; a missing column stops the walk where it is named,
    // as `FORBIDDEN_COLUMN`, before the third parameter. The codes already differed before
    // `detail` (#154), and `limit` adds no fact the code did not give: where both answers have
    // the same code they are the same answer, `limit` included.
    // The same holds for an expression deeper than `maxExpressionDepth` that comes after the
    // column. Two more kinds of the same split (a decoded value over `maxBytesPerValue`, and a
    // second statement over a binder limit) have parameters or statements of their own and are
    // in `a_limit_after_the_column_is_a_code_split_and_nothing_more`.
    const LIMIT_ORDER_CODE_SPLITS: [&str; 3] = [
        "SELECT id FROM projects WHERE {C} = :a OR id = :b OR id = :c",
        "SELECT id FROM projects WHERE {C} IS NULL AND (((((id IS NULL)))))",
        "UPDATE projects SET name = :a WHERE {C} = :b OR id = :c",
    ];
    let small = runtime_with(SMALL_LIMITS);
    let column_templates = [
        "SELECT id, name, {C} FROM projects",
        "SELECT {C} FROM projects p JOIN tasks t ON t.project_id = p.id JOIN tasks u ON u.project_id = p.id",
        "SELECT id FROM projects WHERE {C} = :a OR id = :b OR id = :c",
        "SELECT id FROM projects WHERE ((((( {C} IS NULL)))))",
        "SELECT id FROM projects WHERE {C} IS NULL AND (((((id IS NULL)))))",
        "SELECT id FROM projects WHERE id = :a OR (id = :b OR (id = :c OR {C} IS NULL))",
        "UPDATE projects SET name = :a WHERE {C} = :b OR id = :c",
    ];
    let resource_templates = [
        "SELECT id, name, status FROM {R}",
        "SELECT p.id FROM projects p JOIN {R} r ON r.id = p.id JOIN tasks t ON t.project_id = p.id JOIN tasks u ON u.project_id = p.id",
    ];
    let answer = |sql: &str, endpoint: &str| {
        let params = if endpoint == "execute" {
            parameters(sql)
        } else {
            json!({})
        };
        compile_on(&small, &json!([{"sql": sql, "params": params}]), endpoint)
    };
    let mut splits: BTreeSet<&str> = BTreeSet::new();
    let mut limited = 0;
    let mut cases: Vec<(&str, String, String)> = Vec::new();
    for template in column_templates {
        for hidden in ["private_note", "private_int", "private_bytes"] {
            cases.push((
                template,
                template.replace("{C}", hidden),
                template.replace("{C}", "no_such_column"),
            ));
        }
    }
    for template in resource_templates {
        for (hidden, missing) in [("hidden", "no_such_table"), ("HIDDEN", "NO_SUCH_TABLE")] {
            cases.push((
                template,
                template.replace("{R}", hidden),
                template.replace("{R}", missing),
            ));
        }
    }
    for (template, hidden, missing) in cases {
        for endpoint in ["execute", "explain"] {
            let (seen, absent) = (answer(&hidden, endpoint), answer(&missing, endpoint));
            if code(&seen) != code(&absent) {
                splits.insert(template);
                continue;
            }
            assert_eq!(
                seen["error"], absent["error"],
                "{endpoint} {hidden} / {missing}"
            );
            if limit_of(&seen).is_some() {
                limited += 1;
            }
        }
    }
    assert_eq!(splits, BTreeSet::from(LIMIT_ORDER_CODE_SPLITS));
    assert!(limited >= 10, "{limited} answers named a limit");
}

/// The other ways a limit comes after a column in the binder's walk. Each is a split of the code
/// that the binder's order already made (a hidden column is reached and the walk goes on; a missing
/// one stops it), never a split of `limit` under one code: both answers of every pair below are
/// listed, so a change that closes the split (or opens another) fails here.
#[test]
fn a_limit_after_the_column_is_a_code_split_and_nothing_more() {
    let bytes = runtime_with(
        r#"{"max_rows":2,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":2,"max_projections":2,"max_bytes_per_value":3}"#,
    );
    let small = runtime_with(SMALL_LIMITS);
    let code_and_limit = |output: &Value| {
        (
            code(output).to_owned(),
            output["error"]["path"].clone(),
            limit_of(output).map(str::to_owned),
        )
    };
    // A decoded value over `maxBytesPerValue` (after the bind, before the policy), whichever
    // column comes first; and a second statement over a binder limit, whose path is its own.
    for hidden in ["private_note", "private_int", "private_bytes"] {
        let sql = format!("SELECT id FROM projects WHERE {hidden} = :a AND payload = :b");
        let params = json!({"a": "AAAAAA==", "b": "AAAAAA=="});
        let statements = json!([{"sql": sql, "params": params}]);
        let missing = json!([{
            "sql": "SELECT id FROM projects WHERE no_such_column = :a AND payload = :b",
            "params": params,
        }]);
        // Execute only: Explain takes no parameter values, so it never decodes one.
        let seen = compile_on(&bytes, &statements, "execute");
        let absent = compile_on(&bytes, &missing, "execute");
        assert_eq!(
            code_and_limit(&seen),
            (
                "POLICYSQL_LIMIT_EXCEEDED".to_owned(),
                json!("/statements/0"),
                Some("maxBytesPerValue".to_owned())
            ),
            "{hidden}: {seen}"
        );
        assert_eq!(
            code(&absent),
            "POLICYSQL_FORBIDDEN_COLUMN",
            "a missing column stops the walk first: {absent}"
        );
    }
    for hidden_or_missing in ["private_note", "no_such_column"] {
        let statements = json!([
            {"sql": format!("SELECT {hidden_or_missing} FROM projects"), "params": {}},
            {"sql": "SELECT id, name, status FROM projects", "params": {}},
        ]);
        let output = compile_on(&small, &statements, "execute");
        let expected = if hidden_or_missing == "private_note" {
            // A hidden column is refused by the policy only after every statement is bound, so the
            // second statement's binder limit comes first.
            (
                "POLICYSQL_LIMIT_EXCEEDED",
                "/statements/1",
                Some("maxProjections"),
            )
        } else {
            ("POLICYSQL_FORBIDDEN_COLUMN", "/statements/0", None)
        };
        assert_eq!(
            code_and_limit(&output),
            (
                expected.0.to_owned(),
                json!(expected.1),
                expected.2.map(str::to_owned)
            ),
            "{hidden_or_missing}: {output}"
        );
    }
}
