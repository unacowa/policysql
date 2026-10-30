//! Time bounds for canonicalization of hostile but in-limit bodies (#55 review). The owner
//! computes a command digest before compiling, so canonicalization must stay near linear in
//! the 1 MiB body limit. These tests live outside the crate, whose sources name no clock.

use policysql_transaction::{ParseError, canonical::parse, canonical_json};
use std::time::{Duration, Instant};

// Generous for an unoptimized test build; the earlier quadratic duplicate scan took 11 s even
// in the optimized WASM.
const BOUND: Duration = Duration::from_secs(2);

/// 20,000 keys of equal length that share a 40-character prefix, about 1 MB: the shape that
/// made the earlier per-key duplicate scan quadratic.
fn wide_object(count: usize) -> String {
    let members: Vec<String> = (0..count)
        .map(|index| format!("\"{}{index:06}\":0", "a".repeat(40)))
        .collect();
    format!("{{{}}}", members.join(","))
}

#[test]
fn wide_objects_are_linearithmic_and_still_reject_duplicates() {
    let count = 20_000;
    let text = wide_object(count);
    assert!(text.len() > 950_000 && text.len() < 1_048_576);
    let started = Instant::now();
    let canonical = canonical_json(&text);
    let elapsed = started.elapsed();
    // The keys are already in canonical order, so the canonical text is the input.
    assert_eq!(canonical.as_deref(), Ok(text.as_str()));
    assert!(elapsed < BOUND, "{elapsed:?}");

    // A duplicate anywhere is still found: of the first key and of the last.
    for index in [0, count - 1] {
        let duplicate = format!("\"{}{index:06}\"", "a".repeat(40));
        let with_duplicate = format!("{},{duplicate}:1}}", &text[..text.len() - 1]);
        let started = Instant::now();
        assert_eq!(parse(&with_duplicate), Err(ParseError));
        assert!(started.elapsed() < BOUND);
    }
    assert_eq!(parse(r#"{"b":1,"a":2,"c":3,"a":4}"#), Err(ParseError));
    assert_eq!(parse(r#"{"a":1,"b":2,"a":3}"#), Err(ParseError));
    assert!(parse(r#"{"a":1,"a\u0000":2,"A":3}"#).is_ok());
}

#[test]
fn reversed_and_nested_wide_objects_stay_fast() {
    // Keys in descending order, inside an array inside an object.
    let members: Vec<String> = (0..20_000)
        .rev()
        .map(|index| format!("\"{}{index:06}\":[{index}]", "b".repeat(30)))
        .collect();
    let text = format!("{{\"params\":[{{{}}}]}}", members.join(","));
    let started = Instant::now();
    assert!(canonical_json(&text).is_ok());
    assert!(started.elapsed() < BOUND);
}

#[test]
fn many_long_numbers_stay_fast() {
    // 17 significant digits each: the correctly rounded (`float_roundtrip`) slow path.
    let numbers: Vec<String> = (0..50_000_u64)
        .map(|index| format!("{}.{:03}", 90_071_992_547_409 + index * 7, index % 1000))
        .collect();
    let text = format!("[{}]", numbers.join(","));
    let started = Instant::now();
    assert!(canonical_json(&text).is_ok());
    assert!(started.elapsed() < BOUND);
}

#[test]
fn many_exponents_and_integral_decimals_stay_fast() {
    for make in [
        |index: u64| {
            let exponent = index % 600;
            let sign = if exponent < 300 { "-" } else { "" };
            format!(
                "{}.{}e{sign}{}",
                index % 9 + 1,
                index % 97,
                exponent.abs_diff(300)
            )
        },
        |index: u64| format!("{}.0", index * 7919),
    ] {
        let numbers: Vec<String> = (0..80_000_u64).map(make).collect();
        let text = format!("[{}]", numbers.join(","));
        assert!(text.len() > 400_000 && text.len() < 1_048_576);
        let started = Instant::now();
        assert!(canonical_json(&text).is_ok());
        assert!(started.elapsed() < BOUND);
    }
}

#[test]
fn long_strings_and_escapes_stay_fast() {
    let text = format!(
        "[\"{}\",\"{}\",\"{}\",\"{}\"]",
        "x".repeat(300_000),
        "\\u0001\\n\\\"".repeat(20_000),
        "\\ud83d\\ude00".repeat(20_000),
        "\u{1f600}".repeat(40_000)
    );
    let started = Instant::now();
    assert!(canonical_json(&text).is_ok());
    assert!(started.elapsed() < BOUND);
    // Escaped lone surrogates are rejected, quickly, wherever they are.
    let lone = format!("[\"{}\\ud800\"]", "x".repeat(900_000));
    let started = Instant::now();
    assert_eq!(parse(&lone), Err(ParseError));
    assert!(started.elapsed() < BOUND);
}
