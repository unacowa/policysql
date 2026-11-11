//! Planted defects: the oracles must catch a compiler that is wrong on purpose. Each test goes
//! through the same `run`, `noninterference` and `gates` functions the layers use, never through
//! a verdict of its own. If a planted defect stopped being detected, the layers could not be
//! trusted either.

use crate::oracle::{self, Check};
use crate::pipeline::{CaseWorld, Generated, Outcome, run};
use crate::policies::{self, GateFlag, GateFlags, GateOff, gate_variants};
use crate::report::{Identity, Tally, process};
use crate::shapes::{POSTS, cmp, col, posts_where, projecting, table, text};
use crate::variants::Db;
use crate::world::{self, World};
use policysql_ir::{BoundStatement, ProtectedPlan};
use policysql_testkit::fuzz::ast::{CmpOp, Delete, Projection, Returning, Statement};
use policysql_testkit::fuzz::layer1;

fn title_equals_a() -> Statement {
    posts_where(cmp(CmpOp::Eq, col(POSTS, 1), text("a")))
}

/// A compiler that forgot the row filter: the protected statement keeps the client's own WHERE.
#[test]
fn planted_missing_root_filter_is_detected() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case = CaseWorld::new(&world, policies::case_named("base"));
    let statement = title_equals_a();
    let generated = Generated::new(&statement, &alphabet);
    let drop_row_filter = |bound: &BoundStatement, plan: &mut ProtectedPlan| {
        if let (BoundStatement::Select(original), BoundStatement::Select(protected)) =
            (bound, &mut plan.statement)
        {
            protected.predicate = original.predicate.clone();
        }
        plan.server_values.clear();
    };
    let (_, outcome) = run(
        &world,
        &case,
        &case.main,
        &generated,
        Some(&drop_row_filter),
    );
    assert!(
        matches!(outcome, Outcome::Executed { .. }),
        "the tampered plan must still pass verification, or this test shows nothing: {outcome:?}"
    );
    let violations = oracle::noninterference(&generated, &outcome);
    assert!(
        violations
            .iter()
            .any(|v| v.check == Check::SelectNoninterference && v.variant == Some(Db::Row)),
        "a missing row filter must show up in the row variant: {violations:?}"
    );
    // The same statement without the defect is clean.
    let (_, honest) = run(&world, &case, &case.main, &generated, None);
    assert!(oracle::noninterference(&generated, &honest).is_empty());
}

/// A policy that lists a forbidden column as plain: filtering on it is visible in the result.
#[test]
fn planted_forbidden_column_as_regular_is_detected() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case =
        CaseWorld::with_extra_regular(&world, policies::case_named("base"), &[("posts", "secret")]);
    let statement = posts_where(cmp(CmpOp::Eq, col(POSTS, 6), text("x")));
    let generated = Generated::new(&statement, &alphabet);
    let (_, outcome) = run(&world, &case, &case.main, &generated, None);
    assert!(matches!(outcome, Outcome::Executed { .. }), "{outcome:?}");
    let violations = oracle::noninterference(&generated, &outcome);
    assert!(
        violations
            .iter()
            .any(|v| v.check == Check::SelectNoninterference && v.variant == Some(Db::Col)),
        "{violations:?}"
    );

    // The layer-1 enumeration finds it too (sizes up to 3, 9,682 statements).
    let reduced = world::reduced_alphabet();
    let mut tally = Tally::new("planted-layer1", "base+secret", "max_size=3".to_owned());
    layer1::for_each_select(&reduced, 3, &mut |item| {
        let generated = Generated::new(item.statement, &reduced);
        process(
            &world,
            &case,
            &reduced,
            &generated,
            &mut tally,
            &|| Identity {
                label: format!("ordinal={}", item.ordinal),
                seed_key: String::new(),
                position: item.ordinal.to_string(),
            },
            None,
        );
    });
    assert_eq!(tally.generated, 9_682);
    assert!(
        tally
            .violations
            .get("SelectNoninterference")
            .copied()
            .unwrap_or(0)
            >= 1,
        "layer 1 must catch the leaked column: {:?}",
        tally.violations
    );
}

/// Gate bundles that do not actually switch anything off: the gate oracle must complain.
#[test]
fn planted_gate_bypass_is_detected() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case = CaseWorld::new(&world, policies::case_named("base"));
    let statement = projecting(Projection::CountAll);
    let generated = Generated::new(&statement, &alphabet);
    let (bound, _) = run(&world, &case, &case.main, &generated, None);
    let bound = bound.unwrap_or_else(|| unreachable!("COUNT(*) must bind"));
    // Honest gate bundles reject the statement.
    assert!(oracle::gates(&world, &case.gates, &bound, &generated.meta, &alphabet).is_empty());
    // Names as in the standing bundles, contents all `main`.
    let fake: Vec<_> = gate_variants()
        .into_iter()
        .map(|off| {
            (
                off,
                crate::pipeline::activate(
                    &world,
                    &case.case,
                    GateFlags::uniform(true),
                    &[],
                    "fake",
                ),
            )
        })
        .collect();
    let violations = oracle::gates(&world, &fake, &bound, &generated.meta, &alphabet);
    let named = |wanted: GateOff| violations.iter().any(|v| v.gate == Some(wanted));
    assert!(named(GateOff::All), "{violations:?}");
    assert!(
        named(GateOff::One {
            resource: "posts",
            flag: GateFlag::Aggregations
        }),
        "{violations:?}"
    );
    assert!(violations.iter().all(|v| v.check == Check::Gate));
}

/// Records the current state of issue #118, which is outside P3: an UPDATE / DELETE filter wider
/// than the select filter lets a statement act on rows the client cannot see, and the result shows
/// it. When the #118 specification is settled, update this test (and the policy cases).
#[test]
fn known_gap_118_wider_mutation_filter() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case = CaseWorld::new(&world, policies::wider_mutation_filter_case());
    let statement = Statement::Delete(Delete {
        resource: POSTS,
        predicate: Some(cmp(CmpOp::Lt, table(POSTS, 2), text("open"))),
        returning: Returning::Id,
    });
    let generated = Generated::new(&statement, &alphabet);
    let (_, outcome) = run(&world, &case, &case.main, &generated, None);
    assert!(matches!(outcome, Outcome::Executed { .. }), "{outcome:?}");
    let violations = oracle::noninterference(&generated, &outcome);
    assert!(
        violations
            .iter()
            .any(|v| v.check == Check::MutationNoninterference && v.variant == Some(Db::Row)),
        "{violations:?}"
    );
}
