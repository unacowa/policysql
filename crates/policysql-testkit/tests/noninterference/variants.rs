//! Low-equivalent database variants and the checks that make them trustworthy.
//!
//! Two databases are low-equivalent when their visible views are equal. The view is computed here
//! with hand-written SQL (`filter_sql`, `visible_if_sql`), never through the compiler, so a
//! compiler bug cannot hide in the premise. `policy_mirror_matches_compiler` separately pins the
//! hand-written SQL to the YAML.

use crate::policies::{PolicyCase, RESOURCES, ResourcePolicy, conditional_column, regular_columns};
use crate::world::{BASE, SCHEMA};
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use std::fmt::Write as _;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Db {
    Base,
    Col,
    Row,
    Cond,
}

pub const DBS: [Db; 4] = [Db::Base, Db::Col, Db::Row, Db::Cond];

impl Db {
    pub fn index(self) -> usize {
        match self {
            Self::Base => 0,
            Self::Col => 1,
            Self::Row => 2,
            Self::Cond => 3,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Col => "col",
            Self::Row => "row",
            Self::Cond => "cond",
        }
    }
}

fn is_int(resource: &str, column: &str) -> bool {
    resource == "tags" && column == "rank"
}

fn perturb(resource: &str, column: &str) -> String {
    if is_int(resource, column) {
        format!("(({column} + 1) % 3)")
    } else {
        format!(
            "CASE {column} WHEN 'a' THEN 'b' WHEN 'b' THEN 'a' WHEN 'x' THEN 'y' WHEN 'y' THEN 'x' ELSE 'a' END"
        )
    }
}

fn truthy(sql: &str) -> String {
    format!("COALESCE(({sql}), 0)")
}

/// The statements that turn the base data into the variant (empty for `Base`).
pub fn variant_sql(case: &PolicyCase, db: Db) -> String {
    let mut out = String::new();
    match db {
        Db::Base => {}
        Db::Col => {
            for table in RESOURCES {
                let _ = writeln!(
                    out,
                    "UPDATE {table} SET secret = CASE secret WHEN 'x' THEN 'y' WHEN 'y' THEN 'x' ELSE 'x' END;"
                );
            }
            out.push_str(case.variant.col_extra);
        }
        Db::Row => {
            for (index, table) in RESOURCES.iter().enumerate() {
                let assignments: Vec<String> = case.variant.free[index]
                    .iter()
                    .map(|column| format!("{column} = {}", perturb(table, column)))
                    .collect();
                let _ = writeln!(
                    out,
                    "UPDATE {table} SET {} WHERE NOT {};",
                    assignments.join(", "),
                    truthy(case.resources[index].filter_sql)
                );
            }
            out.push_str(case.variant.row_insert);
        }
        Db::Cond => {
            for (index, table) in RESOURCES.iter().enumerate() {
                let column = conditional_column(index);
                let policy = &case.resources[index];
                let _ = writeln!(
                    out,
                    "UPDATE {table} SET {column} = {} WHERE {} AND NOT {};",
                    perturb(table, column),
                    truthy(policy.filter_sql),
                    truthy(policy.visible_if_sql)
                );
            }
        }
    }
    out
}

/// The SQL that builds a variant database: schema, base data, variant statements.
pub fn setup_sql(case: &PolicyCase, db: Db) -> String {
    format!("{BASE}\n{}", variant_sql(case, db))
}

/// A fresh in-memory database for one variant.
pub fn connection(case: &PolicyCase, db: Db) -> Connection {
    let conn = Connection::open_in_memory()
        .unwrap_or_else(|error| unreachable!("open in-memory database: {error}"));
    conn.execute_batch(SCHEMA)
        .unwrap_or_else(|error| unreachable!("schema: {error}"));
    conn.execute_batch(&setup_sql(case, db))
        .unwrap_or_else(|error| unreachable!("variant {} of {}: {error}", db.name(), case.name));
    conn
}

/// The visible view of one table: regular columns, the conditional column with `NULL` where it is
/// hidden, and the visibility mark. Rows in insertion order.
pub fn view_sql(resource: usize, policy: &ResourcePolicy, order: &str) -> String {
    let regular = regular_columns(resource).join(", ");
    let conditional = conditional_column(resource);
    let visible = truthy(policy.visible_if_sql);
    format!(
        "SELECT {regular}, CASE WHEN {visible} THEN {conditional} END, {visible} FROM {} WHERE {} ORDER BY {order}",
        policy.resource,
        truthy(policy.filter_sql)
    )
}

fn render_row(row: &rusqlite::Row<'_>, columns: usize) -> String {
    (0..columns)
        .map(|index| match row.get_ref(index) {
            Ok(value) => format_value(value),
            Err(error) => unreachable!("read column {index}: {error}"),
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// A readable, unambiguous rendering of one value (the `Debug` of `ValueRef` prints text as bytes).
pub fn format_value(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "NULL".to_owned(),
        ValueRef::Integer(value) => value.to_string(),
        ValueRef::Real(value) => format!("{value:?}"),
        ValueRef::Text(value) => format!("'{}'", String::from_utf8_lossy(value)),
        ValueRef::Blob(value) => format!("x'{value:02x?}'"),
    }
}

/// Runs a query and renders each row as one string.
pub fn query_rows(conn: &Connection, sql: &str) -> Vec<String> {
    let mut statement = conn
        .prepare(sql)
        .unwrap_or_else(|error| unreachable!("prepare {sql}: {error}"));
    let columns = statement.column_count();
    let mut rows = statement
        .query([])
        .unwrap_or_else(|error| unreachable!("query {sql}: {error}"));
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .unwrap_or_else(|error| unreachable!("step {sql}: {error}"))
    {
        out.push(render_row(row, columns));
    }
    out
}

/// The visible view of every table, one `Vec` of rendered rows per table.
pub fn views(conn: &Connection, case: &PolicyCase) -> Vec<Vec<String>> {
    case.resources
        .iter()
        .enumerate()
        .map(|(index, policy)| query_rows(conn, &view_sql(index, policy, "rowid")))
        .collect()
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0))
        .unwrap_or_else(|error| unreachable!("count {sql}: {error}"))
}

/// Asserts everything spec 6.3 asks for. Panics (fails the test) with the reason.
pub fn assert_variants_low_equivalent(case: &PolicyCase, conns: &[Connection; 4]) {
    let base_views = views(&conns[0], case);
    // 4. Something is visible, something is hidden, in every table.
    for (index, policy) in case.resources.iter().enumerate() {
        let table = policy.resource;
        let total = base_views[index].len();
        assert!(total >= 1, "{}: {table} has no visible row", case.name);
        let visible_true = count(
            &conns[0],
            &format!(
                "SELECT count(*) FROM {table} WHERE {} AND {}",
                truthy(policy.filter_sql),
                truthy(policy.visible_if_sql)
            ),
        );
        let visible_false = count(
            &conns[0],
            &format!(
                "SELECT count(*) FROM {table} WHERE {} AND NOT {}",
                truthy(policy.filter_sql),
                truthy(policy.visible_if_sql)
            ),
        );
        assert!(
            visible_true >= 1 && visible_false >= 1,
            "{}: {table} needs visible rows with visible_if true ({visible_true}) and false ({visible_false})",
            case.name
        );
    }
    for db in &DBS[1..] {
        let conn = &conns[db.index()];
        // 1. The views are equal.
        let views = views(conn, case);
        for (index, policy) in case.resources.iter().enumerate() {
            assert_eq!(
                views[index],
                base_views[index],
                "{}: view of {} differs between base and {}",
                case.name,
                policy.resource,
                db.name()
            );
        }
        // 2. The variant is not empty: the raw data differs in every table.
        for (index, policy) in case.resources.iter().enumerate() {
            let table = policy.resource;
            let raw = format!("SELECT * FROM {table} ORDER BY rowid");
            assert_ne!(
                query_rows(conn, &raw),
                query_rows(&conns[0], &raw),
                "{}: variant {} does not change {table}",
                case.name,
                db.name()
            );
            if *db == Db::Cond {
                let conditional = format!(
                    "SELECT id, {} FROM {table} WHERE {} ORDER BY rowid",
                    conditional_column(index),
                    truthy(policy.filter_sql)
                );
                assert_ne!(
                    query_rows(conn, &conditional),
                    query_rows(&conns[0], &conditional),
                    "{}: cond does not change a visible conditional value of {table}",
                    case.name
                );
            }
        }
    }
    // 3. P3 precondition: every row a mutation filter selects is select-visible, in every DB.
    if case.mutation_filter_is_select_filter {
        for (db, conn) in DBS.iter().zip(conns) {
            for policy in case.resources.iter().filter(|p| p.mutation) {
                let wider = count(
                    conn,
                    &format!(
                        "SELECT count(*) FROM {} WHERE {} AND NOT {}",
                        policy.resource,
                        truthy(policy.mutation_filter_sql()),
                        truthy(policy.filter_sql)
                    ),
                );
                assert_eq!(
                    wider,
                    0,
                    "{}: mutation filter of {} is wider than the select filter in {}",
                    case.name,
                    policy.resource,
                    db.name()
                );
            }
        }
    }
}

/// Builds the four connections of a case.
pub fn connections(case: &PolicyCase) -> [Connection; 4] {
    DBS.map(|db| connection(case, db))
}
