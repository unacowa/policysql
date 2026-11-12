//! A CTE named like a parent the role has no policy on (#145 pull request D, regression fixture).
//!
//! `viewer` reads `tasks` only through its parent `projects`: the filter is an `exists` on the
//! parent's tenant. `viewer` has no policy on `projects`, so `projects` is not in the Catalog its
//! SQL is bound against and a CTE may carry that name. The name must never reach the emitted
//! SQL, where it would shadow the parent the policy reads.

use serde_json::{Value, json};

const CATALOG: &str = r"
version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      id: { type: string }
      tenant_id: { type: string }
  tasks:
    source: { table: tasks }
    columns:
      id: { type: string }
      project_id: { type: string }
";

const POLICY: &str = r"
version: 1
resources:
  tasks:
    roles:
      viewer:
        select:
          columns: [id, project_id]
          filter: { exists: { resource: projects, on: { id: project_id }, where: { tenant_id: { eq: { session: tenant_id } } } } }
          limit: 100
";

const AUTH: &str = r#"{"principal":"test:user","subject":"u","role":"viewer","roles":["viewer"],"access":["execute","explain"],"session":{"tenant_id":"tenant_a"}}"#;

fn compile(sql: &str) -> Value {
    let runtime = super::PolicySqlRuntime::new(
        CATALOG,
        POLICY,
        "schema_resource",
        "policy_resource",
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"));
    let request = json!({"statements": [{"sql": sql, "params": {}}]}).to_string();
    serde_json::from_str(&runtime.compile_json(AUTH, &request, "execute"))
        .unwrap_or_else(|_| unreachable!("runtime output is JSON"))
}

fn protected(output: &Value) -> &str {
    output["statements"][0]["protectedSql"]
        .as_str()
        .unwrap_or_else(|| unreachable!("a compiled statement has protected SQL: {output}"))
}

#[test]
fn a_cte_named_like_the_parent_does_not_shadow_it_in_the_policy_predicate() {
    let shadowed =
        compile("WITH projects AS (SELECT id, project_id FROM tasks) SELECT id FROM projects");
    let absent =
        compile("WITH no_such AS (SELECT id, project_id FROM tasks) SELECT id FROM no_such");
    let plain = compile("SELECT id FROM tasks");
    assert!(shadowed.get("error").is_none(), "{shadowed}");
    assert!(absent.get("error").is_none(), "{absent}");
    let sql = protected(&shadowed);
    assert!(!sql.contains("WITH"), "{sql}");
    assert!(sql.contains("EXISTS"), "{sql}");
    assert!(sql.contains("\"projects\" AS \"__policysql_t"), "{sql}");
    assert!(sql.contains("\"tenant_id\""), "{sql}");
    assert_eq!(shadowed["statements"], absent["statements"]);
    assert_eq!(shadowed["statements"], plain["statements"]);
    assert_eq!(shadowed["statements"][0]["resource"], "tasks");
}

#[test]
fn the_parent_itself_is_a_name_that_does_not_exist_to_the_role() {
    for name in ["projects", "no_such"] {
        let output = compile(&format!("SELECT id FROM {name}"));
        assert_eq!(
            output["error"]["code"], "POLICYSQL_MISSING_POLICY",
            "{output}"
        );
        assert_eq!(output["error"].get("detail"), None, "{output}");
    }
}
