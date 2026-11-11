//! Noninterference and gating, tested with generated SQL (issue #125).
//!
//! Generated statements go through the same public pipeline as production (bind, policy compile,
//! verified emission, execution) against a base database and low-equivalent variants. The tests
//! assert only that observations agree across variants and that disabled gates reject. They never
//! hold hand-written expectations. See `docs/test-plan.md` (L8) for what is and is not generated.

mod world;

use policysql_testkit::fuzz::layer1;
use std::env;

/// Settings read from the environment. An invalid value fails the test; it never silently falls
/// back to a default.
#[derive(Clone, Debug)]
struct Config {
    max_size: usize,
    mutation_max_size: usize,
}

fn env_number(name: &str, default: usize, range: std::ops::RangeInclusive<usize>) -> usize {
    match env::var(name) {
        Err(env::VarError::NotPresent) => default,
        Err(error) => unreachable!("{name} is not valid unicode: {error}"),
        Ok(raw) => {
            let value: usize = raw
                .trim()
                .parse()
                .unwrap_or_else(|error| unreachable!("{name}={raw:?} is not a number: {error}"));
            assert!(
                range.contains(&value),
                "{name}={value} is outside {range:?}"
            );
            value
        }
    }
}

impl Config {
    fn from_env() -> Self {
        Self {
            max_size: env_number("POLICYSQL_FUZZ_MAX_SIZE", 4, 4..=5),
            mutation_max_size: env_number("POLICYSQL_FUZZ_MUTATION_MAX_SIZE", 3, 3..=4),
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
