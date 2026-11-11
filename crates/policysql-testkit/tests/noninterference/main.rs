//! Noninterference and gating, tested with generated SQL (issue #125).
//!
//! Generated statements go through the same public pipeline as production (bind, policy compile,
//! verified emission, execution) against a base database and low-equivalent variants. The tests
//! assert only that observations agree across variants and that disabled gates reject. They never
//! hold hand-written expectations. See `docs/test-plan.md` (L8) for what is and is not generated.

mod oracle;
mod pipeline;
mod planted;
mod policies;
mod report;
mod shapes;
mod variants;
mod world;

use pipeline::{CaseWorld, Generated, on_large_stack};
use policysql_testkit::fuzz::layer3::{self, LAYER3_TAG};
use policysql_testkit::fuzz::meta::{NodeKind, Slot, StatementMeta};
use policysql_testkit::fuzz::rng::mix;
use policysql_testkit::fuzz::rng::{XorShift64, splitmix64};
use policysql_testkit::fuzz::to_sql;
use policysql_testkit::fuzz::{layer1, layer2};
use report::{Expect, Floor, Identity, Tally, finish, process};
use std::collections::BTreeSet;
use std::env;
use std::time::Instant;
use world::World;

/// Settings read from the environment. An invalid value fails the test; it never silently falls
/// back to a default.
#[derive(Clone, Debug)]
struct Config {
    max_size: usize,
    mutation_max_size: usize,
    t: usize,
    rounds: u32,
    seeds: Vec<u64>,
    cases: u64,
    mutation_cases: u64,
}

fn env_raw(name: &str) -> Option<String> {
    match env::var(name) {
        Err(env::VarError::NotPresent) => None,
        Err(error) => unreachable!("{name} is not valid unicode: {error}"),
        Ok(raw) => Some(raw),
    }
}

fn env_number(name: &str, default: u64, range: std::ops::RangeInclusive<u64>) -> u64 {
    let Some(raw) = env_raw(name) else {
        return default;
    };
    let value = parse_number(name, &raw);
    assert!(
        range.contains(&value),
        "{name}={value} is outside {range:?}"
    );
    value
}

fn parse_number(name: &str, raw: &str) -> u64 {
    let raw = raw.trim();
    let parsed = match raw.strip_prefix("0x") {
        Some(hex) => u64::from_str_radix(hex, 16),
        None => raw.parse(),
    };
    parsed.unwrap_or_else(|error| unreachable!("{name}={raw:?} is not a number: {error}"))
}

fn small(name: &str, default: usize, range: std::ops::RangeInclusive<usize>) -> usize {
    let range =
        u64::try_from(*range.start()).unwrap_or(0)..=u64::try_from(*range.end()).unwrap_or(0);
    usize::try_from(env_number(name, u64::try_from(default).unwrap_or(0), range)).unwrap_or(default)
}

impl Config {
    fn from_env() -> Self {
        let seeds = if let Some(list) = env_raw("POLICYSQL_FUZZ_SEEDS") {
            let seeds: Vec<u64> = list
                .split(',')
                .map(|item| parse_number("POLICYSQL_FUZZ_SEEDS", item))
                .collect();
            assert!(!seeds.is_empty(), "POLICYSQL_FUZZ_SEEDS is empty");
            seeds
        } else {
            let count = env_number("POLICYSQL_FUZZ_SEED_COUNT", 5, 1..=10_000);
            (0..count)
                .map(|index| splitmix64(0x0125_0000 + index))
                .collect()
        };
        Self {
            max_size: small("POLICYSQL_FUZZ_MAX_SIZE", 4, 4..=5),
            mutation_max_size: small("POLICYSQL_FUZZ_MUTATION_MAX_SIZE", 3, 3..=4),
            t: small("POLICYSQL_FUZZ_T", 2, 1..=3),
            rounds: u32::try_from(env_number("POLICYSQL_FUZZ_ROUNDS", 2, 1..=1000)).unwrap_or(2),
            seeds,
            cases: env_number("POLICYSQL_FUZZ_CASES", 20_000, 1..=100_000_000),
            mutation_cases: env_number("POLICYSQL_FUZZ_MUTATION_CASES", 5_000, 1..=100_000_000),
        }
    }
}

/// Counts from an independent counter (`handoff/proto/count_l1.py`, spec 8.5).
const SELECT_COUNTS_BY_SIZE: [u64; 5] = [16, 506, 9_160, 142_612, 2_027_366];
/// Mutations by predicate size ("up to 2", "up to 3", "up to 4" in total).
const MUTATION_COUNTS_UP_TO: [u64; 3] = [1_764, 15_732, 93_636];

#[test]
fn layer1_counts_match_reference() {
    let config = Config::from_env();
    let alphabet = world::reduced_alphabet();
    let max_size = config.max_size.clamp(4, 5);
    let mut by_size = vec![0_u64; max_size + 1];
    let mut expected_ordinal = 0_u64;
    // Up to size 4 every statement renders to its own SQL. (At size 5 `x || y || z` can be built
    // two ways that print the same, so size 5 is left out of the distinctness check.)
    let mut distinct = BTreeSet::new();
    layer1::for_each_select(&alphabet, max_size, &mut |item| {
        assert_eq!(item.ordinal, expected_ordinal);
        expected_ordinal += 1;
        by_size[item.size] += 1;
        if item.size <= 4 {
            distinct.insert(to_sql(item.statement, &alphabet));
        }
    });
    assert_eq!(
        u64::try_from(distinct.len()).unwrap_or(u64::MAX),
        by_size[1..=4].iter().sum::<u64>(),
        "two SELECTs of size 4 or less render to the same SQL, or one is missing"
    );
    println!("select counts by size: {:?}", &by_size[1..]);
    assert_eq!(by_size[1..], SELECT_COUNTS_BY_SIZE[..max_size]);

    let mutation_max = config.mutation_max_size.clamp(3, 4);
    let mut by_predicate = vec![0_u64; mutation_max + 1];
    let mut distinct_mutations = BTreeSet::new();
    layer1::for_each_mutation(&alphabet, mutation_max, &mut |item| {
        by_predicate[item.size] += 1;
        if item.size <= 3 {
            distinct_mutations.insert(to_sql(item.statement, &alphabet));
        }
    });
    assert_eq!(
        u64::try_from(distinct_mutations.len()).unwrap_or(u64::MAX),
        by_predicate[..=3].iter().sum::<u64>(),
        "two mutations of predicate size 3 or less render to the same SQL, or one is missing"
    );
    let mut running = 0_u64;
    for (size, count) in by_predicate.iter().enumerate() {
        running += count;
        if size >= 2 {
            assert_eq!(
                running,
                MUTATION_COUNTS_UP_TO[size - 2],
                "predicate size {size}"
            );
        }
    }
}

#[test]
fn every_policy_case_activates_with_every_gate_variant() {
    use policies::{GateFlags, GateOff, all_cases, gate_variants, render_yaml};
    use policysql_policy::PolicyBundle;
    let world = world::World::new();
    let mut activated = 0;
    for case in all_cases() {
        let mut bundles = vec![("main".to_owned(), GateFlags::uniform(true))];
        bundles.extend(
            gate_variants()
                .into_iter()
                .map(|off: GateOff| (off.name(), off.flags())),
        );
        assert_eq!(bundles.len(), 8);
        for (name, flags) in bundles {
            let yaml = render_yaml(&case, flags, &[]);
            PolicyBundle::activate(&yaml, &world.catalog, world.snapshot.clone()).unwrap_or_else(
                |error| {
                    unreachable!(
                        "case {} / gate {name} does not activate: {error:?}\n{yaml}",
                        case.name
                    )
                },
            );
            activated += 1;
        }
    }
    assert_eq!(activated, 32);
}

#[test]
fn variants_are_low_equivalent() {
    for case in policies::all_cases() {
        let conns = variants::connections(&case);
        variants::assert_variants_low_equivalent(&case, &conns);
    }
}

/// The SELECT size bound for layer 1 in a case (spec 14.3 lets the cheaper cases shrink if the
/// time budget requires it; the defaults keep every case at the configured size).
fn select_size(_case: &str, config: &Config) -> usize {
    config.max_size
}

/// What each layer-1 test must have reached. Layer 1 is exact, so the floors are the measured
/// counts rounded down a little (a bigger configuration only enumerates more statements, so
/// they hold for every allowed configuration). Measured on the default configuration:
/// SELECT 28,654 to 28,656 statements ran on all four databases without an error and the gate was
/// effective for 26,192; mutations 2,124 (`parent`: 1,062).
fn layer1_select_expect(_case: &str) -> Expect {
    Expect {
        all_ok: Floor::Count(28_000),
        gate_effective: Floor::Count(26_000),
        features: &[],
    }
}

fn layer1_mutation_expect(case: &str) -> Expect {
    Expect {
        all_ok: Floor::Count(if case == "parent" { 1_000 } else { 2_000 }),
        gate_effective: Floor::Count(0),
        features: &[],
    }
}

/// Layer 2 reaches a share of its statements that depends on `t` (an `on` predicate other than
/// `plain` never executes, and so on). Measured shares, per mille of the statements generated:
/// all-ok 312 / 99 / 34 and gate-effective 135 / 64 / 27 for t = 1 / 2 / 3.
fn layer2_expect(t: usize) -> Expect {
    let (all_ok, gate) = match t {
        1 => (250, 100),
        2 => (90, 50),
        _ => (30, 20),
    };
    Expect {
        all_ok: Floor::PerMille(all_ok),
        gate_effective: Floor::PerMille(gate),
        features: &[],
    }
}

fn run_layer1_select(case_name: &str) {
    let config = Config::from_env();
    let world = World::new();
    let case_world = CaseWorld::new(&world, policies::case_named(case_name));
    let alphabet = world::reduced_alphabet();
    let size = select_size(case_name, &config);
    let mut tally = Tally::new("layer1-select", case_name, format!("max_size={size}"));
    let started = Instant::now();
    layer1::for_each_select(&alphabet, size, &mut |item| {
        let generated = Generated::new(item.statement, &alphabet);
        process(
            &world,
            &case_world,
            &alphabet,
            &generated,
            &mut tally,
            &|| Identity {
                label: format!("ordinal={} size={}", item.ordinal, item.size),
                seed_key: String::new(),
                position: item.ordinal.to_string(),
            },
            None,
        );
    });
    finish(
        &tally,
        started.elapsed().as_secs_f64(),
        &layer1_select_expect(case_name),
    );
}

fn run_layer1_mutation(case_name: &str) {
    let config = Config::from_env();
    let world = World::new();
    let case_world = CaseWorld::new(&world, policies::case_named(case_name));
    let alphabet = world::reduced_alphabet();
    let size = config.mutation_max_size;
    let mut tally = Tally::new(
        "layer1-mutation",
        case_name,
        format!("max_predicate_size={size}"),
    );
    let started = Instant::now();
    layer1::for_each_mutation(&alphabet, size, &mut |item| {
        let generated = Generated::new(item.statement, &alphabet);
        process(
            &world,
            &case_world,
            &alphabet,
            &generated,
            &mut tally,
            &|| Identity {
                label: format!("ordinal={} predicate_size={}", item.ordinal, item.size),
                seed_key: String::new(),
                position: item.ordinal.to_string(),
            },
            None,
        );
    });
    finish(
        &tally,
        started.elapsed().as_secs_f64(),
        &layer1_mutation_expect(case_name),
    );
}

macro_rules! per_case {
    ($run:ident: $($name:ident => $case:literal),+ $(,)?) => {
        $(
            #[test]
            fn $name() {
                on_large_stack(|| $run($case));
            }
        )+
    };
}

/// Like `per_case!`, for the nightly tests that `cargo test` skips.
macro_rules! per_case_nightly {
    ($run:ident: $($name:ident => $case:literal),+ $(,)?) => {
        $(
            #[test]
            #[ignore = "nightly: millions of statements; see docs/test-plan.md (L8)"]
            fn $name() {
                on_large_stack(|| $run($case));
            }
        )+
    };
}

per_case!(run_layer1_select:
    layer1_select_base => "base",
    layer1_select_logic => "logic",
    layer1_select_parent => "parent",
    layer1_select_limited => "limited",
);

per_case!(run_layer1_mutation:
    layer1_mutation_base => "base",
    layer1_mutation_logic => "logic",
    layer1_mutation_parent => "parent",
    layer1_mutation_limited => "limited",
);

/// The renderer produces exactly the SQL the binder is known to accept (spec 7.3).
#[test]
fn render_shapes_bind() {
    use policysql_parser::SqliteFrontend;
    use policysql_testkit::fuzz::to_sql;
    let world = World::new();
    let alphabet = world::full_alphabet();
    for (statement, expected) in shapes::shapes() {
        let sql = to_sql(&statement, &alphabet);
        assert_eq!(sql, expected);
        SqliteFrontend::default()
            .bind(&sql, &world.catalog)
            .unwrap_or_else(|error| unreachable!("`{sql}` no longer binds: {error}"));
    }
}

/// The hand-written SQL twin of every policy predicate agrees with what the compiler produces for
/// the same policy. This pins `filter_sql` / `visible_if_sql` to the YAML; the low-equivalence
/// check itself never uses the compiler.
///
/// The policy limit would cut the comparison to the first rows (2 of 4 posts in `limited`), so the
/// predicates are compared on every visible row with the limit removed, and the limit is checked
/// on its own: with it, the compiler returns exactly the first `limit` of those rows.
#[test]
fn policy_mirror_matches_compiler() {
    on_large_stack(policy_mirror_body);
}

fn policy_mirror_body() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    for case in policies::all_cases() {
        let mut unlimited = case.clone();
        for policy in &mut unlimited.resources {
            policy.limit = None;
        }
        let unlimited = CaseWorld::new(&world, unlimited);
        let limited = CaseWorld::new(&world, case);
        for db in variants::DBS {
            for (index, policy) in unlimited.case.resources.iter().enumerate() {
                let context = format!(
                    "case {} db {} resource {}",
                    limited.case.name,
                    db.name(),
                    policy.resource
                );
                let expected = variants::query_rows(
                    &unlimited.mutation_dbs[db.index()],
                    &variants::view_sql(index, policy, "id"),
                );
                let actual = pipeline::compiler_view(&world, &unlimited, db, &alphabet, index)
                    .unwrap_or_else(|error| unreachable!("{context}: {error}"));
                assert_eq!(
                    actual, expected,
                    "{context}: compiler and hand-written view differ"
                );
                let kept = limited.case.resources[index]
                    .limit
                    .map_or(expected.len(), |limit| {
                        expected
                            .len()
                            .min(usize::try_from(limit).unwrap_or(usize::MAX))
                    });
                let with_limit = pipeline::compiler_view(&world, &limited, db, &alphabet, index)
                    .unwrap_or_else(|error| unreachable!("{context}: {error}"));
                assert_eq!(
                    with_limit,
                    expected[..kept],
                    "{context}: the policy limit does not keep exactly the first {kept} rows"
                );
            }
        }
    }
}

/// `round` must contain every (cell, root) pair exactly once, for every strength.
#[test]
fn layer2_round_covers_every_cell_once() {
    let roots = [0, 1, 2];
    for (t, expected) in [(1, 96), (2, 1_248), (3, 7_392)] {
        let cells = layer2::cells(t);
        let pairs = layer2::round(&cells, &roots, 0x0125, 0);
        assert_eq!(pairs.len(), expected, "t={t}");
        assert_exactly_once(&pairs, cells.len(), &roots);
    }
}

fn assert_exactly_once(pairs: &[(usize, usize)], cells: usize, roots: &[usize]) {
    let mut seen = vec![0_u32; cells * roots.len()];
    for (cell, root) in pairs {
        let root_index = roots
            .iter()
            .position(|candidate| candidate == root)
            .unwrap_or_else(|| unreachable!("root {root} is not in the round"));
        seen[cell * roots.len() + root_index] += 1;
    }
    assert!(
        seen.iter().all(|count| *count == 1),
        "a (cell, root) pair is missing or repeated in the round"
    );
    assert_eq!(pairs.len(), cells * roots.len());
}

/// The statement really has what its cell says: every assigned level puts its shape in its slot,
/// and a slot without a level holds no EXISTS, `COUNT(*) >` or protected column. The generator
/// builds each statement from the cell, so a factor it forgot to read (or a level it replaced by
/// something else) would otherwise go unnoticed: the cell count and the round check only look at
/// the table of cells, never at the statements.
fn assert_cell_instantiated(cell: &layer2::Cell, meta: &StatementMeta, context: &str) {
    use layer2::{FACTORS, FactorSlot, LEVELS, PredicateShape};
    let guarded = [
        NodeKind::Exists,
        NodeKind::CountGt,
        NodeKind::ForbiddenColumn,
        NodeKind::ConditionalColumn,
    ];
    for (index, factor) in FACTORS.iter().enumerate() {
        let slot = match factor.slot {
            FactorSlot::ProjectionCase => Slot::Projection,
            FactorSlot::JoinOn => Slot::JoinOn,
            FactorSlot::Where => Slot::Where,
            FactorSlot::Having => Slot::Having,
        };
        let count = |node| meta.slot_nodes.get(&(slot, node)).copied().unwrap_or(0);
        let shape = cell
            .assignments
            .iter()
            .find(|(assigned, _)| *assigned == index)
            .map(|(_, level)| LEVELS[*level].shape);
        let (required, allowed): (&[NodeKind], &[NodeKind]) = match shape {
            None => (&[], &[]),
            Some(PredicateShape::Plain) => (&[NodeKind::RegularColumn], &[]),
            Some(
                PredicateShape::ExistsCorrelated
                | PredicateShape::ExistsUncorrelated
                | PredicateShape::ExistsOuterOnly,
            ) => (&[NodeKind::Exists], &[NodeKind::Exists]),
            Some(PredicateShape::NotExistsCorrelated) => {
                (&[NodeKind::Exists, NodeKind::Not], &[NodeKind::Exists])
            }
            Some(PredicateShape::Count) => (&[NodeKind::CountGt], &[NodeKind::CountGt]),
            Some(PredicateShape::Forbidden) => {
                (&[NodeKind::ForbiddenColumn], &[NodeKind::ForbiddenColumn])
            }
            Some(PredicateShape::Conditional) => (
                &[NodeKind::ConditionalColumn],
                &[NodeKind::ConditionalColumn],
            ),
        };
        for node in required {
            assert!(
                count(*node) > 0,
                "{context}: factor {} level {shape:?} has no {node:?} in {slot:?}: {:?}",
                factor.name,
                meta.slot_nodes
            );
        }
        for node in guarded {
            assert!(
                allowed.contains(&node) || count(node) == 0,
                "{context}: factor {} level {shape:?} has {node:?} in {slot:?}: {:?}",
                factor.name,
                meta.slot_nodes
            );
        }
        if matches!(
            shape,
            Some(PredicateShape::ExistsCorrelated | PredicateShape::NotExistsCorrelated)
        ) {
            assert!(
                meta.correlated_exists,
                "{context}: factor {} asks for a correlated EXISTS and gets none",
                factor.name
            );
        }
    }
}

fn run_layer2_select(case_name: &str) {
    let config = Config::from_env();
    let world = World::new();
    let case_world = CaseWorld::new(&world, policies::case_named(case_name));
    let alphabet = world::full_alphabet();
    let cells = layer2::cells(config.t);
    let names: Vec<String> = cells.iter().map(layer2::cell_name).collect();
    let roots: Vec<usize> = (0..alphabet.resources.len()).collect();
    let mut tally = Tally::new(
        "layer2-select",
        case_name,
        format!(
            "t={} rounds={} seeds={}",
            config.t,
            config.rounds,
            config.seeds.len()
        ),
    );
    let started = Instant::now();
    for seed in &config.seeds {
        for round in 0..config.rounds {
            let pairs = layer2::round(&cells, &roots, *seed, round);
            assert_exactly_once(&pairs, cells.len(), &roots);
            tally.rounds.push(format!(
                "round {seed:#x}/{round}: {} items, every (cell, root) exactly once",
                pairs.len()
            ));
            for (index, (cell, root)) in pairs.iter().enumerate() {
                let mut rng = XorShift64::new(layer2::statement_seed(*seed, round, index));
                let statement = layer2::instantiate(&cells[*cell], *root, &alphabet, &mut rng);
                let generated = Generated::new(&statement, &alphabet);
                assert_cell_instantiated(
                    &cells[*cell],
                    &generated.meta,
                    &format!("seed={seed:#x} round={round} index={index} root={root}"),
                );
                process(
                    &world,
                    &case_world,
                    &alphabet,
                    &generated,
                    &mut tally,
                    &|| Identity {
                        label: format!(
                            "seed={seed:#x} round={round} index={index} cell={} root={root}",
                            names[*cell]
                        ),
                        seed_key: format!("{seed:#x}"),
                        position: format!("{seed:#x}/{round}/{index}"),
                    },
                    Some(&names[*cell]),
                );
            }
        }
    }
    finish(
        &tally,
        started.elapsed().as_secs_f64(),
        &layer2_expect(config.t),
    );
}

per_case!(run_layer2_select:
    layer2_select_base => "base",
    layer2_select_logic => "logic",
    layer2_select_parent => "parent",
    layer2_select_limited => "limited",
);

/// How many statements per seed layer 3 draws, and whether the run is the small sample that every
/// `cargo test` takes or the nightly volume.
#[derive(Clone, Copy, Debug)]
enum Volume {
    /// A prefix of the nightly stream (statement `i` of a seed is the same either way), small
    /// enough to run on every pull request: it reaches `OR`, parameters, CTEs, derived tables and
    /// correlated EXISTS, which layers 1 and 2 cannot (their predicates have no `OR`, and no
    /// parameters or derived sources).
    Sample,
    Nightly,
}

const SAMPLE_SELECT_CASES: u64 = 600;
const SAMPLE_MUTATION_CASES: u64 = 200;

/// The number of seeds the sample's floors were measured with (the default). Statements of one
/// seed are not independent (they share a stream), so a floor that holds for five seeds can fail
/// for a single one without anything being wrong.
const SAMPLE_CALIBRATED_SEEDS: usize = 5;

/// Floors for layer 3, per mille of the statements generated, from the measured rates (SELECT
/// about 530, mutation about 560 and, in `parent`, about 270 statements per thousand succeeded on
/// all four databases; the gate was effective for about 230 per thousand SELECTs).
///
/// The sample is also run with `POLICYSQL_FUZZ_SEEDS` set to replay a seed. With fewer seeds than
/// it was measured with, the rates are noisier (measured over single seeds: down to 166 per
/// thousand in `parent` mutation, and `OR` appears twice in a seed's `parent` mutations) so the
/// floors are a quarter of the calibrated ones and the feature assertions, which count a handful
/// of statements, are left to the calibrated run. What stays is the point of the floors: a layer
/// that reached next to nothing fails.
fn layer3_expect(case: &str, mutation: bool, volume: Volume, seeds: usize) -> Expect {
    let all_ok = match (mutation, case) {
        (true, "parent") => 150,
        (true, _) => 450,
        (false, _) => 400,
    };
    let gate = if mutation { 0 } else { 150 };
    let calibrated = !matches!(volume, Volume::Sample) || seeds >= SAMPLE_CALIBRATED_SEEDS;
    let scale = |per_mille: u64| if calibrated { per_mille } else { per_mille / 4 };
    let features: &'static [&'static str] = match (calibrated, mutation) {
        (false, _) => &[],
        // An EXISTS in an UPDATE / DELETE predicate never gets past the policy stage.
        (true, true) => &["or", "parameter"],
        (true, false) => &[
            "or",
            "parameter",
            "cte",
            "derived-table",
            "correlated-exists",
        ],
    };
    Expect {
        all_ok: Floor::PerMille(scale(all_ok)),
        gate_effective: Floor::PerMille(scale(gate)),
        features,
    }
}

/// A 64-bit fingerprint of a statement (FNV-1a over the SQL and the parameters), to skip a
/// statement the generator drew twice. A collision would skip a distinct statement, which costs a
/// little coverage and nothing else.
fn fingerprint(generated: &Generated) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    let text = format!("{}\u{0}{:?}", generated.sql, generated.params);
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn run_layer3(case_name: &str, mutation: bool, volume: Volume) {
    let config = Config::from_env();
    let world = World::new();
    let case_world = CaseWorld::new(&world, policies::case_named(case_name));
    let alphabet = world::full_alphabet();
    let layer3_config = world::layer3_config();
    let cases = match (volume, mutation) {
        (Volume::Sample, false) => SAMPLE_SELECT_CASES,
        (Volume::Sample, true) => SAMPLE_MUTATION_CASES,
        (Volume::Nightly, false) => config.cases,
        (Volume::Nightly, true) => config.mutation_cases,
    };
    let name = match (volume, mutation) {
        (Volume::Sample, false) => "layer3-sample-select",
        (Volume::Sample, true) => "layer3-sample-mutation",
        (Volume::Nightly, false) => "layer3-select",
        (Volume::Nightly, true) => "layer3-mutation",
    };
    let mut tally = Tally::new(
        name,
        case_name,
        format!("cases={cases} seeds={}", config.seeds.len()),
    );
    let started = Instant::now();
    for seed in &config.seeds {
        let mut seen = BTreeSet::new();
        for index in 0..cases {
            let mut rng = XorShift64::new(mix(&[*seed, LAYER3_TAG, index]));
            let statement = if mutation {
                layer3::random_mutation(&alphabet, &mut rng, &layer3_config)
            } else {
                layer3::random_select(&alphabet, &mut rng, &layer3_config)
            };
            let generated = Generated::new(&statement, &alphabet);
            if !seen.insert(fingerprint(&generated)) {
                tally.duplicates += 1;
                continue;
            }
            process(
                &world,
                &case_world,
                &alphabet,
                &generated,
                &mut tally,
                &|| Identity {
                    label: format!("seed={seed:#x} index={index}"),
                    seed_key: format!("{seed:#x}"),
                    position: format!("{seed:#x}/{index}"),
                },
                None,
            );
        }
    }
    finish(
        &tally,
        started.elapsed().as_secs_f64(),
        &layer3_expect(case_name, mutation, volume, config.seeds.len()),
    );
}

fn run_layer3_sample_select(case_name: &str) {
    run_layer3(case_name, false, Volume::Sample);
}

fn run_layer3_sample_mutation(case_name: &str) {
    run_layer3(case_name, true, Volume::Sample);
}

fn run_layer3_select(case_name: &str) {
    run_layer3(case_name, false, Volume::Nightly);
}

fn run_layer3_mutation(case_name: &str) {
    run_layer3(case_name, true, Volume::Nightly);
}

per_case!(run_layer3_sample_select:
    layer3_sample_select_base => "base",
    layer3_sample_select_logic => "logic",
    layer3_sample_select_parent => "parent",
    layer3_sample_select_limited => "limited",
);

per_case!(run_layer3_sample_mutation:
    layer3_sample_mutation_base => "base",
    layer3_sample_mutation_logic => "logic",
    layer3_sample_mutation_parent => "parent",
    layer3_sample_mutation_limited => "limited",
);

per_case_nightly!(run_layer3_select:
    layer3_select_base => "base",
    layer3_select_logic => "logic",
    layer3_select_parent => "parent",
    layer3_select_limited => "limited",
);

per_case_nightly!(run_layer3_mutation:
    layer3_mutation_base => "base",
    layer3_mutation_logic => "logic",
    layer3_mutation_parent => "parent",
    layer3_mutation_limited => "limited",
);
