//! The two verdicts: noninterference (observations agree across low-equivalent databases) and the
//! gate (a gate switched off must reject). No expected value is written by hand anywhere.

use crate::pipeline::{Generated, Observation, Outcome, Stage};
use crate::policies::{GateFlag, GateOff};
use crate::variants::{DBS, Db};
use crate::world::World;
use policysql_ir::BoundStatement;
use policysql_policy::PolicyBundle;
use policysql_testkit::fuzz::meta::{StatementKind, StatementMeta};
use policysql_testkit::fuzz::{Alphabet, ColumnClass};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Check {
    SelectNoninterference,
    MutationNoninterference,
    Gate,
    /// An execution error that no known issue accounts for (see [`KNOWN_ISSUES`]).
    ExecutionError,
}

impl Check {
    pub fn name(self) -> &'static str {
        match self {
            Self::SelectNoninterference => "SelectNoninterference",
            Self::MutationNoninterference => "MutationNoninterference",
            Self::Gate => "Gate",
            Self::ExecutionError => "ExecutionError",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Violation {
    pub check: Check,
    /// The variant whose observation differs from base (noninterference).
    pub variant: Option<Db>,
    /// The gate variant that accepted a statement it must reject (gate).
    pub gate: Option<GateOff>,
    /// Roles of the columns the statement mentions (used to classify mutation violations).
    pub column_classes: BTreeSet<ColumnClass>,
}

/// A defect already filed as an issue. The comparison still runs; the entry only labels the
/// outcome in the report (`known #N`). An entry names the statement shape it is filed for: the
/// same message on any other shape is not this defect.
struct KnownIssue {
    issue: u32,
    stage: Stage,
    needle: &'static str,
    shape: fn(&StatementMeta) -> bool,
}

const KNOWN_ISSUES: &[KnownIssue] = &[
    KnownIssue {
        issue: 121,
        stage: Stage::Execute,
        needle: "InvalidResult",
        // An aggregate without GROUP BY (with a bare column and no matching row, the column is
        // NULL although it is not nullable).
        shape: |meta| meta.aggregation && !meta.grouped,
    },
    KnownIssue {
        issue: 122,
        stage: Stage::Verify,
        needle: "registered function argument",
        shape: |_| true,
    },
];

/// The issue numbers in [`KNOWN_ISSUES`].
pub fn known_issue_numbers() -> Vec<u32> {
    KNOWN_ISSUES.iter().map(|known| known.issue).collect()
}

/// The known issue a rejection or an execution error belongs to, if any.
pub fn known_issue(stage: Stage, reason: &str, meta: &StatementMeta) -> Option<u32> {
    KNOWN_ISSUES
        .iter()
        .find(|known| known.stage == stage && reason.contains(known.needle) && (known.shape)(meta))
        .map(|known| known.issue)
}

/// Noninterference: for an executed statement, every low-equivalent variant must show the client
/// exactly what the base database shows. Rejections are not violations: bind, policy and verify
/// never look at data. An execution error that no known issue accounts for is a violation of its
/// own, even when every database fails the same way: the statement was accepted and then broke.
pub fn noninterference(generated: &Generated, outcome: &Outcome) -> Vec<Violation> {
    let Outcome::Executed {
        observations,
        unexpected_errors,
        ..
    } = outcome
    else {
        return Vec::new();
    };
    let check = if generated.meta.kind == StatementKind::Select {
        Check::SelectNoninterference
    } else {
        Check::MutationNoninterference
    };
    let violation = |check, db: Db| Violation {
        check,
        variant: Some(db),
        gate: None,
        column_classes: generated.meta.column_classes.clone(),
    };
    let base: &Observation = &observations[Db::Base.index()];
    let mut out: Vec<Violation> = DBS[1..]
        .iter()
        .filter(|db| observations[db.index()] != *base)
        .map(|db| violation(check, *db))
        .collect();
    out.extend(
        unexpected_errors
            .iter()
            .map(|db| violation(Check::ExecutionError, *db)),
    );
    out
}

/// Whether switching `off` off removes a gate this statement depends on.
fn relevant(off: GateOff, meta: &StatementMeta, alphabet: &Alphabet) -> bool {
    match off {
        GateOff::All => true,
        GateOff::One { resource, flag } => {
            let reads = meta
                .resources_read
                .iter()
                .any(|index| alphabet.resource_name(*index) == resource);
            reads
                && match flag {
                    GateFlag::Aggregations => meta.aggregation,
                    GateFlag::Windows => meta.window,
                }
        }
    }
}

/// What the gate check did for one statement.
#[derive(Debug, Default)]
pub struct GateReport {
    pub violations: Vec<Violation>,
    /// Gate bundles compiled (those that switched off a gate the statement depends on).
    pub checked: u64,
    /// Of those, the bundles that rejected the statement.
    pub rejected: u64,
}

/// The gate: a SELECT with an aggregate or a window function must be rejected by every bundle
/// that switched off a gate it depends on. A success is a violation.
pub fn gates(
    world: &World,
    gate_bundles: &[(GateOff, PolicyBundle)],
    bound: &BoundStatement,
    meta: &StatementMeta,
    alphabet: &Alphabet,
) -> GateReport {
    let mut report = GateReport::default();
    if meta.kind != StatementKind::Select || !(meta.aggregation || meta.window) {
        return report;
    }
    for (off, bundle) in gate_bundles {
        if !relevant(*off, meta, alphabet) {
            continue;
        }
        report.checked += 1;
        if bundle.compile_select(bound, &world.session).is_ok() {
            report.violations.push(Violation {
                check: Check::Gate,
                variant: None,
                gate: Some(*off),
                column_classes: meta.column_classes.clone(),
            });
        } else {
            report.rejected += 1;
        }
    }
    report
}
