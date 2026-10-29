//! NULL client parameters in direct nullable assignments (issue #20).
//!
//! Each case compiles through the binder, policy compiler and sealed SQLite plan
//! (emission, re-parse and invariant verification), then executes the sealed
//! protected SQL against an independent in-memory SQLite database. This proves
//! that an accepted NULL is stored as physical SQL NULL for every logical type,
//! and that policy post-state checks keep TRUE-only semantics when the written
//! value is NULL: a check that is UNKNOWN because of NULL must fail.

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    ClientParameterName, ColumnName, LogicalType, LogicalValue, ResourceId, ResourceName, RoleName,
    SnapshotId, TrustedSession, ValueDescriptor, ValueRepresentation,
};
use policysql_execution::{ExecutionLimits, VerifiedExecutionPlan};
use policysql_parser::SqliteFrontend;
use policysql_policy::PolicyBundle;
use policysql_sqlite::{SqliteProfile, compile_verified_insert, compile_verified_update};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use std::collections::BTreeMap;

const SCHEMA: &str = "CREATE TABLE nullabletexts (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT, amount REAL, count INTEGER, big INTEGER, flag INTEGER, meta TEXT,
  payload BLOB, due TEXT, at TEXT, ts TEXT, secret TEXT, owner TEXT
);
INSERT INTO nullabletexts (id, tenant_id, label, state, amount, count, big, flag, meta, payload, due, at, ts, secret, owner)
VALUES
  ('target', 'tenant_1', 'keep', 'keep', 1.5, 7, 9, 1, '{\"a\":1}', X'00ff', '2026-10-29', '2026-10-29 12:00:00', '2026-10-29T12:00:00Z', 'secret', 'tenant_1'),
  ('hidden', 'tenant_2', 'keep', 'keep', 1.5, 7, 9, 1, '{\"a\":1}', X'00ff', '2026-10-29', '2026-10-29 12:00:00', '2026-10-29T12:00:00Z', 'secret', 'tenant_2');";

/// Nullable writable columns and their logical types.
const TYPED: [(&str, LogicalType); 11] = [
    ("state", LogicalType::String),
    ("amount", LogicalType::Number),
    ("count", LogicalType::Integer),
    ("big", LogicalType::Int64),
    ("flag", LogicalType::Boolean),
    ("meta", LogicalType::Json),
    ("payload", LogicalType::Bytes),
    ("due", LogicalType::Date),
    ("at", LogicalType::DateTime),
    ("ts", LogicalType::Instant),
    ("secret", LogicalType::String),
];

const WRITABLE: &str = "label, state, amount, count, big, flag, meta, payload, due, at, ts";
const READABLE: &str =
    "id, label, state, amount, count, big, flag, meta, payload, due, at, ts, owner";
const TENANT_CHECK: &str = "{ tenant_id: { eq: { session: tenant_id } } }";

fn snapshot() -> SnapshotId {
    SnapshotId::new("nullable_assignments").unwrap_or_else(|_| unreachable!())
}

fn descriptor(logical_type: LogicalType, nullable: bool) -> ValueDescriptor {
    ValueDescriptor {
        logical_type,
        representation: match logical_type {
            LogicalType::Number | LogicalType::Integer => ValueRepresentation::Number,
            LogicalType::Boolean => ValueRepresentation::Boolean,
            LogicalType::Json => ValueRepresentation::Json,
            LogicalType::Bytes => ValueRepresentation::Base64,
            _ => ValueRepresentation::String,
        },
        nullable,
        format: match logical_type {
            LogicalType::Date => Some("iso-date".to_owned()),
            LogicalType::DateTime => Some("sqlite-datetime".to_owned()),
            LogicalType::Instant => Some("rfc3339".to_owned()),
            _ => None,
        },
        storage: None,
        constraints: None,
        json_schema: None,
    }
}

fn catalog() -> Catalog {
    let mut columns = vec![
        ("id", descriptor(LogicalType::String, false)),
        ("tenant_id", descriptor(LogicalType::String, false)),
        ("label", descriptor(LogicalType::String, false)),
    ];
    columns.extend(
        TYPED
            .iter()
            .map(|(name, logical_type)| (*name, descriptor(*logical_type, true))),
    );
    columns.push(("owner", descriptor(LogicalType::String, true)));
    let resource = ResourceDescriptor::new(
        ResourceId::new(1).unwrap_or_else(|_| unreachable!()),
        ResourceName::new("nullabletexts").unwrap_or_else(|_| unreachable!()),
        columns.into_iter().map(|(name, value)| {
            (
                ColumnName::new(name).unwrap_or_else(|_| unreachable!()),
                value,
            )
        }),
    )
    .unwrap_or_else(|error| unreachable!("fixture resource: {error}"));
    Catalog::new(snapshot(), [resource]).unwrap_or_else(|_| unreachable!())
}

/// `owner` is a nullable server-owned preset; `secret` is nullable but neither
/// writable nor returnable.
fn policy(check: &str) -> String {
    format!(
        "version: 1
resources:
  nullabletexts:
    roles:
      member:
        select:
          columns: [{READABLE}]
          filter: {TENANT_CHECK}
          limit: 100
        insert:
          columns: [id, {WRITABLE}]
          presets: {{ tenant_id: {{ session: tenant_id }}, owner: {{ session: tenant_id }} }}
          check: {check}
          returning: {{ columns: [{READABLE}] }}
        update:
          columns: [{WRITABLE}]
          presets: {{ owner: {{ session: tenant_id }} }}
          filter: {TENANT_CHECK}
          check: {check}
          returning: {{ columns: [{READABLE}] }}
"
    )
}

fn session() -> TrustedSession {
    TrustedSession::new(
        RoleName::new("member").unwrap_or_else(|_| unreachable!()),
        "user_1",
        BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
    )
    .unwrap_or_else(|_| unreachable!())
}

fn text(value: &str) -> LogicalValue {
    LogicalValue::String(value.to_owned())
}

/// Binds, applies policy and seals one mutation; every failure is a rejection.
fn compile(
    check: &str,
    sql: &str,
    parameters: &[(&str, LogicalValue)],
) -> Result<VerifiedExecutionPlan<SqliteProfile>, String> {
    let catalog = catalog();
    let bundle = PolicyBundle::activate(&policy(check), &catalog, snapshot())
        .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
    let statement = SqliteFrontend::default()
        .bind(sql, &catalog)
        .map_err(|error| format!("bind: {error}"))?;
    let insert = sql.starts_with("INSERT");
    let output = if insert {
        bundle.compile_insert(&statement, &session())
    } else {
        bundle.compile_update(&statement, &session())
    }
    .map_err(|error| format!("policy: {error}"))?;
    let parameters = parameters
        .iter()
        .map(|(name, value)| {
            (
                ClientParameterName::new(*name).unwrap_or_else(|_| unreachable!()),
                value.clone(),
            )
        })
        .collect();
    let limits = ExecutionLimits {
        max_rows: 100,
        max_result_bytes: 64_000,
        timeout_ms: 1_000,
    };
    let compile = if insert {
        compile_verified_insert
    } else {
        compile_verified_update
    };
    compile(&output.plan, &catalog, parameters, limits, snapshot())
        .map_err(|error| format!("compile: {error}"))
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

/// Executes the sealed protected SQL exactly as emitted and returns every
/// physical row, including the trailing operation-check column.
fn execute(
    database: &Connection,
    plan: &VerifiedExecutionPlan<SqliteProfile>,
) -> Vec<Vec<SqlValue>> {
    let mut statement = database
        .prepare(plan.protected_sql())
        .unwrap_or_else(|error| unreachable!("protected SQL prepares: {error}"));
    let parameters = plan
        .client_parameters()
        .iter()
        .map(|(name, value)| (name.as_str().to_owned(), value))
        .chain(
            plan.server_parameters()
                .iter()
                .map(|(name, value)| (name.as_str().to_owned(), value)),
        );
    for (name, value) in parameters {
        let index = statement
            .parameter_index(&format!(":{name}"))
            .unwrap_or_else(|error| unreachable!("parameter index: {error}"))
            .unwrap_or_else(|| unreachable!("protected SQL references :{name}"));
        statement
            .raw_bind_parameter(index, sql_value(value))
            .unwrap_or_else(|error| unreachable!("bind: {error}"));
    }
    let width = statement.column_count();
    let mut rows = statement.raw_query();
    let mut output = Vec::new();
    while let Some(row) = rows
        .next()
        .unwrap_or_else(|error| unreachable!("protected SQL executes: {error}"))
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

fn database() -> Connection {
    let database = Connection::open_in_memory().unwrap_or_else(|_| unreachable!());
    database
        .execute_batch(SCHEMA)
        .unwrap_or_else(|error| unreachable!("schema: {error}"));
    database
}

fn storage(database: &Connection, id: &str, column: &str) -> String {
    database
        .query_row(
            &format!("SELECT typeof(\"{column}\") FROM nullabletexts WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .unwrap_or_else(|error| unreachable!("storage: {error}"))
}

fn check_passed(row: &[SqlValue]) -> bool {
    // Mirrors the adapters: only an exact SQL TRUE (1) passes the check column.
    matches!(row.last(), Some(SqlValue::Integer(1)))
}

#[test]
fn issue_example_update_stores_and_returns_sql_null() {
    let database = database();
    let plan = compile(
        TENANT_CHECK,
        "UPDATE nullabletexts SET state=:value WHERE id=:id RETURNING state",
        &[("value", LogicalValue::Null), ("id", text("target"))],
    )
    .unwrap_or_else(|error| unreachable!("{error}"));
    assert_eq!(
        plan.client_parameters()
            .get(&ClientParameterName::new("value").unwrap_or_else(|_| unreachable!())),
        Some(&LogicalValue::Null)
    );
    assert!(plan.result()[0].value.nullable);
    let rows = execute(&database, &plan);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][0], SqlValue::Null);
    assert!(check_passed(&rows[0]));
    assert_eq!(storage(&database, "target", "state"), "null");
    // The other tenant's row is untouched by the policy filter.
    assert_eq!(storage(&database, "hidden", "state"), "text");
    // NULL, empty string and a value are distinct and NULL can be re-set.
    for (value, expected) in [
        (text(""), "text"),
        (LogicalValue::Null, "null"),
        (text("x"), "text"),
    ] {
        let plan = compile(
            TENANT_CHECK,
            "UPDATE nullabletexts SET state=:value WHERE id=:id RETURNING state",
            &[("value", value.clone()), ("id", text("target"))],
        )
        .unwrap_or_else(|error| unreachable!("{error}"));
        let rows = execute(&database, &plan);
        assert_eq!(rows[0][0], sql_value(&value));
        assert_eq!(storage(&database, "target", "state"), expected);
    }
}

#[test]
fn every_logical_type_accepts_null_in_direct_nullable_assignments() {
    for (column, logical_type) in TYPED.iter().filter(|(column, _)| *column != "secret") {
        let database = database();
        let update = compile(
            TENANT_CHECK,
            &format!("UPDATE nullabletexts SET {column}=:value WHERE id=:id RETURNING {column}"),
            &[("value", LogicalValue::Null), ("id", text("target"))],
        )
        .unwrap_or_else(|error| unreachable!("{logical_type:?} update: {error}"));
        let rows = execute(&database, &update);
        assert_eq!(rows.len(), 1, "{column}");
        assert_eq!(rows[0][0], SqlValue::Null, "{column}");
        assert!(check_passed(&rows[0]), "{column}");
        assert_eq!(storage(&database, "target", column), "null", "{column}");

        let insert = compile(
            TENANT_CHECK,
            &format!(
                "INSERT INTO nullabletexts (id, label, {column}) VALUES (:id, :label, :value) RETURNING id, {column}, owner"
            ),
            &[
                ("id", text("new")),
                ("label", text("new")),
                ("value", LogicalValue::Null),
            ],
        )
        .unwrap_or_else(|error| unreachable!("{logical_type:?} insert: {error}"));
        let rows = execute(&database, &insert);
        assert_eq!(rows.len(), 1, "{column}");
        assert_eq!(
            rows[0][..3],
            [
                SqlValue::Text("new".to_owned()),
                SqlValue::Null,
                SqlValue::Text("tenant_1".to_owned()),
            ],
            "{column}: NULL stored, server preset still applied"
        );
        assert!(check_passed(&rows[0]), "{column}");
        assert_eq!(storage(&database, "new", column), "null", "{column}");
    }
}

#[test]
fn one_parameter_may_null_several_nullable_columns_across_rows() {
    let database = database();
    let plan = compile(
        TENANT_CHECK,
        "INSERT INTO nullabletexts (id, label, state, meta, payload) VALUES (:a, :l, :v, :v, :v), (:b, :l, :v, :v, :v) RETURNING id, state, meta, payload",
        &[
            ("a", text("row1")),
            ("b", text("row2")),
            ("l", text("x")),
            ("v", LogicalValue::Null),
        ],
    );
    // `:v` is bound with different logical types (string, json, bytes): the
    // existing one-type-per-parameter rule still applies before NULL.
    assert!(plan.is_err(), "{plan:?}");
    let plan = compile(
        TENANT_CHECK,
        "INSERT INTO nullabletexts (id, label, state, due) VALUES (:a, :l, :v, NULL)",
        &[
            ("a", text("row1")),
            ("l", text("x")),
            ("v", LogicalValue::Null),
        ],
    );
    assert!(plan.is_err(), "SQL NULL literals stay outside the subset");
    let plan = compile(
        TENANT_CHECK,
        "UPDATE nullabletexts SET state=:v, secret=:w WHERE id=:id",
        &[
            ("v", LogicalValue::Null),
            ("w", LogicalValue::Null),
            ("id", text("target")),
        ],
    );
    assert!(plan.is_err(), "secret is nullable but not writable");
    let plan = compile(
        TENANT_CHECK,
        "INSERT INTO nullabletexts (id, label, state) VALUES (:a, :l, :v), (:b, :l, :v) RETURNING id, state",
        &[
            ("a", text("row1")),
            ("b", text("row2")),
            ("l", text("x")),
            ("v", LogicalValue::Null),
        ],
    )
    .unwrap_or_else(|error| unreachable!("{error}"));
    let rows = execute(&database, &plan);
    assert_eq!(rows.len(), 2);
    for id in ["row1", "row2"] {
        assert_eq!(storage(&database, id, "state"), "null");
    }
}

#[test]
fn null_is_rejected_outside_direct_nullable_assignments() {
    let null = || LogicalValue::Null;
    for (sql, parameters) in [
        // Non-nullable assignment target.
        (
            "UPDATE nullabletexts SET label=:v WHERE id=:id",
            vec![("v", null()), ("id", text("target"))],
        ),
        (
            "INSERT INTO nullabletexts (id, label) VALUES (:id, :v)",
            vec![("v", null()), ("id", text("new"))],
        ),
        // Shared with a non-nullable assignment.
        (
            "UPDATE nullabletexts SET state=:v, label=:v WHERE id=:id",
            vec![("v", null()), ("id", text("target"))],
        ),
        // Shared with predicates and expressions.
        (
            "UPDATE nullabletexts SET state=:v WHERE state=:v",
            vec![("v", null())],
        ),
        (
            "UPDATE nullabletexts SET state=:v WHERE id IN (:v)",
            vec![("v", null())],
        ),
        (
            "UPDATE nullabletexts SET state=:v WHERE state LIKE :v",
            vec![("v", null())],
        ),
        (
            "UPDATE nullabletexts SET state=:v WHERE lower(:v) = state",
            vec![("v", null())],
        ),
        // The key column of a NULL write is never itself NULL-able.
        (
            "UPDATE nullabletexts SET state=:v WHERE id=:id",
            vec![("v", null()), ("id", null())],
        ),
        // Forbidden and server-owned columns.
        (
            "UPDATE nullabletexts SET secret=:v WHERE id=:id",
            vec![("v", null()), ("id", text("target"))],
        ),
        (
            "UPDATE nullabletexts SET owner=:v WHERE id=:id",
            vec![("v", null()), ("id", text("target"))],
        ),
        (
            "INSERT INTO nullabletexts (id, label, owner) VALUES (:id, :l, :v)",
            vec![("v", null()), ("id", text("new")), ("l", text("x"))],
        ),
        (
            "UPDATE nullabletexts SET tenant_id=:v WHERE id=:id",
            vec![("v", null()), ("id", text("target"))],
        ),
        // RETURNING a forbidden column fails even though the NULL write is legal.
        (
            "UPDATE nullabletexts SET state=:v WHERE id=:id RETURNING secret",
            vec![("v", null()), ("id", text("target"))],
        ),
    ] {
        let result = compile(TENANT_CHECK, sql, &parameters);
        // Column authorization fails at the policy stage; NULL misuse fails at the
        // sealed-plan boundary with the ordinary parameter type mismatch.
        let stage = if ["secret", "owner", "tenant_id"]
            .iter()
            .any(|column| sql.contains(column))
        {
            "policy:"
        } else {
            "compile: client parameter type mismatch"
        };
        assert!(
            result.as_ref().is_err_and(|error| error.starts_with(stage)),
            "{sql}: {result:?}"
        );
    }
}

#[test]
fn null_cannot_satisfy_a_post_state_check_through_unknown() {
    // Each check is evaluated by SQLite on the NULL-assigned row. Comparisons
    // with NULL are UNKNOWN, and UNKNOWN must fail exactly like FALSE.
    for (check, passes) in [
        (TENANT_CHECK, true),
        ("{ state: { is_null: true } }", true),
        ("{ state: { is_null: false } }", false),
        ("{ state: { eq: keep } }", false),
        ("{ state: { neq: blocked } }", false),
        ("{ not: { state: { eq: blocked } } }", false),
        ("{ state: { not_in: [blocked] } }", false),
        ("{ state: { in: [keep, open] } }", false),
        (
            "{ and: [ { state: { neq: blocked } }, { tenant_id: { eq: { session: tenant_id } } } ] }",
            false,
        ),
        (
            "{ or: [ { state: { neq: blocked } }, { label: { eq: never } } ] }",
            false,
        ),
        (
            "{ not: { or: [ { state: { eq: blocked } }, { label: { eq: never } } ] } }",
            false,
        ),
        (
            "{ or: [ { state: { neq: blocked } }, { tenant_id: { eq: { session: tenant_id } } } ] }",
            true,
        ),
    ] {
        for sql in [
            "UPDATE nullabletexts SET state=:v WHERE id=:id RETURNING state",
            "INSERT INTO nullabletexts (id, label, state) VALUES (:id, :l, :v) RETURNING state",
        ] {
            let database = database();
            let mut parameters = vec![("v", LogicalValue::Null), ("id", text("target"))];
            if sql.starts_with("INSERT") {
                parameters = vec![
                    ("v", LogicalValue::Null),
                    ("id", text("new")),
                    ("l", text("x")),
                ];
            }
            let plan = compile(check, sql, &parameters)
                .unwrap_or_else(|error| unreachable!("{check}: {error}"));
            let rows = execute(&database, &plan);
            assert_eq!(rows.len(), 1, "{check} {sql}");
            assert_eq!(check_passed(&rows[0]), passes, "{check} {sql}: {rows:?}");
            // The check column is never NULL itself: CASE folds UNKNOWN to FALSE.
            assert!(
                matches!(rows[0].last(), Some(SqlValue::Integer(0 | 1))),
                "{check}"
            );
        }
    }
}
