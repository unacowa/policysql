//! Counting what each stage accepted and rejected, and the text printed at the end of a test.
//!
//! A test builds one `String` and prints it with a single `println!`, so output stays together
//! under the parallel test runner. Nothing here uses a `HashMap`: output order is deterministic
//! (only the `[timing]` line varies between runs).

use crate::oracle::{self, Check, Violation};
use crate::pipeline::{CaseWorld, Generated, Obs, Observation, Outcome, Rejection, Stage, run};
use crate::variants::Db;
use crate::world::World;
use policysql_testkit::fuzz::meta::{NodeKind, Slot, SourceKind};
use policysql_testkit::fuzz::{Alphabet, ColumnClass};
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// Per-cell counters of layer 2.
#[derive(Clone, Copy, Debug, Default)]
pub struct CellTally {
    pub generated: u64,
    pub bind_ok: u64,
    pub policy_ok: u64,
    pub executed: u64,
    pub violations: u64,
}

#[derive(Debug)]
pub struct Tally {
    pub layer: String,
    pub case: String,
    pub config: String,
    pub generated: u64,
    pub rejections: BTreeMap<String, u64>,
    pub known: BTreeMap<u32, u64>,
    /// Statements that went through every stage and ran on the four databases.
    pub executed: u64,
    /// Of those, the statements for which no database returned an error.
    pub all_ok: u64,
    /// Of those, the statements for which at least one database returned an error.
    pub errored: u64,
    /// Gate bundles compiled for statements that depend on a gate.
    pub gate_checked: u64,
    /// Statements the main bundle accepted at the policy stage and at least one bundle with the
    /// gate switched off rejected: the gate demonstrably did work.
    pub gate_effective: u64,
    /// Of the executed mutations, those whose operation check failed in the base database (in
    /// production they fail and roll back).
    pub check_failed: u64,
    /// Statements skipped because the same SQL and parameters had been run already.
    pub duplicates: u64,
    /// How many statements with a feature reached `all_ok`.
    pub features: BTreeMap<&'static str, u64>,
    pub violations: BTreeMap<&'static str, u64>,
    pub slot_nodes: BTreeMap<(Slot, NodeKind), u64>,
    pub first: BTreeMap<String, String>,
    pub details: Vec<String>,
    /// How many details were kept per check.
    pub details_per_check: BTreeMap<&'static str, usize>,
    pub cells: BTreeMap<String, CellTally>,
    pub rounds: Vec<String>,
    /// Mutation violations by the roles of the columns the statement mentions.
    pub mutation_classes: BTreeMap<String, u64>,
}

impl Tally {
    pub fn new(layer: &str, case: &str, config: String) -> Self {
        Self {
            layer: layer.to_owned(),
            case: case.to_owned(),
            config,
            generated: 0,
            rejections: BTreeMap::new(),
            known: oracle::known_issue_numbers()
                .into_iter()
                .map(|issue| (issue, 0))
                .collect(),
            executed: 0,
            all_ok: 0,
            errored: 0,
            gate_checked: 0,
            gate_effective: 0,
            check_failed: 0,
            duplicates: 0,
            features: BTreeMap::new(),
            violations: BTreeMap::new(),
            slot_nodes: BTreeMap::new(),
            first: BTreeMap::new(),
            details: Vec::new(),
            details_per_check: BTreeMap::new(),
            cells: BTreeMap::new(),
            rounds: Vec::new(),
            mutation_classes: BTreeMap::new(),
        }
    }

    pub fn total_violations(&self) -> u64 {
        self.violations.values().sum()
    }
}

/// How to name a statement in a report. Built only when a violation is found.
#[derive(Debug)]
pub struct Identity {
    /// Everything needed to reproduce the statement (layer, seed, round, index, ...).
    pub label: String,
    /// Groups "first violation" lines: the seed, or empty for layer 1.
    pub seed_key: String,
    /// The number reported as the first violation (ordinal, `seed/round/index`, `seed/index`).
    pub position: String,
}

/// Details printed at the end of a test, per check. The first violation of every check and seed
/// is also printed the moment it is found.
const DETAILS_PER_CHECK: usize = 3;

/// Constructs worth showing in a report because generation is meant to reach them.
fn features(generated: &Generated) -> Vec<&'static str> {
    let meta = &generated.meta;
    let mut out = Vec::new();
    if meta
        .slot_nodes
        .keys()
        .any(|(_, node)| *node == NodeKind::Or)
    {
        out.push("or");
    }
    if !generated.params.is_empty() {
        out.push("parameter");
    }
    match meta.source {
        SourceKind::Table => {}
        SourceKind::DerivedTable => out.push("derived-table"),
        SourceKind::Cte => out.push("cte"),
    }
    if meta.correlated_exists {
        out.push("correlated-exists");
    }
    out
}

fn describe(observation: &Observation) -> String {
    match observation {
        Ok(obs) => format!("{obs:?}"),
        Err(error) => format!("error: {error}"),
    }
}

fn class_label(violation: &Violation) -> String {
    let has = |class| violation.column_classes.contains(&class);
    let mut parts = Vec::new();
    if has(ColumnClass::Forbidden) {
        parts.push("forbidden");
    }
    if has(ColumnClass::Conditional) {
        parts.push("conditional");
    }
    if parts.is_empty() {
        parts.push("regular-only");
    }
    parts.join("+")
}

/// Runs one generated statement through the pipeline with the `main` bundle, applies both
/// oracles, and records everything in `tally`. Returns the number of violations.
pub fn process(
    world: &World,
    case: &CaseWorld,
    alphabet: &Alphabet,
    generated: &Generated,
    tally: &mut Tally,
    identity: &dyn Fn() -> Identity,
    cell: Option<&str>,
) -> u64 {
    tally.generated += 1;
    let (bound, outcome) = run(world, case, &case.main, generated, None);
    let mut violations = oracle::noninterference(generated, &outcome);
    let main_passed_policy = matches!(
        &outcome,
        Outcome::Executed { .. }
            | Outcome::Rejected(Rejection {
                stage: Stage::Verify,
                ..
            })
    );
    if let Some(bound) = &bound {
        let report = oracle::gates(world, &case.gates, bound, &generated.meta, alphabet);
        tally.gate_checked += report.checked;
        tally.gate_effective += u64::from(main_passed_policy && report.rejected > 0);
        violations.extend(report.violations);
    }
    let (bind_ok, policy_ok, executed) = match &outcome {
        Outcome::Rejected(rejection) => {
            let key = format!(
                "{}: {}",
                rejection.stage.name(),
                rejection.reason.chars().take(100).collect::<String>()
            );
            *tally.rejections.entry(key).or_insert(0) += 1;
            if let Some(issue) = rejection.known {
                *tally.known.entry(issue).or_insert(0) += 1;
            }
            (
                rejection.stage != Stage::Bind,
                matches!(rejection.stage, Stage::Verify),
                false,
            )
        }
        Outcome::Executed {
            known,
            observations,
            ..
        } => {
            tally.executed += 1;
            tally.check_failed += u64::from(matches!(
                observations[Db::Base.index()],
                Ok(Obs::CheckFailed)
            ));
            if observations.iter().all(Result::is_ok) {
                tally.all_ok += 1;
                for name in features(generated) {
                    *tally.features.entry(name).or_insert(0) += 1;
                }
            } else {
                tally.errored += 1;
            }
            if let Some(issue) = known {
                *tally.known.entry(*issue).or_insert(0) += 1;
            }
            for (key, count) in &generated.meta.slot_nodes {
                *tally.slot_nodes.entry(*key).or_insert(0) += u64::from(*count);
            }
            (true, true, true)
        }
    };
    if let Some(cell) = cell {
        let counters = tally.cells.entry(cell.to_owned()).or_default();
        counters.generated += 1;
        counters.bind_ok += u64::from(bind_ok);
        counters.policy_ok += u64::from(policy_ok);
        counters.executed += u64::from(executed);
        counters.violations += u64::from(!violations.is_empty());
    }
    if violations.is_empty() {
        return 0;
    }
    let identity = identity();
    for violation in &violations {
        let name = violation.check.name();
        *tally.violations.entry(name).or_insert(0) += 1;
        let key = format!("{name} {}", identity.seed_key);
        let is_first = !tally.first.contains_key(&key);
        if is_first {
            tally.first.insert(key, identity.position.clone());
        }
        if violation.check == Check::MutationNoninterference {
            *tally
                .mutation_classes
                .entry(class_label(violation))
                .or_insert(0) += 1;
        }
        let kept = tally.details_per_check.get(name).copied().unwrap_or(0);
        if is_first || kept < DETAILS_PER_CHECK {
            let text = detail(&identity, generated, &outcome, violation, tally, cell);
            if is_first {
                // Printed at once: a run that dies later (a panic, a timeout) still leaves the
                // first violation of every check and seed in the log.
                eprintln!("{text}");
            }
            if kept < DETAILS_PER_CHECK {
                *tally.details_per_check.entry(name).or_insert(0) += 1;
                tally.details.push(text);
            }
        }
    }
    u64::try_from(violations.len()).unwrap_or(u64::MAX)
}

fn detail(
    identity: &Identity,
    generated: &Generated,
    outcome: &Outcome,
    violation: &Violation,
    tally: &Tally,
    cell: Option<&str>,
) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "VIOLATION {} layer={} case={} label={}",
        violation.check.name(),
        tally.layer,
        tally.case,
        identity.label
    );
    if let Some(cell) = cell {
        let _ = writeln!(out, "  cell: {cell}");
    }
    let _ = writeln!(out, "  input sql: {}", generated.sql);
    let _ = writeln!(out, "  client parameters: {:?}", generated.params);
    if let Outcome::Executed {
        protected_sql,
        observations,
        ..
    } = outcome
    {
        let _ = writeln!(out, "  protected sql: {protected_sql}");
        let _ = writeln!(out, "  base: {}", describe(&observations[Db::Base.index()]));
        if let Some(variant) = violation.variant {
            let _ = writeln!(
                out,
                "  {}: {}",
                variant.name(),
                describe(&observations[variant.index()])
            );
        }
    }
    if let Some(gate) = violation.gate {
        let _ = writeln!(
            out,
            "  gate variant {} accepted a statement that depends on the gate it switched off",
            gate.name()
        );
    }
    out
}

/// The text printed at the end of a test (spec 13).
pub fn summary(tally: &Tally, seconds: f64) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "== {} case={} config={}",
        tally.layer, tally.case, tally.config
    );
    let _ = writeln!(out, "generated: {}", tally.generated);
    for (reason, count) in &tally.rejections {
        let _ = writeln!(out, "  rejected {reason}: {count}");
    }
    let _ = writeln!(
        out,
        "executed: {} (all four databases ok: {}, at least one error: {})",
        tally.executed, tally.all_ok, tally.errored
    );
    if tally.check_failed > 0 {
        let _ = writeln!(
            out,
            "operation check failed (rolled back in production): {}",
            tally.check_failed
        );
    }
    if tally.duplicates > 0 {
        let _ = writeln!(out, "skipped as duplicates: {}", tally.duplicates);
    }
    let _ = writeln!(
        out,
        "gate: {} bundle compilations, effective for {} statements",
        tally.gate_checked, tally.gate_effective
    );
    if !tally.features.is_empty() {
        let _ = writeln!(out, "all-ok statements with: {:?}", tally.features);
    }
    for (issue, count) in &tally.known {
        let _ = writeln!(out, "  known #{issue}: {count}");
    }
    let _ = writeln!(
        out,
        "violations: {} {:?}",
        tally.total_violations(),
        tally.violations
    );
    if !tally.mutation_classes.is_empty() {
        let _ = writeln!(
            out,
            "mutation violations by column roles: {:?}",
            tally.mutation_classes
        );
    }
    for round in &tally.rounds {
        let _ = writeln!(out, "{round}");
    }
    if !tally.cells.is_empty() {
        let _ = writeln!(
            out,
            "cell | generated | bind_ok | policy_ok | executed | violations"
        );
        for (name, cell) in &tally.cells {
            let _ = writeln!(
                out,
                "{name} | {} | {} | {} | {} | {}",
                cell.generated, cell.bind_ok, cell.policy_ok, cell.executed, cell.violations
            );
        }
    }
    if !tally.slot_nodes.is_empty() {
        let _ = writeln!(out, "executed (slot, node kind) occurrences:");
        for ((slot, node), count) in &tally.slot_nodes {
            let _ = writeln!(out, "  {slot:?}/{node:?}: {count}");
        }
    }
    for (key, position) in &tally.first {
        let _ = writeln!(out, "first violation {key}: {position}");
    }
    for (issue, count) in &tally.known {
        if *count == 0 {
            let _ = writeln!(
                out,
                "#{issue}: 0 occurrences (if fixed, remove it from KNOWN_ISSUES)"
            );
        }
    }
    for detail in &tally.details {
        out.push_str(detail);
    }
    let _ = writeln!(
        out,
        "[timing] layer={} case={} statements={} seconds={seconds:.2}",
        tally.layer, tally.case, tally.generated
    );
    out
}

/// A lower bound on a count, fixed or relative to the number of generated statements.
#[derive(Clone, Copy, Debug)]
pub enum Floor {
    Count(u64),
    /// Parts per thousand of the statements generated.
    PerMille(u64),
}

impl Floor {
    fn of(self, generated: u64) -> u64 {
        match self {
            Self::Count(count) => count,
            Self::PerMille(per_mille) => generated.saturating_mul(per_mille) / 1000,
        }
    }
}

/// What a test must have reached, not only what it must not have found. A test that reaches
/// nothing is not a test: a change that makes every statement fail at bind or policy would
/// otherwise leave every layer green.
#[derive(Clone, Copy, Debug)]
pub struct Expect {
    /// Statements run on all four databases without an error (at least 1).
    pub all_ok: Floor,
    /// Statements for which a gate demonstrably did work (SELECT layers).
    pub gate_effective: Floor,
    /// Features that must occur among the all-ok statements.
    pub features: &'static [&'static str],
}

/// Prints the summary once and fails if anything was violated or too little was reached.
pub fn finish(tally: &Tally, seconds: f64, expect: &Expect) {
    let text = summary(tally, seconds);
    println!("{text}");
    // The summary above is printed once (a failing test shows it with the failure), so the
    // messages below only say what failed.
    assert!(
        tally.total_violations() == 0,
        "{} violations {:?}: details above",
        tally.total_violations(),
        tally.violations
    );
    let all_ok_floor = expect.all_ok.of(tally.generated).max(1);
    assert!(
        tally.all_ok >= all_ok_floor,
        "only {} statements ran on all four databases without an error, expected at least {all_ok_floor} (summary above)",
        tally.all_ok
    );
    let gate_floor = expect.gate_effective.of(tally.generated);
    assert!(
        tally.gate_effective >= gate_floor,
        "the gate was effective for {} statements, expected at least {gate_floor} (summary above)",
        tally.gate_effective
    );
    for feature in expect.features {
        assert!(
            tally.features.get(feature).copied().unwrap_or(0) > 0,
            "no all-ok statement with {feature} (summary above)"
        );
    }
}
