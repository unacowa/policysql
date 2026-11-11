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
}

impl Check {
    pub fn name(self) -> &'static str {
        match self {
            Self::SelectNoninterference => "SelectNoninterference",
            Self::MutationNoninterference => "MutationNoninterference",
            Self::Gate => "Gate",
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
/// outcome in the report (`known #N`).
struct KnownIssue {
    issue: u32,
    stage: Stage,
    needle: &'static str,
}

const KNOWN_ISSUES: &[KnownIssue] = &[
    KnownIssue {
        issue: 121,
        stage: Stage::Execute,
        needle: "InvalidResult",
    },
    KnownIssue {
        issue: 122,
        stage: Stage::Verify,
        needle: "registered function argument",
    },
];

/// The issue numbers in [`KNOWN_ISSUES`].
pub fn known_issue_numbers() -> Vec<u32> {
    KNOWN_ISSUES.iter().map(|known| known.issue).collect()
}

/// The known issue a rejection or an execution error belongs to, if any.
pub fn known_issue(stage: Stage, reason: &str) -> Option<u32> {
    KNOWN_ISSUES
        .iter()
        .find(|known| known.stage == stage && reason.contains(known.needle))
        .map(|known| known.issue)
}

/// Noninterference: for an executed statement, every low-equivalent variant must show the client
/// exactly what the base database shows. Rejections are not violations: bind, policy and verify
/// never look at data.
pub fn noninterference(generated: &Generated<'_>, outcome: &Outcome) -> Vec<Violation> {
    let Outcome::Executed { observations, .. } = outcome else {
        return Vec::new();
    };
    let check = if generated.meta.kind == StatementKind::Select {
        Check::SelectNoninterference
    } else {
        Check::MutationNoninterference
    };
    let base: &Observation = &observations[Db::Base.index()];
    DBS[1..]
        .iter()
        .filter(|db| observations[db.index()] != *base)
        .map(|db| Violation {
            check,
            variant: Some(*db),
            gate: None,
            column_classes: generated.meta.column_classes.clone(),
        })
        .collect()
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

/// The gate: a SELECT with an aggregate or a window function must be rejected by every bundle
/// that switched off a gate it depends on. A success is a violation.
pub fn gates(
    world: &World,
    gate_bundles: &[(GateOff, PolicyBundle)],
    bound: &BoundStatement,
    meta: &StatementMeta,
    alphabet: &Alphabet,
) -> Vec<Violation> {
    if meta.kind != StatementKind::Select || !(meta.aggregation || meta.window) {
        return Vec::new();
    }
    gate_bundles
        .iter()
        .filter(|(off, _)| relevant(*off, meta, alphabet))
        .filter(|(_, bundle)| bundle.compile_select(bound, &world.session).is_ok())
        .map(|(off, _)| Violation {
            check: Check::Gate,
            variant: None,
            gate: Some(*off),
            column_classes: meta.column_classes.clone(),
        })
        .collect()
}
