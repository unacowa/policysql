//! Single-pass client parameter analysis (issue #21).
//!
//! These tests pin the conservative nullability proof, prove that request
//! acceptance (exact name set, logical type, column contracts) is unchanged,
//! and that NULL is accepted exactly where the proof holds (issue #20).

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    ClientParameterName, ColumnId, ColumnName, LogicalType, LogicalValue, ResourceId, ResourceName,
    ResultName, RoleName, SnapshotId, TrustedSession, ValueConstraints, ValueDescriptor,
    ValueRepresentation,
};
use policysql_execution::ExecutionLimits;
use policysql_ir::{
    BoundAssignment, BoundColumn, BoundExpr, BoundOrder, BoundProjection, BoundSelect,
    BoundStatement, BoundUpdate, ColumnUsage, SortDirection,
};
use policysql_parser::SqliteFrontend;
use policysql_policy::PolicyBundle;
use policysql_sqlite::{
    CompileError, analyze_client_parameters, compile_verified_delete, compile_verified_insert,
    compile_verified_select, compile_verified_update,
};
use std::collections::{BTreeMap, BTreeSet};

const POLICY: &str = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, name, state, note, amount]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
          allow_aggregations: true
        insert:
          columns: [id, name, state, note, amount]
          presets: { tenant_id: { session: tenant_id } }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name, state, note, amount] }
        update:
          columns: [name, state, note, amount]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name, state, note, amount] }
        delete:
          filter: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id] }
  tasks:
    roles:
      member:
        select:
          columns: [id, project_id, name]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
";

fn snapshot() -> SnapshotId {
    SnapshotId::new("parameter_contracts").unwrap_or_else(|_| unreachable!())
}

fn name(value: &str) -> ClientParameterName {
    ClientParameterName::new(value).unwrap_or_else(|_| unreachable!())
}

fn name_constraint() -> ValueConstraints {
    ValueConstraints {
        min_length: Some(2),
        max_length: Some(4),
        ..ValueConstraints::default()
    }
}

/// `projects` column ids: 1 `id`, 2 `tenant_id`, 3 `name`, 4 `state`, 5 `note`, 6 `amount`.
/// `tasks` columns: `id`, `tenant_id`, `project_id`, `name` (same 2..=4 contract).
fn catalog() -> Catalog {
    let tasks = ResourceDescriptor::new(
        ResourceId::new(2).unwrap_or_else(|_| unreachable!()),
        ResourceName::new("tasks").unwrap_or_else(|_| unreachable!()),
        ["id", "tenant_id", "project_id", "name"].map(|column| {
            (
                ColumnName::new(column).unwrap_or_else(|_| unreachable!()),
                ValueDescriptor {
                    logical_type: LogicalType::String,
                    representation: ValueRepresentation::String,
                    nullable: false,
                    format: None,
                    storage: None,
                    constraints: (column == "name").then(name_constraint),
                    json_schema: None,
                },
            )
        }),
    )
    .unwrap_or_else(|error| unreachable!("fixture resource: {error}"));
    let resource = ResourceDescriptor::new(
        ResourceId::new(1).unwrap_or_else(|_| unreachable!()),
        ResourceName::new("projects").unwrap_or_else(|_| unreachable!()),
        ["id", "tenant_id", "name", "state", "note", "amount"].map(|column| {
            let number = column == "amount";
            (
                ColumnName::new(column).unwrap_or_else(|_| unreachable!()),
                ValueDescriptor {
                    logical_type: if number {
                        LogicalType::Number
                    } else {
                        LogicalType::String
                    },
                    representation: if number {
                        ValueRepresentation::Number
                    } else {
                        ValueRepresentation::String
                    },
                    nullable: matches!(column, "state" | "note" | "amount"),
                    format: None,
                    storage: None,
                    constraints: (column == "name").then(name_constraint),
                    json_schema: None,
                },
            )
        }),
    )
    .unwrap_or_else(|error| unreachable!("fixture resource: {error}"));
    Catalog::new(snapshot(), [resource, tasks]).unwrap_or_else(|_| unreachable!())
}

fn column(id: u32) -> BoundColumn {
    BoundColumn {
        id: ColumnId::new(ResourceId::new(1).unwrap_or_else(|_| unreachable!()), id),
        logical_type: LogicalType::String,
        usage: ColumnUsage::Filter,
    }
}

fn param(value: &str) -> BoundExpr {
    BoundExpr::ClientParameter {
        name: name(value),
        logical_type: LogicalType::String,
    }
}

fn select(predicate: Option<BoundExpr>) -> BoundSelect {
    BoundSelect {
        resource: ResourceId::new(1).unwrap_or_else(|_| unreachable!()),
        alias: None,
        joins: Vec::new(),
        projections: vec![BoundProjection {
            expression: BoundExpr::Column(column(1)),
            output_name: ResultName::new("id").unwrap_or_else(|_| unreachable!()),
        }],
        predicate,
        group_by: Vec::new(),
        having: None,
        order_by: Vec::new(),
        limit: None,
        offset: None,
    }
}

fn nullable_of(statement: &BoundStatement, catalog: &Catalog) -> BTreeMap<String, bool> {
    analyze_client_parameters(statement, catalog)
        .contracts()
        .unwrap_or_else(|_| unreachable!("no type conflict"))
        .iter()
        .map(|(name, contract)| (name.as_str().to_owned(), contract.nullable()))
        .collect()
}

fn bind(sql: &str, catalog: &Catalog) -> BoundStatement {
    SqliteFrontend::default()
        .bind(sql, catalog)
        .unwrap_or_else(|error| unreachable!("{sql}: {error}"))
}

#[test]
fn only_direct_assignments_to_nullable_columns_are_nullable() {
    let catalog = catalog();
    for (sql, expected) in [
        // Direct assignment to a nullable column.
        ("UPDATE projects SET state=:v", vec![("v", true)]),
        (
            "INSERT INTO projects (id, state) VALUES (:id, :v)",
            vec![("id", false), ("v", true)],
        ),
        ("UPDATE projects SET state=:v, note=:v", vec![("v", true)]),
        // Assignment to a non-nullable column.
        ("UPDATE projects SET name=:v", vec![("v", false)]),
        ("UPDATE projects SET state=:v, name=:v", vec![("v", false)]),
        // Same parameter in a nullable assignment and a predicate.
        (
            "UPDATE projects SET state=:v WHERE state=:v",
            vec![("v", false)],
        ),
        (
            "UPDATE projects SET state=:v WHERE state LIKE :v",
            vec![("v", false)],
        ),
        (
            "UPDATE projects SET state=:v WHERE id IN (:v)",
            vec![("v", false)],
        ),
        // Predicate positions.
        ("SELECT id FROM projects WHERE state=:v", vec![("v", false)]),
        (
            "SELECT id FROM projects WHERE state<>:v",
            vec![("v", false)],
        ),
        ("SELECT id FROM projects WHERE state<:v", vec![("v", false)]),
        (
            "SELECT id FROM projects WHERE state>=:v",
            vec![("v", false)],
        ),
        (
            "SELECT id FROM projects WHERE state LIKE :v",
            vec![("v", false)],
        ),
        (
            "SELECT id FROM projects WHERE state GLOB :v",
            vec![("v", false)],
        ),
        (
            "SELECT id FROM projects WHERE state IN (:v, :w)",
            vec![("v", false), ("w", false)],
        ),
        (
            "SELECT id FROM projects WHERE state NOT IN (:v)",
            vec![("v", false)],
        ),
        (
            "SELECT id FROM projects WHERE lower(:v) = state",
            vec![("v", false)],
        ),
        (
            "SELECT CASE WHEN state=:v THEN name ELSE note END AS c FROM projects",
            vec![("v", false)],
        ),
        (
            "SELECT lower(:v) AS l FROM projects ORDER BY l",
            vec![("v", false)],
        ),
        (
            "SELECT id FROM projects LIMIT :n OFFSET :m",
            vec![("m", false), ("n", false)],
        ),
        ("DELETE FROM projects WHERE state=:v", vec![("v", false)]),
    ] {
        let statement = bind(sql, &catalog);
        let expected = expected
            .into_iter()
            .map(|(name, nullable)| (name.to_owned(), nullable))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(nullable_of(&statement, &catalog), expected, "{sql}");
    }
}

#[test]
fn unbindable_surfaces_stay_closed_at_the_binder() {
    let catalog = catalog();
    for sql in [
        "SELECT id FROM projects WHERE length(:v) > 0",
        "SELECT id FROM projects ORDER BY :v",
    ] {
        assert!(
            SqliteFrontend::default().bind(sql, &catalog).is_err(),
            "{sql}"
        );
    }
}

#[test]
fn every_non_assignment_ir_position_is_non_nullable() {
    // Hand-built IR covers positions the current binder never produces, so the
    // proof stays default-deny independently of binder restrictions.
    let catalog = catalog();
    let v = || param("v");
    let state = || BoundExpr::Column(column(4));
    let assignment = |value: BoundExpr| BoundAssignment {
        column: column(4),
        value,
    };
    let update = |assignments: Vec<BoundAssignment>, predicate: Option<BoundExpr>| {
        BoundStatement::Update(BoundUpdate {
            resource: ResourceId::new(1).unwrap_or_else(|_| unreachable!()),
            assignments,
            predicate,
            returning: Vec::new(),
        })
    };
    let mut ordered = select(None);
    ordered.order_by.push(BoundOrder {
        expression: v(),
        direction: SortDirection::Ascending,
    });
    let mut limited = select(None);
    limited.limit = Some(v());
    let mut offset = select(None);
    offset.offset = Some(v());
    let mut projected = select(None);
    projected.projections[0].expression = v();
    let mut having = select(None);
    having.having = Some(BoundExpr::Equal(Box::new(state()), Box::new(v())));
    let statements = [
        BoundStatement::Select(Box::new(ordered)),
        BoundStatement::Select(Box::new(limited)),
        BoundStatement::Select(Box::new(offset)),
        BoundStatement::Select(Box::new(projected)),
        BoundStatement::Select(Box::new(having)),
        BoundStatement::Select(Box::new(select(Some(BoundExpr::IsNull(Box::new(v())))))),
        BoundStatement::Select(Box::new(select(Some(BoundExpr::Not(Box::new(v())))))),
        BoundStatement::Select(Box::new(select(Some(BoundExpr::Exists(Box::new(select(
            Some(BoundExpr::Equal(Box::new(state()), Box::new(v()))),
        ))))))),
        // A nullable assignment whose value is not the bare parameter.
        update(vec![assignment(BoundExpr::CastText(Box::new(v())))], None),
        update(
            vec![assignment(BoundExpr::Concat(
                Box::new(state()),
                Box::new(v()),
            ))],
            None,
        ),
        update(
            vec![assignment(BoundExpr::Case {
                branches: vec![(state(), v())],
                else_expression: None,
                logical_type: LogicalType::String,
            })],
            None,
        ),
        // Nullable assignment plus `:v IS NULL` in the predicate.
        update(
            vec![assignment(v())],
            Some(BoundExpr::IsNull(Box::new(v()))),
        ),
    ];
    for statement in &statements {
        assert_eq!(
            nullable_of(statement, &catalog),
            BTreeMap::from([("v".to_owned(), false)]),
            "{statement:?}"
        );
    }

    // An assignment to a column identity missing from the Catalog is never nullable.
    let mut unknown = column(4);
    unknown.id = ColumnId::new(ResourceId::new(1).unwrap_or_else(|_| unreachable!()), 99);
    let statement = update(
        vec![BoundAssignment {
            column: unknown,
            value: v(),
        }],
        None,
    );
    assert_eq!(
        nullable_of(&statement, &catalog),
        BTreeMap::from([("v".to_owned(), false)])
    );
    assert_eq!(
        nullable_of(&update(vec![assignment(v())], None), &catalog),
        BTreeMap::from([("v".to_owned(), true)])
    );
}

#[test]
fn analysis_reports_types_constraints_and_conflicts() {
    let catalog = catalog();
    let statement = bind(
        "SELECT id FROM projects WHERE name=:v AND amount > :n LIMIT :limit",
        &catalog,
    );
    let analysis = analyze_client_parameters(&statement, &catalog);
    assert_eq!(
        analysis.names(),
        BTreeSet::from([name("limit"), name("n"), name("v")])
    );
    let contracts = analysis.contracts().unwrap_or_else(|_| unreachable!());
    assert_eq!(contracts[&name("v")].logical_type(), LogicalType::String);
    assert_eq!(contracts[&name("n")].logical_type(), LogicalType::Number);
    assert_eq!(contracts[&name("v")].constraining_columns().len(), 1);
    assert_eq!(
        contracts[&name("limit")].constraining_columns(),
        &[] as &[BoundColumn]
    );

    // One entry per column identity even when usages differ (write vs filter).
    for (sql, expected) in [
        ("UPDATE projects SET name=:v WHERE name=:v", 1),
        (
            "UPDATE projects SET name=:v WHERE name=:v OR name IN (:v)",
            1,
        ),
        ("UPDATE projects SET name=:v WHERE id=:v", 2),
    ] {
        let statement = bind(sql, &catalog);
        let analysis = analyze_client_parameters(&statement, &catalog);
        let contracts = analysis.contracts().unwrap_or_else(|_| unreachable!());
        let columns = contracts[&name("v")].constraining_columns();
        assert_eq!(columns.len(), expected, "{sql}: {columns:?}");
        let ids = columns
            .iter()
            .map(|column| column.id)
            .collect::<BTreeSet<_>>();
        assert_eq!(ids.len(), columns.len(), "{sql}");
    }

    let conflicting = BoundStatement::Select(Box::new(select(Some(BoundExpr::And(
        Box::new(BoundExpr::Equal(
            Box::new(BoundExpr::Column(column(4))),
            Box::new(param("v")),
        )),
        Box::new(BoundExpr::Greater(
            Box::new(BoundExpr::Column(column(6))),
            Box::new(BoundExpr::ClientParameter {
                name: name("v"),
                logical_type: LogicalType::Number,
            }),
        )),
    )))));
    let analysis = analyze_client_parameters(&conflicting, &catalog);
    assert!(analysis.contracts().is_err());
    assert_eq!(analysis.names(), BTreeSet::from([name("v")]));
}

fn compile(
    sql: &str,
    parameters: &[(&str, LogicalValue)],
) -> Result<policysql_execution::VerifiedExecutionPlan<policysql_sqlite::SqliteProfile>, CompileError>
{
    let catalog = catalog();
    let policy = PolicyBundle::activate(POLICY, &catalog, snapshot())
        .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
    let session = TrustedSession::new(
        RoleName::new("member").unwrap_or_else(|_| unreachable!()),
        "user",
        BTreeMap::from([("tenant_id".to_owned(), "tenant_a".to_owned())]),
    )
    .unwrap_or_else(|_| unreachable!());
    let statement = bind(sql, &catalog);
    let output = match &statement {
        BoundStatement::Insert(_) => policy.compile_insert(&statement, &session),
        BoundStatement::Update(_) => policy.compile_update(&statement, &session),
        BoundStatement::Delete(_) => policy.compile_delete(&statement, &session),
        _ => policy.compile_select(&statement, &session),
    }
    .unwrap_or_else(|error| unreachable!("{sql}: {error}"));
    let parameters = parameters
        .iter()
        .map(|(key, value)| (name(key), value.clone()))
        .collect();
    let limits = ExecutionLimits {
        max_rows: 100,
        max_result_bytes: 64_000,
        timeout_ms: 1_000,
        max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
    };
    let compile = match &statement {
        BoundStatement::Insert(_) => compile_verified_insert,
        BoundStatement::Update(_) => compile_verified_update,
        BoundStatement::Delete(_) => compile_verified_delete,
        _ => compile_verified_select,
    };
    compile(&output.plan, &catalog, parameters, limits, snapshot())
}

fn text(value: &str) -> LogicalValue {
    LogicalValue::String(value.to_owned())
}

#[test]
fn null_is_accepted_exactly_where_the_proof_allows_it() {
    // Acceptance must never diverge from the proof Explain reports (#20).
    let catalog = catalog();
    for sql in [
        "UPDATE projects SET state=:v",
        "UPDATE projects SET state=:v, note=:v",
        "INSERT INTO projects (id, name, state) VALUES ('p1', 'abc', :v)",
        "INSERT INTO projects (id, name, state, note) VALUES ('p1', 'abc', :v, :v), ('p2', 'abd', :v, :v)",
        "UPDATE projects SET state=:v WHERE state=:v",
        "UPDATE projects SET state=:v WHERE state LIKE :v",
        "UPDATE projects SET state=:v WHERE note IN (:v)",
        "UPDATE projects SET state=:v WHERE lower(:v) = note",
        "UPDATE projects SET state=:v, name=:v",
        "UPDATE projects SET name=:v",
        "INSERT INTO projects (id, name) VALUES ('p1', :v)",
        "SELECT id FROM projects WHERE state=:v",
        "SELECT id FROM projects WHERE state IN (:v)",
        "SELECT id FROM projects WHERE lower(:v) = state",
        "DELETE FROM projects WHERE state=:v",
    ] {
        let proven = nullable_of(&bind(sql, &catalog), &catalog)["v"];
        let result = compile(sql, &[("v", LogicalValue::Null)]);
        assert_eq!(result.is_ok(), proven, "{sql}: {result:?}");
        match result {
            Ok(plan) => assert_eq!(
                plan.client_parameters().get(&name("v")),
                Some(&LogicalValue::Null),
                "{sql}"
            ),
            Err(error) => assert!(
                matches!(error, CompileError::ClientParameterTypeMismatch),
                "{sql}: same error as any other type mismatch"
            ),
        }
    }
    // A nullable parameter still type-checks non-NULL values.
    assert!(matches!(
        compile("UPDATE projects SET amount=:v", &[("v", text("1"))]),
        Err(CompileError::ClientParameterTypeMismatch)
    ));
    assert!(
        compile(
            "UPDATE projects SET amount=:v",
            &[("v", LogicalValue::Null)]
        )
        .is_ok()
    );
}

#[test]
fn acceptance_regressions_are_unchanged() {
    // Exact name set.
    assert!(matches!(
        compile("SELECT id FROM projects WHERE state=:v", &[]),
        Err(CompileError::ClientParameterMismatch)
    ));
    assert!(matches!(
        compile(
            "SELECT id FROM projects WHERE state=:v",
            &[("v", text("a")), ("extra", text("b"))]
        ),
        Err(CompileError::ClientParameterMismatch)
    ));
    // Logical type.
    assert!(matches!(
        compile(
            "SELECT id FROM projects WHERE amount > :n",
            &[("n", text("1"))]
        ),
        Err(CompileError::ClientParameterTypeMismatch)
    ));
    assert!(
        compile(
            "SELECT id FROM projects WHERE amount > :n",
            &[("n", LogicalValue::Number(1.5))]
        )
        .is_ok()
    );
    // Column contract (name: 2..=4 characters) at comparisons, IN lists and assignments.
    for sql in [
        "SELECT id FROM projects WHERE name=:v",
        "SELECT id FROM projects WHERE :v=name",
        "SELECT id FROM projects WHERE name LIKE :v",
        "SELECT id FROM projects WHERE name IN (:v)",
        "UPDATE projects SET name=:v",
        "INSERT INTO projects (id, name) VALUES ('p1', :v)",
        "DELETE FROM projects WHERE name=:v",
        "SELECT p.id FROM projects p WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.name = :v)",
        "SELECT p.id FROM projects p JOIN tasks t ON t.project_id = p.id AND t.name = :v",
        "SELECT p.id FROM projects p LEFT JOIN tasks t ON t.project_id = p.id AND :v = t.name",
        "SELECT name, COUNT(*) AS c FROM projects GROUP BY name HAVING name = :v",
    ] {
        for (value, accepted) in [("a", false), ("abc", true), ("abcde", false)] {
            let result = compile(sql, &[("v", text(value))]);
            assert_eq!(result.is_ok(), accepted, "{sql} {value}: {result:?}");
            if !accepted {
                assert!(
                    matches!(result, Err(CompileError::ClientParameterTypeMismatch)),
                    "{sql} {value}"
                );
            }
        }
    }
    // Non column-adjacent positions are type-checked but not column-constrained.
    assert!(
        compile(
            "SELECT id FROM projects WHERE lower(:v) = name",
            &[("v", text("a"))]
        )
        .is_ok()
    );
    // Shared parameter intersects every column contract.
    assert!(matches!(
        compile(
            "UPDATE projects SET state=:v WHERE name=:v",
            &[("v", text("abcdef"))]
        ),
        Err(CompileError::ClientParameterTypeMismatch)
    ));
    assert!(
        compile(
            "UPDATE projects SET state=:v WHERE name=:v",
            &[("v", text("abc"))]
        )
        .is_ok()
    );
}
