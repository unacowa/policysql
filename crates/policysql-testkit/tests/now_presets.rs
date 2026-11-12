//! The compile's time as a preset value (ADR 0031) against an independent SQLite.
//!
//! The spellings of `policysql_core::time` are compared with SQLite's own calendar over the
//! boundary instants and 10,000 pseudo-random ones; a multi-row INSERT and an UPDATE then run
//! through the binder, the policy compiler and the sealed plan, execute on STRICT tables, and
//! their stored values, `RETURNING` rows and storage classes are read back.

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    ClientParameterName, ColumnName, CompileContext, LogicalType, LogicalValue,
    MAX_COMPILE_TIME_MS, ResourceId, ResourceName, RoleName, SnapshotId, TrustedSession,
    ValueDescriptor, ValueRepresentation,
};
use policysql_execution::{ExecutionLimits, VerifiedExecutionPlan};
use policysql_parser::SqliteFrontend;
use policysql_policy::PolicyBundle;
use policysql_sqlite::{SqliteProfile, compile_verified_insert, compile_verified_update};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use std::collections::BTreeMap;

const BOUNDARIES: [u64; 8] = [
    0,
    946_684_799_999,
    951_782_400_000,
    1_709_164_800_000,
    1_793_366_096_789,
    4_102_444_800_000,
    4_107_542_399_999,
    MAX_COMPILE_TIME_MS,
];

const SCHEMA: &str = "CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  touched_on TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
) STRICT;
INSERT INTO projects VALUES
  ('p1', 'tenant_1', 'Old', 'old', '2000-01-01T00:00:00.000Z', '2000-01-01 00:00:00', 0),
  ('p2', 'tenant_2', 'Hidden', 'other', '2000-01-01T00:00:00.000Z', '2000-01-01 00:00:00', 0);";

const POLICY: &str = "version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, name, updated_at, touched_on, updated_ms]
          filter: { tenant_id: { eq: { session: tenant_id } } }
        insert:
          columns: [id, name]
          presets:
            tenant_id: { session: tenant_id }
            updated_by: { session: subject_id }
            updated_at: { now: {} }
            touched_on: { now: {} }
            updated_ms: { now: {} }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name, updated_at] }
        update:
          columns: [name]
          presets:
            updated_by: { session: subject_id }
            updated_at: { now: {} }
            touched_on: { now: {} }
            updated_ms: { now: {} }
          filter: { tenant_id: { eq: { session: tenant_id } } }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name, updated_at, touched_on, updated_ms] }
";

fn snapshot() -> SnapshotId {
    SnapshotId::new("now_presets").unwrap_or_else(|_| unreachable!())
}

fn descriptor(logical_type: LogicalType, format: Option<&str>) -> ValueDescriptor {
    ValueDescriptor {
        logical_type,
        representation: ValueRepresentation::String,
        nullable: false,
        format: format.map(str::to_owned),
        storage: None,
        constraints: None,
        json_schema: None,
    }
}

fn catalog() -> Catalog {
    let string = || descriptor(LogicalType::String, None);
    let columns = [
        ("id", string()),
        ("tenant_id", string()),
        ("name", string()),
        ("updated_by", string()),
        (
            "updated_at",
            descriptor(LogicalType::Instant, Some("rfc3339")),
        ),
        (
            "touched_on",
            descriptor(LogicalType::DateTime, Some("sqlite-datetime")),
        ),
        ("updated_ms", descriptor(LogicalType::Int64, None)),
    ];
    let resource = ResourceDescriptor::new(
        ResourceId::new(1).unwrap_or_else(|_| unreachable!()),
        ResourceName::new("projects").unwrap_or_else(|_| unreachable!()),
        columns.map(|(name, value)| {
            (
                ColumnName::new(name).unwrap_or_else(|_| unreachable!()),
                value,
            )
        }),
    )
    .unwrap_or_else(|error| unreachable!("fixture resource: {error}"));
    Catalog::new(snapshot(), [resource]).unwrap_or_else(|_| unreachable!())
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

fn compile(
    sql: &str,
    parameters: &[(&str, &str)],
    now_ms: u64,
) -> VerifiedExecutionPlan<SqliteProfile> {
    let catalog = catalog();
    let bundle = PolicyBundle::activate(POLICY, &catalog, snapshot())
        .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
    let statement = SqliteFrontend::default()
        .bind(sql, &catalog)
        .unwrap_or_else(|error| unreachable!("{sql} binds: {error}"));
    let context = CompileContext::new(now_ms).unwrap_or_else(|| unreachable!("in range"));
    let insert = sql.starts_with("INSERT");
    let output = if insert {
        bundle.compile_insert(&statement, &session(), &context)
    } else {
        bundle.compile_update(&statement, &session(), &context)
    }
    .unwrap_or_else(|error| unreachable!("{sql} compiles: {error}"));
    let parameters = parameters
        .iter()
        .map(|(name, value)| {
            (
                ClientParameterName::new(*name).unwrap_or_else(|_| unreachable!()),
                text(value),
            )
        })
        .collect();
    let limits = ExecutionLimits {
        max_rows: 100,
        max_result_bytes: 64_000,
        timeout_ms: 1_000,
        max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
    };
    let seal = if insert {
        compile_verified_insert
    } else {
        compile_verified_update
    };
    seal(&output.plan, &catalog, parameters, limits, snapshot())
        .unwrap_or_else(|error| unreachable!("{sql} seals: {error}"))
}

fn sql_value(value: &LogicalValue) -> SqlValue {
    match value {
        LogicalValue::String(value) => SqlValue::Text(value.clone()),
        LogicalValue::Int64(value) => SqlValue::Integer(*value),
        other => unreachable!("unexpected parameter {other:?}"),
    }
}

/// Executes the sealed protected SQL exactly as emitted and returns every physical row.
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

fn sqlite_spellings(database: &Connection, ms: u64) -> (String, String) {
    let ms = i64::try_from(ms).unwrap_or(i64::MAX);
    database
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%S', ?1 / 1000, 'unixepoch') || printf('.%03dZ', ?1 % 1000), \
             datetime(?1 / 1000, 'unixepoch')",
            [ms],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or_else(|error| unreachable!("SQLite spells the time: {error}"))
}

#[test]
fn the_spellings_are_sqlites_own_calendar_over_the_boundaries_and_a_pseudo_random_sample() {
    let database = Connection::open_in_memory().unwrap_or_else(|_| unreachable!());
    let mut sample = BOUNDARIES.to_vec();
    // A linear congruential generator from a fixed seed: the sample is the same on every run.
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    for _ in 0..10_000 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        sample.push((state >> 11) % (MAX_COMPILE_TIME_MS + 1));
    }
    for ms in sample {
        let (rfc3339, datetime) = sqlite_spellings(&database, ms);
        assert_eq!(policysql_core::time::rfc3339_millis(ms), rfc3339, "{ms}");
        assert_eq!(policysql_core::time::sqlite_datetime(ms), datetime, "{ms}");
    }
}

#[test]
fn a_multi_row_insert_stores_one_time_in_every_row_with_the_right_storage_classes() {
    let now_ms = 1_793_366_096_789;
    let database = database();
    let plan = compile(
        "INSERT INTO projects (id, name) VALUES (:id, :name), (:id2, :name) RETURNING id, name, updated_at",
        &[("id", "p8"), ("id2", "p9"), ("name", "New")],
        now_ms,
    );
    assert_eq!(
        plan.protected_sql(),
        "INSERT INTO \"projects\" (\"id\", \"name\", \"tenant_id\", \"updated_by\", \"updated_at\", \"touched_on\", \"updated_ms\") VALUES (:id, :name, :__policysql_session_tenant_id, :__policysql_session_subject_id, :__policysql_now_rfc3339, :__policysql_now_sqlite_datetime, :__policysql_now_epoch_ms), (:id2, :name, :__policysql_session_tenant_id, :__policysql_session_subject_id, :__policysql_now_rfc3339, :__policysql_now_sqlite_datetime, :__policysql_now_epoch_ms) RETURNING \"id\" AS \"id\", \"name\" AS \"name\", \"updated_at\" AS \"updated_at\", CASE WHEN (\"tenant_id\" = :__policysql_session_tenant_id) THEN TRUE ELSE FALSE END AS \"__policysql_check\""
    );
    let rows = execute(&database, &plan);
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert_eq!(
            row[2],
            SqlValue::Text("2026-10-30T13:14:56.789Z".to_owned())
        );
        assert_eq!(row[3], SqlValue::Integer(1));
    }
    let stored: Vec<(String, String, i64, String)> = database
        .prepare(
            "SELECT updated_at, touched_on, updated_ms, typeof(updated_ms) FROM projects WHERE id IN ('p8', 'p9')",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect()
        })
        .unwrap_or_else(|error| unreachable!("stored rows: {error}"));
    assert_eq!(
        stored,
        vec![
            (
                "2026-10-30T13:14:56.789Z".to_owned(),
                "2026-10-30 13:14:56".to_owned(),
                1_793_366_096_789,
                "integer".to_owned()
            );
            2
        ]
    );
}

#[test]
fn an_update_stores_the_time_and_leaves_the_other_tenants_row_alone() {
    let database = database();
    for now_ms in [0, 1_793_366_096_789, MAX_COMPILE_TIME_MS] {
        let plan = compile(
            "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name, updated_at, touched_on, updated_ms",
            &[("id", "p1"), ("name", "Renamed")],
            now_ms,
        );
        let rows = execute(&database, &plan);
        assert_eq!(rows.len(), 1);
        let (rfc3339, datetime) = sqlite_spellings(&database, now_ms);
        assert_eq!(rows[0][2], SqlValue::Text(rfc3339));
        assert_eq!(rows[0][3], SqlValue::Text(datetime));
        assert_eq!(
            rows[0][4],
            SqlValue::Integer(i64::try_from(now_ms).unwrap_or(i64::MAX))
        );
    }
    // The other tenant's row is the seed's.
    let hidden: (String, String, i64) = database
        .query_row(
            "SELECT name, updated_at, updated_ms FROM projects WHERE id = 'p2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap_or_else(|error| unreachable!("hidden row: {error}"));
    assert_eq!(
        hidden,
        (
            "Hidden".to_owned(),
            "2000-01-01T00:00:00.000Z".to_owned(),
            0
        )
    );
    // Time order is text order for both spellings and numeric order for the epoch.
    let ordered = |column: &str| -> Vec<String> {
        database
            .prepare(&format!("SELECT id FROM projects ORDER BY {column}, id"))
            .and_then(|mut statement| statement.query_map([], |row| row.get(0))?.collect())
            .unwrap_or_else(|error| unreachable!("ordered rows: {error}"))
    };
    assert_eq!(ordered("updated_at"), ordered("updated_ms"));
    assert_eq!(ordered("touched_on"), ordered("updated_ms"));
}
