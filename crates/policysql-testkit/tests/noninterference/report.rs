//! Counting what each stage accepted and rejected, and the text printed at the end of a test.
//!
//! A test builds one `String` and prints it with a single `println!`, so output stays together
//! under the parallel test runner. Nothing here uses a `HashMap`: output order is deterministic
//! (only the `[timing]` line varies between runs).

use crate::oracle::{self, Check, Violation};
use crate::pipeline::{CaseWorld, Generated, Observation, Outcome, Stage, run};
use crate::variants::Db;
use crate::world::World;
use policysql_testkit::fuzz::meta::{NodeKind, Slot};
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
    pub executed: u64,
    pub violations: BTreeMap<&'static str, u64>,
    pub slot_nodes: BTreeMap<(Slot, NodeKind), u64>,
    pub first: BTreeMap<String, String>,
    pub details: Vec<String>,
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
            violations: BTreeMap::new(),
            slot_nodes: BTreeMap::new(),
            first: BTreeMap::new(),
            details: Vec::new(),
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
    if let Some(bound) = &bound {
        violations.extend(oracle::gates(
            world,
            &case.gates,
            bound,
            &generated.meta,
            alphabet,
        ));
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
        Outcome::Executed { known, .. } => {
            tally.executed += 1;
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
        *tally.violations.entry(violation.check.name()).or_insert(0) += 1;
        tally
            .first
            .entry(format!("{} {}", violation.check.name(), identity.seed_key))
            .or_insert_with(|| identity.position.clone());
        if violation.check == Check::MutationNoninterference {
            *tally
                .mutation_classes
                .entry(class_label(violation))
                .or_insert(0) += 1;
        }
        if tally.details.len() < 10 {
            let text = detail(&identity, generated, &outcome, violation, tally, cell);
            tally.details.push(text);
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
    let _ = writeln!(out, "executed: {}", tally.executed);
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

/// Prints the summary once and fails if anything was violated.
pub fn finish(tally: &Tally, seconds: f64) {
    let text = summary(tally, seconds);
    println!("{text}");
    assert!(tally.total_violations() == 0, "{text}");
}
