//! The production pipeline for one generated statement, run against the four databases of a case:
//! bind, policy compile, verified emission (which re-parses and re-checks the emitted SQL), then
//! execution. Nothing here builds IR by hand; the only way to alter a plan is the explicit
//! `Tamper` hook, which only the planted-defect tests use.

use crate::policies::{GateFlags, GateOff, PolicyCase, gate_variants, render_yaml};
use crate::variants::{
    DBS, Db, assert_variants_low_equivalent, connections, format_value, setup_sql, views,
};
use crate::world::{SCHEMA, World};
use policysql_core::{ClientParameterName, LogicalValue};
use policysql_execution::VerifiedExecutionPlan;
use policysql_ir::{BoundStatement, ProtectedPlan};
use policysql_parser::SqliteFrontend;
use policysql_policy::PolicyBundle;
use policysql_sqlite::{
    SqliteProfile, compile_verified_delete, compile_verified_select, compile_verified_update,
};
use policysql_testkit::ReferenceSqlite;
use policysql_testkit::fuzz::ast::{Lit, Statement};
use policysql_testkit::fuzz::meta::{StatementKind, StatementMeta, meta};
use policysql_testkit::fuzz::{Alphabet, render};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use std::collections::BTreeMap;

/// A statement together with everything derived from it.
#[derive(Debug)]
pub struct Generated {
    pub sql: String,
    pub params: BTreeMap<ClientParameterName, LogicalValue>,
    pub meta: StatementMeta,
}

impl Generated {
    pub fn new(statement: &Statement, alphabet: &Alphabet) -> Self {
        let (sql, parameters) = render::render(statement, alphabet);
        let params = parameters
            .into_iter()
            .map(|(name, lit)| {
                (
                    ClientParameterName::new(name)
                        .unwrap_or_else(|error| unreachable!("parameter name: {error}")),
                    match lit {
                        Lit::Text(text) => LogicalValue::String(text.to_owned()),
                        Lit::Int(value) => LogicalValue::Int64(value),
                    },
                )
            })
            .collect();
        Self {
            sql,
            params,
            meta: meta(statement, alphabet),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Stage {
    Bind,
    Policy,
    Verify,
    Execute,
}

impl Stage {
    pub fn name(self) -> &'static str {
        match self {
            Self::Bind => "bind",
            Self::Policy => "policy",
            Self::Verify => "verify",
            Self::Execute => "execute",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Rejection {
    pub stage: Stage,
    pub reason: String,
    pub known: Option<u32>,
}

/// What the client can observe of one execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Obs {
    Select {
        columns: Vec<String>,
        rows: Vec<String>,
    },
    Mutation {
        changes: u64,
        returning: Vec<String>,
        post_view: Vec<Vec<String>>,
    },
}

pub type Observation = Result<Obs, String>;

#[derive(Debug)]
pub enum Outcome {
    Rejected(Rejection),
    Executed {
        protected_sql: String,
        observations: Box<[Observation; 4]>,
        known: Option<u32>,
    },
}

/// Alters a plan between policy compilation and verified emission. Only for planted-defect tests.
pub type Tamper<'a> = Option<&'a dyn Fn(&BoundStatement, &mut ProtectedPlan)>;

/// Everything one policy case needs: bundles and the four databases.
pub struct CaseWorld {
    pub case: PolicyCase,
    pub main: PolicyBundle,
    pub gates: Vec<(GateOff, PolicyBundle)>,
    pub select_dbs: [ReferenceSqlite; 4],
    pub mutation_dbs: [Connection; 4],
}

impl std::fmt::Debug for CaseWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaseWorld")
            .field("case", &self.case.name)
            .finish_non_exhaustive()
    }
}

pub fn activate(
    world: &World,
    case: &PolicyCase,
    flags: GateFlags,
    extra_regular: &[(&str, &str)],
    name: &str,
) -> PolicyBundle {
    let yaml = render_yaml(case, flags, extra_regular);
    PolicyBundle::activate(&yaml, &world.catalog, world.snapshot.clone()).unwrap_or_else(|error| {
        unreachable!(
            "case {} gate {name} does not activate: {error:?}",
            case.name
        )
    })
}

impl CaseWorld {
    /// Builds the bundles and databases, and asserts the variants are low-equivalent (spec 6.3).
    pub fn new(world: &World, case: PolicyCase) -> Self {
        Self::with_extra_regular(world, case, &[])
    }

    /// Like [`CaseWorld::new`], but the compiled policy lists extra `(resource, column)` pairs as
    /// plain columns while the databases keep the case's own meaning. Only the planted-defect
    /// test uses this: it makes the policy leak a column on purpose.
    pub fn with_extra_regular(
        world: &World,
        case: PolicyCase,
        extra_regular: &[(&str, &str)],
    ) -> Self {
        let mutation_dbs = connections(&case);
        assert_variants_low_equivalent(&case, &mutation_dbs);
        let main = activate(
            world,
            &case,
            GateFlags::uniform(true),
            extra_regular,
            "main",
        );
        let gates = gate_variants()
            .into_iter()
            .map(|off| {
                (
                    off,
                    activate(world, &case, off.flags(), extra_regular, &off.name()),
                )
            })
            .collect();
        let select_dbs = DBS.map(|db| {
            ReferenceSqlite::new(SCHEMA, &setup_sql(&case, db))
                .unwrap_or_else(|error| unreachable!("reference database: {error}"))
        });
        Self {
            case,
            main,
            gates,
            select_dbs,
            mutation_dbs,
        }
    }
}

/// Runs the pipeline with `bundle`. Returns the bound statement (when binding worked) because the
/// gate check reuses it.
pub fn run(
    world: &World,
    case: &CaseWorld,
    bundle: &PolicyBundle,
    generated: &Generated,
    tamper: Tamper<'_>,
) -> (Option<BoundStatement>, Outcome) {
    let bound = match SqliteFrontend::default().bind(&generated.sql, &world.catalog) {
        Ok(bound) => bound,
        Err(error) => {
            return (
                None,
                Outcome::Rejected(Rejection {
                    stage: Stage::Bind,
                    reason: error.to_string(),
                    known: None,
                }),
            );
        }
    };
    let compiled = match generated.meta.kind {
        StatementKind::Select => bundle.compile_select(&bound, &world.session),
        StatementKind::Update => bundle.compile_update(&bound, &world.session),
        StatementKind::Delete => bundle.compile_delete(&bound, &world.session),
    };
    let mut compiled = match compiled {
        Ok(compiled) => compiled,
        Err(error) => {
            let outcome = Outcome::Rejected(Rejection {
                stage: Stage::Policy,
                reason: format!("{error:?}"),
                known: None,
            });
            return (Some(bound), outcome);
        }
    };
    if let Some(tamper) = tamper {
        tamper(&bound, &mut compiled.plan);
    }
    let compile_verified = match generated.meta.kind {
        StatementKind::Select => compile_verified_select,
        StatementKind::Update => compile_verified_update,
        StatementKind::Delete => compile_verified_delete,
    };
    let verified = compile_verified(
        &compiled.plan,
        &world.catalog,
        generated.params.clone(),
        world.limits,
        world.snapshot.clone(),
    );
    let verified = match verified {
        Ok(verified) => verified,
        Err(error) => {
            let reason = error.to_string();
            let known = crate::oracle::known_issue(Stage::Verify, &reason);
            let outcome = Outcome::Rejected(Rejection {
                stage: Stage::Verify,
                reason,
                known,
            });
            return (Some(bound), outcome);
        }
    };
    let observations: [Observation; 4] = match generated.meta.kind {
        StatementKind::Select => DBS.map(|db| observe_select(case, db, &verified, &generated.meta)),
        StatementKind::Update | StatementKind::Delete => {
            DBS.map(|db| observe_mutation(case, db, &verified))
        }
    };
    let known = observations
        .iter()
        .filter_map(|observation| observation.as_ref().err())
        .find_map(|error| crate::oracle::known_issue(Stage::Execute, error));
    let outcome = Outcome::Executed {
        protected_sql: verified.protected_sql().to_owned(),
        observations: Box::new(observations),
        known,
    };
    (Some(bound), outcome)
}

fn observe_select(
    case: &CaseWorld,
    db: Db,
    verified: &VerifiedExecutionPlan<SqliteProfile>,
    meta: &StatementMeta,
) -> Observation {
    match case.select_dbs[db.index()].execute(verified) {
        Ok(result) => {
            let mut rows: Vec<String> = result
                .rows
                .iter()
                .zip(&result.redactions)
                .map(|(values, redactions)| format!("{values:?}|{redactions:?}"))
                .collect();
            if !meta.ordered {
                rows.sort();
            }
            Ok(Obs::Select {
                columns: result.columns,
                rows,
            })
        }
        Err(error) => Err(format!("{error:?}")),
    }
}

fn encode(value: &LogicalValue) -> SqlValue {
    match value {
        LogicalValue::Null => SqlValue::Null,
        LogicalValue::String(value) | LogicalValue::Json(value) => SqlValue::Text(value.clone()),
        LogicalValue::Boolean(value) => SqlValue::Integer(i64::from(*value)),
        LogicalValue::Int64(value) => SqlValue::Integer(*value),
        LogicalValue::Number(value) => SqlValue::Real(*value),
        LogicalValue::Bytes(value) => SqlValue::Blob(value.clone()),
    }
}

fn bind_all(
    statement: &mut rusqlite::Statement<'_>,
    verified: &VerifiedExecutionPlan<SqliteProfile>,
) -> Result<(), String> {
    let named = verified
        .client_parameters()
        .iter()
        .map(|(name, value)| (name.as_str(), value))
        .chain(
            verified
                .server_parameters()
                .iter()
                .map(|(name, value)| (name.as_str(), value)),
        );
    for (name, value) in named {
        let index = statement
            .parameter_index(&format!(":{name}"))
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("missing parameter {name}"))?;
        statement
            .raw_bind_parameter(index, encode(value))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Runs a verified UPDATE / DELETE inside a savepoint, observes it, and rolls it back whatever
/// happened, so every statement sees the pristine variant.
fn observe_mutation(
    case: &CaseWorld,
    db: Db,
    verified: &VerifiedExecutionPlan<SqliteProfile>,
) -> Observation {
    let conn = &case.mutation_dbs[db.index()];
    conn.execute_batch("SAVEPOINT fuzz")
        .unwrap_or_else(|error| unreachable!("savepoint: {error}"));
    let observed = (|| {
        let returning = {
            let mut statement = conn
                .prepare(verified.protected_sql())
                .map_err(|error| error.to_string())?;
            bind_all(&mut statement, verified)?;
            let columns = statement.column_count();
            let mut rows = statement.raw_query();
            let mut out = Vec::new();
            while let Some(row) = rows.next().map_err(|error| error.to_string())? {
                let mut cells = Vec::with_capacity(columns);
                for index in 0..columns {
                    let value = row.get_ref(index).map_err(|error| error.to_string())?;
                    cells.push(format_value(value));
                }
                out.push(cells.join("|"));
            }
            out.sort();
            out
        };
        Ok(Obs::Mutation {
            changes: conn.changes(),
            returning,
            post_view: views(conn, &case.case),
        })
    })();
    conn.execute_batch("ROLLBACK TO fuzz; RELEASE fuzz")
        .unwrap_or_else(|error| unreachable!("rollback: {error}"));
    observed
}

/// The select-visible rows of one table as the compiler produces them (for the mirror check): the
/// hand-written view's columns, with the visibility mark last (1 visible, 0 hidden).
pub fn compiler_view(
    world: &World,
    case: &CaseWorld,
    db: Db,
    alphabet: &Alphabet,
    resource: usize,
) -> Result<Vec<String>, String> {
    let spec = alphabet
        .resource(resource)
        .ok_or_else(|| "unknown resource".to_owned())?;
    let mut columns: Vec<&str> = crate::policies::regular_columns(resource).to_vec();
    columns.push(crate::policies::conditional_column(resource));
    let projections: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(index, column)| format!("{}.{column} AS o{index}", spec.alias))
        .collect();
    let sql = format!(
        "SELECT {} FROM {} {} ORDER BY o0",
        projections.join(", "),
        spec.name,
        spec.alias
    );
    let bound = SqliteFrontend::default()
        .bind(&sql, &world.catalog)
        .map_err(|error| format!("bind: {error}"))?;
    let compiled = case
        .main
        .compile_select(&bound, &world.session)
        .map_err(|error| format!("policy: {error:?}"))?;
    let verified = compile_verified_select(
        &compiled.plan,
        &world.catalog,
        BTreeMap::new(),
        world.limits,
        world.snapshot.clone(),
    )
    .map_err(|error| format!("verify: {error}"))?;
    let result = case.select_dbs[db.index()]
        .execute(&verified)
        .map_err(|error| format!("execute: {error:?}"))?;
    let show = |value: &LogicalValue| match value {
        LogicalValue::Null => "NULL".to_owned(),
        LogicalValue::String(text) => format!("'{text}'"),
        LogicalValue::Int64(number) => number.to_string(),
        other => format!("{other:?}"),
    };
    Ok(result
        .rows
        .iter()
        .zip(&result.redactions)
        .map(|(values, redactions)| {
            let hidden = redactions.last().copied().unwrap_or(false);
            let mut cells: Vec<String> = values.iter().map(show).collect();
            cells.push(if hidden { "0" } else { "1" }.to_owned());
            cells.join("|")
        })
        .collect())
}
