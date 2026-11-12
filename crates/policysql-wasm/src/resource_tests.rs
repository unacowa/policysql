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
    serde_json::from_str(&runtime.compile_json(AUTH, &request, "execute", crate::TEST_CONTEXT))
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

// Roles that each have a policy on a different resource, or on one operation only: the Catalog a
// role's SQL is bound against is the role's own, not the union of the roles' (#145 pull request D).

const ROLES_CATALOG: &str = r"
version: 1
resources:
  a_only:
    source: { table: a_only }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      name: { type: string }
  b_only:
    source: { table: b_only }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      name: { type: string }
";

const ROLES_POLICY: &str = r"
version: 1
resources:
  a_only:
    roles:
      a:
        select:
          columns: [id, name]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
      updater:
        update:
          columns: [name]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id] }
      deleter:
        delete:
          filter: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id] }
  b_only:
    roles:
      b:
        select:
          columns: [id, name]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
";

fn compile_as(role: &str, sql: &str) -> Value {
    let runtime = super::PolicySqlRuntime::new(
        ROLES_CATALOG,
        ROLES_POLICY,
        "schema_roles",
        "policy_roles",
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"));
    let auth = json!({
        "principal": "test:user", "subject": "u", "role": role, "roles": [role],
        "access": ["execute", "explain"], "session": {"tenant_id": "tenant_a"},
    })
    .to_string();
    let params = if sql.contains(":v") {
        json!({"v": "x"})
    } else {
        json!({})
    };
    let request = json!({"statements": [{"sql": sql, "params": params}]}).to_string();
    serde_json::from_str(&runtime.compile_json(&auth, &request, "execute", crate::TEST_CONTEXT))
        .unwrap_or_else(|_| unreachable!("runtime output is JSON"))
}

#[test]
fn a_resource_another_role_has_a_policy_on_is_a_name_that_does_not_exist_to_this_role() {
    for (role, own, other) in [("a", "a_only", "b_only"), ("b", "b_only", "a_only")] {
        for template in [
            "SELECT nope FROM {R}",
            "SELECT * FROM {R}",
            "SELECT id FROM {R} WHERE id = 1",
            "SELECT id FROM {R} WHERE tenant_id = TRUE",
            "SELECT id FROM {R} ORDER BY nope",
            "UPDATE {R} SET nope = :v",
            "DELETE FROM {R} WHERE nope = :v",
        ] {
            let of_other = compile_as(role, &template.replace("{R}", other));
            let missing = compile_as(role, &template.replace("{R}", "no_such_table"));
            assert_eq!(
                of_other["error"]["code"], "POLICYSQL_MISSING_POLICY",
                "{role} {template}: {of_other}"
            );
            assert_eq!(of_other["error"], missing["error"], "{role} {template}");
        }
        // Its own resource keeps its column checks.
        let output = compile_as(role, &format!("SELECT nope FROM {own}"));
        assert_eq!(
            output["error"]["code"], "POLICYSQL_FORBIDDEN_COLUMN",
            "{role}: {output}"
        );
        // A CTE named like the other role's resource is a name that does not exist, and compiles;
        // one named like its own is refused.
        let cte = compile_as(
            role,
            &format!("WITH {other} AS (SELECT id FROM {own}) SELECT id FROM {other}"),
        );
        assert!(cte.get("error").is_none(), "{role}: {cte}");
        let own_cte = compile_as(
            role,
            &format!("WITH {own} AS (SELECT id FROM {own}) SELECT id FROM {own}"),
        );
        assert_eq!(
            own_cte["error"]["code"], "POLICYSQL_UNSUPPORTED_SQL",
            "{role}: {own_cte}"
        );
    }
}

#[test]
fn a_role_with_only_an_update_or_only_a_delete_policy_can_name_the_resource() {
    let updated = compile_as("updater", "UPDATE a_only SET name = :v");
    assert!(updated.get("error").is_none(), "{updated}");
    let deleted = compile_as("deleter", "DELETE FROM a_only");
    assert!(deleted.get("error").is_none(), "{deleted}");
    // Nothing else is theirs: no select policy, and no policy on the other resource.
    for (role, sql) in [
        ("updater", "SELECT id FROM a_only"),
        ("updater", "UPDATE b_only SET name = :v"),
        ("deleter", "DELETE FROM b_only"),
    ] {
        let output = compile_as(role, sql);
        assert_eq!(
            output["error"]["code"], "POLICYSQL_MISSING_POLICY",
            "{role} {sql}: {output}"
        );
    }
}
