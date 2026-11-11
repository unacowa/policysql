//! Planted defects: the oracles must catch a compiler that is wrong on purpose. Each test goes
//! through the same `run`, `noninterference` and `gates` functions the layers use, never through
//! a verdict of its own. If a planted defect stopped being detected, the layers could not be
//! trusted either.

use crate::oracle::{self, Check};
use crate::pipeline::{CaseWorld, Generated, Obs, Outcome, run};
use crate::policies::{self, GateFlag, GateFlags, GateOff, gate_variants};
use crate::report::{Identity, Tally, process};
use crate::shapes::{COMMENTS, POSTS, cmp, col, posts_where, projecting, table, text};
use crate::variants::{DBS, Db};
use crate::world::{self, World};
use policysql_ir::{BoundStatement, ProtectedPlan};
use policysql_testkit::fuzz::ast::{
    CmpOp, Delete, Lit, Projection, Returning, Statement, Update, Value,
};
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
            protected.predicate.clone_from(&original.predicate);
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
    let honest = oracle::gates(&world, &case.gates, &bound, &generated.meta, &alphabet);
    assert!(honest.violations.is_empty());
    assert!(
        honest.checked >= 1 && honest.rejected == honest.checked,
        "{honest:?}"
    );
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
    let violations = oracle::gates(&world, &fake, &bound, &generated.meta, &alphabet).violations;
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

fn drop_delete_row_filter(bound: &BoundStatement, plan: &mut ProtectedPlan) {
    if let (BoundStatement::Delete(original), BoundStatement::Delete(protected)) =
        (bound, &mut plan.statement)
    {
        protected.predicate.clone_from(&original.predicate);
        // The filter was the only user of the server parameters.
        plan.server_values.clear();
    }
}

/// The UPDATE counterpart. The operation check is the same filter on the new row, so it stays
/// (and so do the server parameters it uses): the statement is still emitted and verified.
fn drop_update_row_filter(bound: &BoundStatement, plan: &mut ProtectedPlan) {
    if let (BoundStatement::Update(original), BoundStatement::Update(protected)) =
        (bound, &mut plan.statement)
    {
        protected.predicate.clone_from(&original.predicate);
    }
}

fn assert_mutation_violation(outcome: &Outcome, generated: &Generated, variant: Db, what: &str) {
    assert!(
        matches!(outcome, Outcome::Executed { .. }),
        "{what}: the planted plan must still pass verification: {outcome:?}"
    );
    let violations = oracle::noninterference(generated, outcome);
    assert!(
        violations
            .iter()
            .any(|v| v.check == Check::MutationNoninterference && v.variant == Some(variant)),
        "{what}: {violations:?}"
    );
}

/// A compiler whose DELETE forgot the row filter deletes rows the client cannot see.
#[test]
fn planted_mutation_missing_row_filter_is_detected() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case = CaseWorld::new(&world, policies::case_named("base"));
    let statement = Statement::Delete(Delete {
        resource: POSTS,
        predicate: Some(cmp(CmpOp::Eq, table(POSTS, 1), text("a"))),
        returning: Returning::Id,
    });
    let generated = Generated::new(&statement, &alphabet);
    let (_, outcome) = run(
        &world,
        &case,
        &case.main,
        &generated,
        Some(&drop_delete_row_filter),
    );
    assert_mutation_violation(&outcome, &generated, Db::Row, "delete");
    // The same statement without the defect is clean.
    let (_, honest) = run(&world, &case, &case.main, &generated, None);
    assert!(oracle::noninterference(&generated, &honest).is_empty());
}

/// A compiler whose UPDATE forgot the row filter reaches rows the client cannot see, and the
/// operation check (the same filter on the new row) turns that into a failure. Where the client's
/// predicate hits a row that every database hides, every database fails and nothing differs. Where
/// it hits a row only the `row` variant hides (`h2`), `row` fails while the others succeed:
/// whether the statement succeeds leaks one bit about a row the client cannot see.
#[test]
fn planted_update_missing_row_filter_is_detected() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case = CaseWorld::new(&world, policies::case_named("base"));
    let statement = Statement::Update(Update {
        resource: POSTS,
        assignments: vec![(2, Value::Lit(Lit::Text("z")))],
        predicate: Some(cmp(CmpOp::Eq, table(POSTS, 0), text("h2"))),
        returning: Returning::Id,
    });
    let generated = Generated::new(&statement, &alphabet);
    let (_, outcome) = run(
        &world,
        &case,
        &case.main,
        &generated,
        Some(&drop_update_row_filter),
    );
    assert_mutation_violation(&outcome, &generated, Db::Row, "update");
    // Only `row` differs: the failure is what tells.
    let Outcome::Executed { observations, .. } = &outcome else {
        unreachable!("{outcome:?}")
    };
    for db in DBS {
        assert_eq!(
            matches!(observations[db.index()], Ok(Obs::CheckFailed)),
            db == Db::Row,
            "{}: {:?}",
            db.name(),
            observations[db.index()]
        );
    }
    // The same statement without the defect is clean.
    let (_, honest) = run(&world, &case, &case.main, &generated, None);
    assert!(oracle::noninterference(&generated, &honest).is_empty());
}

/// A policy that lists a forbidden column as plain also lets a client filter a DELETE on it.
#[test]
fn planted_forbidden_column_in_mutation_predicate_is_detected() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case =
        CaseWorld::with_extra_regular(&world, policies::case_named("base"), &[("posts", "secret")]);
    let statement = Statement::Delete(Delete {
        resource: POSTS,
        predicate: Some(cmp(CmpOp::Eq, table(POSTS, 6), text("x"))),
        returning: Returning::Id,
    });
    let generated = Generated::new(&statement, &alphabet);
    let (_, outcome) = run(&world, &case, &case.main, &generated, None);
    assert_mutation_violation(
        &outcome,
        &generated,
        Db::Col,
        "delete on a forbidden column",
    );
}

/// A compiled `visible_if` that is always true shows a hidden conditional value: the `cond`
/// variant, which only changes such values, must tell.
#[test]
fn planted_always_visible_conditional_is_detected() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case = policies::case_named("base");
    let mut compiled = case.clone();
    compiled.resources[0].visible_if_yaml = "{ id: { neq: none } }";
    let case = CaseWorld::with_compiled_policy(&world, case, &compiled);
    // `posts.note` is the conditional column (index 3 of the full alphabet).
    let statement = projecting(Projection::Expr(col(POSTS, 3)));
    let generated = Generated::new(&statement, &alphabet);
    let (_, outcome) = run(&world, &case, &case.main, &generated, None);
    assert!(matches!(outcome, Outcome::Executed { .. }), "{outcome:?}");
    let violations = oracle::noninterference(&generated, &outcome);
    assert!(
        violations
            .iter()
            .any(|v| v.check == Check::SelectNoninterference && v.variant == Some(Db::Cond)),
        "{violations:?}"
    );
}

/// A write whose operation check fails is a failure in production (the statement rolls back), so
/// the observation is the failure and no state, whatever the databases would hold afterwards.
#[test]
fn a_failed_operation_check_is_observed_as_a_failure() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let case = CaseWorld::new(&world, policies::case_named("logic"));
    // p2 is visible through `status = 'open'` only (owner user_2): after this write it is not.
    let statement = Statement::Update(Update {
        resource: POSTS,
        assignments: vec![(2, Value::Lit(Lit::Text("x")))],
        predicate: Some(cmp(CmpOp::Eq, table(POSTS, 0), text("p2"))),
        returning: Returning::Id,
    });
    let generated = Generated::new(&statement, &alphabet);
    let (_, outcome) = run(&world, &case, &case.main, &generated, None);
    let Outcome::Executed { observations, .. } = &outcome else {
        unreachable!("{outcome:?}")
    };
    for db in DBS {
        assert!(
            matches!(observations[db.index()], Ok(Obs::CheckFailed)),
            "{}: {:?}",
            db.name(),
            observations[db.index()]
        );
    }
    assert!(oracle::noninterference(&generated, &outcome).is_empty());
}

/// What the client sees of a mutation, split the way the oracle splits it: whether everything
/// about the rows visible before the write agrees across the variants, and whether the whole
/// view afterwards does.
fn mutation_agreement(outcome: &Outcome) -> (bool, bool) {
    let Outcome::Executed { observations, .. } = outcome else {
        unreachable!("{outcome:?}")
    };
    let parts = |db: Db| match &observations[db.index()] {
        Ok(Obs::Mutation {
            changes,
            returning,
            kept,
            post_view,
        }) => (
            (*changes, returning.clone(), kept.clone()),
            post_view.clone(),
        ),
        other => unreachable!("{}: {other:?}", db.name()),
    };
    let base = parts(Db::Base);
    let others: Vec<_> = DBS[1..].iter().map(|db| parts(*db)).collect();
    (
        others.iter().all(|other| other.0 == base.0),
        others.iter().all(|other| other.1 == base.1),
    )
}

/// Runs `statement` against `case_name` twice: with the standing comparison (the oracle is
/// silent) and with the whole view compared for every resource (issue #140: what the client sees
/// of the rows it already saw agrees, the view afterwards does not).
fn assert_gap_140(case_name: &str, statement: &Statement) {
    let world = World::new();
    let alphabet = world::full_alphabet();
    let mut case = CaseWorld::new(&world, policies::case_named(case_name));
    let generated = Generated::new(statement, &alphabet);
    let (_, standing) = run(&world, &case, &case.main, &generated, None);
    assert!(
        oracle::noninterference(&generated, &standing).is_empty(),
        "the standing comparison must not see the gap: {standing:?}"
    );
    case.stable_views = [true; 3];
    let (_, everywhere) = run(&world, &case, &case.main, &generated, None);
    let (kept_agrees, view_agrees) = mutation_agreement(&everywhere);
    assert!(kept_agrees, "what the client saw before must agree");
    assert!(!view_agrees, "the view afterwards must differ (issue #140)");
}

/// Issue #140, first form: a column the client may write feeds a `visible_if`, so a legitimate
/// write unlocks a conditional value the client could not see. Records the current behaviour;
/// when #140 settles what a policy like this should do, update this test.
#[test]
fn known_gap_140_written_column_feeds_visible_if() {
    // `logic` shows comments.memo when `author_id = 'user_1' OR body = 'a'`, and a client may
    // write comments.body.
    let statement = Statement::Update(Update {
        resource: COMMENTS,
        assignments: vec![(2, Value::Lit(Lit::Text("a")))],
        predicate: None,
        returning: Returning::Id,
    });
    assert_gap_140("logic", &statement);
}

/// Issue #140, second form: a resource the client may change is the target of another resource's
/// `exists`, so deleting a parent unlocks children behind a `not exists`. Records the current
/// behaviour; update when #140 settles it.
#[test]
fn known_gap_140_changed_resource_is_an_exists_target() {
    let statement = Statement::Delete(Delete {
        resource: POSTS,
        predicate: None,
        returning: Returning::Id,
    });
    assert_gap_140("parent", &statement);
}
