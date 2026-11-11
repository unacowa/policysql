//! Noninterference and gating, tested with generated SQL (issue #125).
//!
//! Generated statements go through the same public pipeline as production (bind, policy compile,
//! verified emission, execution) against a base database and low-equivalent variants. The tests
//! assert only that observations agree across variants and that disabled gates reject. They never
//! hold hand-written expectations. See `docs/test-plan.md` (L8) for what is and is not generated.

// TEMPORARY(#125 step 3-12): removed once every helper is used.
#![allow(dead_code)]

mod oracle;
mod pipeline;
mod planted;
mod policies;
mod report;
mod shapes;
mod variants;
mod world;

use pipeline::{CaseWorld, Generated};
use policysql_testkit::fuzz::rng::{XorShift64, splitmix64};
use policysql_testkit::fuzz::{layer1, layer2};
use report::{Identity, Tally, finish, process};
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
    layer1::for_each_select(&alphabet, max_size, &mut |item| {
        assert_eq!(item.ordinal, expected_ordinal);
        expected_ordinal += 1;
        by_size[item.size] += 1;
    });
    println!("select counts by size: {:?}", &by_size[1..]);
    assert_eq!(by_size[1..], SELECT_COUNTS_BY_SIZE[..max_size]);

    let mutation_max = config.mutation_max_size.clamp(3, 4);
    let mut by_predicate = vec![0_u64; mutation_max + 1];
    layer1::for_each_mutation(&alphabet, mutation_max, &mut |item| {
        by_predicate[item.size] += 1;
    });
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
    finish(&tally, started.elapsed().as_secs_f64());
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
    finish(&tally, started.elapsed().as_secs_f64());
}

macro_rules! per_case {
    ($run:ident: $($name:ident => $case:literal),+ $(,)?) => {
        $(
            #[test]
            fn $name() {
                $run($case);
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
#[test]
fn policy_mirror_matches_compiler() {
    let world = World::new();
    let alphabet = world::full_alphabet();
    for case in policies::all_cases() {
        let case_world = CaseWorld::new(&world, case);
        for db in variants::DBS {
            for (index, policy) in case_world.case.resources.iter().enumerate() {
                let limit = policy
                    .limit
                    .map_or(String::new(), |n| format!(" LIMIT {n}"));
                let expected = variants::query_rows(
                    &case_world.mutation_dbs[db.index()],
                    &format!("{}{limit}", variants::view_sql(index, policy, "id")),
                );
                let actual = pipeline::compiler_view(&world, &case_world, db, &alphabet, index)
                    .unwrap_or_else(|error| {
                        unreachable!(
                            "{} {} {}: {error}",
                            case_world.case.name,
                            db.name(),
                            policy.resource
                        )
                    });
                assert_eq!(
                    actual,
                    expected,
                    "case {} db {} resource {}: compiler and hand-written view differ",
                    case_world.case.name,
                    db.name(),
                    policy.resource
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
    finish(&tally, started.elapsed().as_secs_f64());
}

per_case!(run_layer2_select:
    layer2_select_base => "base",
    layer2_select_logic => "logic",
    layer2_select_parent => "parent",
    layer2_select_limited => "limited",
);
