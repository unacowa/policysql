//! Client SQL string literals bind their decoded value (issue #39).
//!
//! `turso_parser` keeps the raw token, quotes and `''` escapes included, in
//! `Literal::String`. Every case here compiles through the gateway (binder,
//! policy compiler, emitter, re-parse and invariant verification) and checks:
//!
//! - golden: the server literal parameters carry exactly the decoded values;
//! - differential: the protected SQL with its arguments, run against a
//!   multi-tenant SQLite database, returns and changes exactly what the client
//!   SQL run unprotected returns and changes on the single-tenant data the
//!   policy exposes;
//! - bypass: other-tenant and policy-hidden rows stay unreachable and
//!   unchanged, and a policy `neq` operation check sees the decoded value.

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    ColumnName, LogicalType, LogicalValue, ResourceId, ResourceName, RoleName, SnapshotId,
    TrustedSession, ValueDescriptor, ValueRepresentation,
};
use policysql_execution::{ExecutionLimits, VerifiedExecutionPlan};
use policysql_gateway::{
    AuthContext, EndpointPermission, Gateway, GatewayError, RejectionKind, StatementRequest,
};
use policysql_policy::PolicyBundle;
use policysql_sqlite::SqliteProfile;
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use std::collections::{BTreeMap, BTreeSet};

/// The single-tenant rows the member policy exposes. `tenant_id` defaults so
/// that the unprotected client `INSERT` matches the server-owned preset.
const SCHEMA: &str = "CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_1',
  name TEXT NOT NULL,
  status TEXT NOT NULL
) STRICT;";

const VISIBLE: &str = "INSERT INTO items (id, tenant_id, name, status) VALUES
  ('seed', 'tenant_1', 'Seed', 'active'),
  ('it''s', 'tenant_1', 'Quote', 'pending'),
  ('''', 'tenant_1', 'Apostrophe', 'active'),
  ('', 'tenant_1', 'Empty', 'pending'),
  ('''x''', 'tenant_1', 'Quoted', 'active'),
  ('x', 'tenant_1', 'Plain', 'archived'),
  ('zzz', 'tenant_1', 'Zed', 'active');";

/// Rows the policy hides: another tenant (with colliding names) and
/// same-tenant rows excluded by policy string literals, one of which is a
/// quoted-looking policy literal.
const HIDDEN: &str = "INSERT INTO items (id, tenant_id, name, status) VALUES
  ('t2_seed', 'tenant_2', 'Seed', 'active'),
  ('t2_quote', 'tenant_2', 'it''s', 'pending'),
  ('t2_x', 'tenant_2', 'Plain', 'active'),
  ('gone', 'tenant_1', 'Seed', 'deleted'),
  ('legacy', 'tenant_1', '''legacy''', 'active');";

const POLICY: &str = r#"version: 1
resources:
  items:
    roles:
      member:
        select:
          columns: [id, name, status]
          filter:
            and:
              - { tenant_id: { eq: { session: tenant_id } } }
              - { status: { neq: deleted } }
              - { name: { neq: "'legacy'" } }
        insert:
          columns: [id, name, status]
          presets: { tenant_id: { session: tenant_id } }
          check:
            and:
              - { tenant_id: { eq: { session: tenant_id } } }
              - { status: { neq: archived } }
          returning: { columns: [id, name, status] }
        update:
          columns: [name, status]
          filter:
            and:
              - { tenant_id: { eq: { session: tenant_id } } }
              - { status: { neq: deleted } }
              - { name: { neq: "'legacy'" } }
          check:
            and:
              - { tenant_id: { eq: { session: tenant_id } } }
              - { status: { neq: archived } }
          returning: { columns: [id, name, status] }
        delete:
          filter:
            and:
              - { tenant_id: { eq: { session: tenant_id } } }
              - { status: { neq: deleted } }
              - { name: { neq: "'legacy'" } }
          returning: { columns: [id] }
"#;

/// Policy string literals that appear as server literal parameters.
const POLICY_LITERALS: [&str; 3] = ["deleted", "'legacy'", "archived"];

const VISIBLE_STATE: &str = "SELECT id, name, status FROM items
  WHERE tenant_id = 'tenant_1' AND status <> 'deleted' AND name <> '''legacy'''";
const HIDDEN_STATE: &str = "SELECT id, tenant_id, name, status FROM items
  WHERE NOT (tenant_id = 'tenant_1' AND status <> 'deleted' AND name <> '''legacy''')";

fn snapshot() -> SnapshotId {
    SnapshotId::new("string_literals").unwrap_or_else(|_| unreachable!())
}

fn catalog() -> Catalog {
    let descriptor = ValueDescriptor {
        logical_type: LogicalType::String,
        representation: ValueRepresentation::String,
        nullable: false,
        format: None,
        storage: None,
        constraints: None,
        json_schema: None,
    };
    let resource = ResourceDescriptor::new(
        ResourceId::new(1).unwrap_or_else(|_| unreachable!()),
        ResourceName::new("items").unwrap_or_else(|_| unreachable!()),
        ["id", "tenant_id", "name", "status"].map(|name| {
            (
                ColumnName::new(name).unwrap_or_else(|_| unreachable!()),
                descriptor.clone(),
            )
        }),
    )
    .unwrap_or_else(|error| unreachable!("resource: {error}"));
    Catalog::new(snapshot(), [resource]).unwrap_or_else(|_| unreachable!())
}

fn gateway() -> (Gateway, AuthContext) {
    let catalog = catalog();
    let bundle = PolicyBundle::activate(POLICY, &catalog, snapshot())
        .unwrap_or_else(|error| unreachable!("policy: {error}"));
    let session = TrustedSession::new(
        RoleName::new("member").unwrap_or_else(|_| unreachable!()),
        "user_1",
        BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
    )
    .unwrap_or_else(|_| unreachable!());
    let limits = ExecutionLimits {
        max_rows: 100,
        max_result_bytes: 64_000,
        timeout_ms: 1_000,
    };
    (
        Gateway::new(catalog, bundle, snapshot(), limits, 4),
        AuthContext::new(session, [EndpointPermission::Execute]),
    )
}

fn compile(sql: &str) -> Result<VerifiedExecutionPlan<SqliteProfile>, GatewayError> {
    let (gateway, auth) = gateway();
    let request = [StatementRequest {
        sql: sql.to_owned(),
        parameters: BTreeMap::new(),
        expected_affected_rows: None,
        expected_row_count: None,
    }];
    gateway
        .compile_envelope(&auth, EndpointPermission::Execute, None, &request)
        .map(|mut envelope| envelope.statements.remove(0).plan)
}

fn database(hidden: bool) -> Connection {
    let database = Connection::open_in_memory().unwrap_or_else(|_| unreachable!());
    database
        .execute_batch(SCHEMA)
        .and_then(|()| database.execute_batch(VISIBLE))
        .unwrap_or_else(|error| unreachable!("seed: {error}"));
    if hidden {
        database
            .execute_batch(HIDDEN)
            .unwrap_or_else(|error| unreachable!("hidden seed: {error}"));
    }
    database
}

fn sql_value(value: &LogicalValue) -> SqlValue {
    match value {
        LogicalValue::Null => SqlValue::Null,
        LogicalValue::String(value) | LogicalValue::Json(value) => SqlValue::Text(value.clone()),
        LogicalValue::Boolean(value) => SqlValue::Integer(i64::from(*value)),
        LogicalValue::Int64(value) => SqlValue::Integer(*value),
        LogicalValue::Number(value) => SqlValue::Real(*value),
        LogicalValue::Bytes(value) => SqlValue::Blob(value.clone()),
    }
}

/// Runs SQL with named arguments and returns every physical row.
fn query(
    database: &Connection,
    sql: &str,
    arguments: &BTreeMap<String, LogicalValue>,
) -> Vec<Vec<SqlValue>> {
    let mut statement = database
        .prepare(sql)
        .unwrap_or_else(|error| unreachable!("{sql} prepares: {error}"));
    for (name, value) in arguments {
        let index = statement
            .parameter_index(&format!(":{name}"))
            .unwrap_or_else(|error| unreachable!("parameter index: {error}"))
            .unwrap_or_else(|| unreachable!("{sql} references :{name}"));
        statement
            .raw_bind_parameter(index, sql_value(value))
            .unwrap_or_else(|error| unreachable!("bind: {error}"));
    }
    let width = statement.column_count();
    let mut rows = statement.raw_query();
    let mut output = Vec::new();
    while let Some(row) = rows
        .next()
        .unwrap_or_else(|error| unreachable!("{sql} executes: {error}"))
    {
        output.push(
            (0..width)
                .map(|index| {
                    row.get_ref(index)
                        .map_or_else(|error| unreachable!("column: {error}"), SqlValue::from)
                })
                .collect(),
        );
    }
    output
}

fn sorted(mut rows: Vec<Vec<SqlValue>>) -> Vec<Vec<SqlValue>> {
    rows.sort_by(|left, right| format!("{left:?}").cmp(&format!("{right:?}")));
    rows
}

fn arguments(plan: &VerifiedExecutionPlan<SqliteProfile>) -> BTreeMap<String, LogicalValue> {
    plan.client_parameters()
        .iter()
        .map(|(name, value)| (name.as_str().to_owned(), value.clone()))
        .chain(
            plan.server_parameters()
                .iter()
                .map(|(name, value)| (name.as_str().to_owned(), value.clone())),
        )
        .collect()
}

/// Client-originated literal values bound as server parameters, in a multiset.
fn client_literal_values(plan: &VerifiedExecutionPlan<SqliteProfile>) -> Vec<String> {
    let mut policy = POLICY_LITERALS.map(str::to_owned).to_vec();
    let mut values = plan
        .server_parameters()
        .iter()
        .filter(|(name, _)| name.as_str().starts_with("__policysql_literal_"))
        .filter_map(|(_, value)| match value {
            LogicalValue::String(value) => Some(value.clone()),
            _ => None,
        })
        .filter(|value| {
            policy
                .iter()
                .position(|candidate| candidate == value)
                .map(|index| policy.remove(index))
                .is_none()
        })
        .collect::<Vec<_>>();
    values.sort();
    values
}

fn expected_values(values: &[&str]) -> Vec<String> {
    let mut values = values
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    values.sort();
    values
}

/// Executes the sealed protected SQL; returns the result columns and whether
/// every row passed the operation check.
fn execute_protected(
    database: &Connection,
    plan: &VerifiedExecutionPlan<SqliteProfile>,
) -> (Vec<Vec<SqlValue>>, bool) {
    let rows = query(database, plan.protected_sql(), &arguments(plan));
    let width = plan.result().len();
    let passed = plan.operation_check_column().is_none()
        || rows
            .iter()
            .all(|row| matches!(row.get(width), Some(SqlValue::Integer(1))));
    (
        rows.into_iter()
            .map(|row| row.into_iter().take(width).collect())
            .collect(),
        passed,
    )
}

const SELECT_CASES: &[(&str, &[&str])] = &[
    ("SELECT id, name FROM items WHERE id = 'seed'", &["seed"]),
    ("SELECT id, name FROM items WHERE id != 'seed'", &["seed"]),
    ("SELECT id, name FROM items WHERE id <> 'seed'", &["seed"]),
    ("SELECT id, name FROM items WHERE name < 'Q'", &["Q"]),
    ("SELECT id, name FROM items WHERE name > 'Q'", &["Q"]),
    ("SELECT id, name FROM items WHERE name <= 'Seed'", &["Seed"]),
    ("SELECT id, name FROM items WHERE name >= 'Seed'", &["Seed"]),
    ("SELECT id, name FROM items WHERE name > 'zzz'", &["zzz"]),
    ("SELECT id, name FROM items WHERE name = 'Seed'", &["Seed"]),
    ("SELECT id, name FROM items WHERE id LIKE 'se%'", &["se%"]),
    ("SELECT id, name FROM items WHERE name LIKE '%e%'", &["%e%"]),
    (
        "SELECT id, name FROM items WHERE name NOT LIKE 'q%'",
        &["q%"],
    ),
    ("SELECT id, name FROM items WHERE name GLOB 'Q*'", &["Q*"]),
    ("SELECT id, name FROM items WHERE id GLOB '''*'", &["'*"]),
    (
        "SELECT id, name FROM items WHERE id IN ('seed', 'it''s', '''')",
        &["seed", "it's", "'"],
    ),
    (
        "SELECT id, name FROM items WHERE id NOT IN ('seed', 'x')",
        &["seed", "x"],
    ),
    ("SELECT id, name FROM items WHERE id = 'it''s'", &["it's"]),
    ("SELECT id, name FROM items WHERE id = ''''", &["'"]),
    ("SELECT id, name FROM items WHERE id = ''", &[""]),
    ("SELECT id, name FROM items WHERE id = '''x'''", &["'x'"]),
    ("SELECT id, name FROM items WHERE id = 'x'", &["x"]),
    (
        "SELECT id, name FROM items WHERE id = 'x' OR id = '''x'''",
        &["x", "'x'"],
    ),
    ("SELECT id, name FROM items WHERE name = 'it''s'", &["it's"]),
    (
        "SELECT id, name FROM items WHERE name = '''legacy'''",
        &["'legacy'"],
    ),
    (
        "SELECT id, name FROM items WHERE status = 'deleted'",
        &["deleted"],
    ),
    (
        "SELECT id, name FROM items WHERE LOWER(name) = 'seed'",
        &["seed"],
    ),
    (
        "SELECT id, name FROM items WHERE UPPER(id) = 'SEED'",
        &["SEED"],
    ),
    (
        "SELECT id, CASE WHEN status = 'active' THEN 'on' WHEN id = 'it''s' THEN 'it''s' ELSE '' END AS state FROM items",
        &["active", "on", "it's", "it's", ""],
    ),
    ("SELECT id, name || '''' AS label FROM items", &["'"]),
    (
        "SELECT id, CAST('a''b' AS TEXT) AS label FROM items",
        &["a'b"],
    ),
];

#[test]
fn select_literals_bind_decoded_values_and_match_unprotected_single_tenant_sqlite() {
    let protected_database = database(true);
    let reference_database = database(false);
    for (sql, expected) in SELECT_CASES {
        let plan = compile(sql).unwrap_or_else(|error| unreachable!("{sql}: {error}"));
        assert_eq!(
            client_literal_values(&plan),
            expected_values(expected),
            "{sql}"
        );
        let (protected, _) = execute_protected(&protected_database, &plan);
        let reference = query(&reference_database, sql, &BTreeMap::new());
        assert_eq!(sorted(protected), sorted(reference), "{sql}");
    }
}

#[test]
fn issue_examples_now_match_rows() {
    let database = database(true);
    for (sql, expected) in [
        ("SELECT id FROM items WHERE id = 'seed'", vec!["seed"]),
        ("SELECT id FROM items WHERE id LIKE 'se%'", vec!["seed"]),
        ("SELECT id FROM items WHERE id = 'it''s'", vec!["it's"]),
        ("SELECT id FROM items WHERE name > 'Zed'", vec![]),
    ] {
        let plan = compile(sql).unwrap_or_else(|error| unreachable!("{sql}: {error}"));
        let (rows, _) = execute_protected(&database, &plan);
        let expected = expected
            .into_iter()
            .map(|id| vec![SqlValue::Text(id.to_owned())])
            .collect::<Vec<_>>();
        assert_eq!(sorted(rows), expected, "{sql}");
    }
}

const MUTATION_CASES: &[(&str, &[&str])] = &[
    (
        "UPDATE items SET name = 'Renamed' WHERE id <> 'x' RETURNING id, name",
        &["Renamed", "x"],
    ),
    (
        "UPDATE items SET name = 'Renamed' WHERE id != 'seed' AND id <> '''x''' AND id <> 'x' RETURNING id",
        &["Renamed", "seed", "'x'", "x"],
    ),
    (
        "UPDATE items SET status = 'pending' WHERE id = 'seed' RETURNING id, status",
        &["pending", "seed"],
    ),
    (
        "UPDATE items SET name = 'it''s' WHERE id = '''x''' RETURNING id, name",
        &["it's", "'x'"],
    ),
    (
        "UPDATE items SET name = '''' WHERE name LIKE 'q%' RETURNING id, name",
        &["'", "q%"],
    ),
    (
        "UPDATE items SET name = '' WHERE name = 'Seed' RETURNING id, name",
        &["", "Seed"],
    ),
    (
        "UPDATE items SET status = 'active' WHERE name = 'it''s' RETURNING id",
        &["active", "it's"],
    ),
    (
        "INSERT INTO items (id, name, status) VALUES ('new''one', 'New', 'active'), ('''new''', 'Dup', 'pending') RETURNING id, name, status",
        &["new'one", "New", "active", "'new'", "Dup", "pending"],
    ),
    (
        "INSERT INTO items (id, name, status) VALUES ('fresh', '''quoted''', 'pending') RETURNING id, name",
        &["fresh", "'quoted'", "pending"],
    ),
    (
        "DELETE FROM items WHERE id = 'it''s' RETURNING id",
        &["it's"],
    ),
    (
        "DELETE FROM items WHERE name = 'Seed' RETURNING id",
        &["Seed"],
    ),
    (
        "DELETE FROM items WHERE id NOT IN ('seed', '''x''') RETURNING id",
        &["seed", "'x'"],
    ),
];

#[test]
fn mutation_literals_bind_decoded_values_and_match_unprotected_single_tenant_sqlite() {
    for (sql, expected) in MUTATION_CASES {
        let protected_database = database(true);
        let reference_database = database(false);
        let hidden_before = sorted(query(&protected_database, HIDDEN_STATE, &BTreeMap::new()));
        let plan = compile(sql).unwrap_or_else(|error| unreachable!("{sql}: {error}"));
        assert_eq!(
            client_literal_values(&plan),
            expected_values(expected),
            "{sql}"
        );
        let (protected, passed) = execute_protected(&protected_database, &plan);
        assert!(passed, "{sql}: operation check");
        let reference = query(&reference_database, sql, &BTreeMap::new());
        assert_eq!(sorted(protected), sorted(reference), "{sql}: returned rows");
        assert_eq!(
            sorted(query(&protected_database, VISIBLE_STATE, &BTreeMap::new())),
            sorted(query(
                &reference_database,
                "SELECT id, name, status FROM items",
                &BTreeMap::new()
            )),
            "{sql}: visible state"
        );
        assert_eq!(
            sorted(query(&protected_database, HIDDEN_STATE, &BTreeMap::new())),
            hidden_before,
            "{sql}: hidden rows changed"
        );
    }
}

#[test]
fn update_with_not_equal_literal_does_not_touch_the_excluded_row() {
    let database = database(true);
    let plan = compile("UPDATE items SET status = 'pending' WHERE id <> 'x' RETURNING id")
        .unwrap_or_else(|error| unreachable!("{error}"));
    let (rows, passed) = execute_protected(&database, &plan);
    assert!(passed);
    assert!(!rows.contains(&vec![SqlValue::Text("x".to_owned())]));
    assert_eq!(rows.len(), 6);
    assert_eq!(
        query(
            &database,
            "SELECT name, status FROM items WHERE id = 'x'",
            &BTreeMap::new()
        ),
        vec![vec![
            SqlValue::Text("Plain".to_owned()),
            SqlValue::Text("archived".to_owned())
        ]]
    );
}

#[test]
fn neq_operation_check_sees_the_decoded_client_literal() {
    for sql in [
        "UPDATE items SET status = 'archived' WHERE id = 'seed' RETURNING id",
        "INSERT INTO items (id, name, status) VALUES ('fresh', 'Fresh', 'archived') RETURNING id",
    ] {
        let database = database(true);
        let plan = compile(sql).unwrap_or_else(|error| unreachable!("{sql}: {error}"));
        assert_eq!(
            client_literal_values(&plan)
                .iter()
                .filter(|value| *value == "archived")
                .count(),
            1,
            "{sql}"
        );
        let (rows, passed) = execute_protected(&database, &plan);
        assert_eq!(rows.len(), 1, "{sql}");
        assert!(!passed, "{sql}: writing 'archived' must fail the neq check");
    }
    // A value that only differs by SQL quoting is a different value and passes.
    let database = database(true);
    let plan = compile("UPDATE items SET status = '''archived''' WHERE id = 'seed' RETURNING id")
        .unwrap_or_else(|error| unreachable!("{error}"));
    let (_, passed) = execute_protected(&database, &plan);
    assert!(passed);
}

#[test]
fn literals_never_reach_other_tenants_or_policy_hidden_rows() {
    let shared = database(true);
    for sql in [
        "SELECT id FROM items WHERE name = 'Seed'",
        "SELECT id FROM items WHERE id = 't2_seed'",
        "SELECT id FROM items WHERE id = 'gone' OR status = 'deleted'",
        "SELECT id FROM items WHERE name = '''legacy''' OR id = 'legacy'",
        "SELECT id FROM items WHERE name = 'it''s' OR id = 't2_quote'",
        "SELECT id FROM items WHERE id LIKE 't2%' OR id GLOB 'leg*'",
    ] {
        let plan = compile(sql).unwrap_or_else(|error| unreachable!("{sql}: {error}"));
        let (rows, _) = execute_protected(&shared, &plan);
        for hidden in ["t2_seed", "t2_quote", "t2_x", "gone", "legacy"] {
            assert!(
                !rows.contains(&vec![SqlValue::Text(hidden.to_owned())]),
                "{sql} leaked {hidden}"
            );
        }
    }
    for sql in [
        "UPDATE items SET name = 'Hijacked' WHERE id = 't2_seed' OR name = 'Seed' RETURNING id",
        "DELETE FROM items WHERE id IN ('t2_seed', 'gone', 'legacy') RETURNING id",
    ] {
        let fresh = database(true);
        let before = sorted(query(&fresh, HIDDEN_STATE, &BTreeMap::new()));
        let plan = compile(sql).unwrap_or_else(|error| unreachable!("{sql}: {error}"));
        execute_protected(&fresh, &plan);
        assert_eq!(
            sorted(query(&fresh, HIDDEN_STATE, &BTreeMap::new())),
            before,
            "{sql}"
        );
    }
}

#[test]
fn non_string_quoting_and_blob_literals_are_rejected_before_execution() {
    for (sql, expected) in [
        (
            "SELECT id FROM items WHERE id = \"seed\"",
            RejectionKind::ForbiddenColumn,
        ),
        (
            "SELECT id FROM items WHERE id = 'seed",
            RejectionKind::InvalidSql,
        ),
        (
            "SELECT id FROM items WHERE id = X'73656564'",
            RejectionKind::UnsupportedSql,
        ),
        (
            "UPDATE items SET name = \"x\" WHERE id = 'seed' RETURNING id",
            RejectionKind::ForbiddenColumn,
        ),
    ] {
        assert_eq!(
            compile(sql).map(|_| ()),
            Err(GatewayError::Rejected {
                kind: expected,
                index: 0
            }),
            "{sql}"
        );
    }
}

#[test]
fn literal_set_is_a_multiset_of_decoded_values() {
    let plan = compile("SELECT id FROM items WHERE id = 'x' OR name = 'x' OR id = '''x'''")
        .unwrap_or_else(|error| unreachable!("{error}"));
    assert_eq!(
        client_literal_values(&plan),
        expected_values(&["x", "x", "'x'"])
    );
    let distinct = client_literal_values(&plan)
        .into_iter()
        .collect::<BTreeSet<_>>();
    assert_eq!(distinct.len(), 2);
}
