//! The result budget of the runtime (ADR 0027 pull request 6): raw values counted at the limit
//! and one over, and the compiled raw result bound against the Hrana encoding of results that
//! pass every configured limit.
//!
//! The property: a result whose raw values are within `maxJsonValues` and whose public encoding
//! is within `maxResultBytes` fits the raw bound the compiler derived for its statement, when
//! the database frames it as Hrana does (typed cells, a column descriptor with its declared
//! type, the counters, and a baton of up to 512 characters). The generator covers conditional
//! (`visible_if`) columns with their companion cells, RETURNING with the check column,
//! one-character and long aliases, JSON-escaped text, base64 BLOBs, and multi-byte text, near the
//! limits.

#![allow(clippy::too_many_lines, clippy::cast_possible_truncation)]

use super::PolicySqlRuntime;
use policysql_core::bytes::encode;
use policysql_transaction::machine::ResultBudget;
use proptest::prelude::*;
use serde_json::{Value, json};

const CATALOG: &str = include_str!("../../../tests/fixtures/bytes/catalog.yaml");
const POLICY: &str = include_str!("../../../tests/fixtures/bytes/policy.yaml");
const PHYSICAL: &str = include_str!("../../../tests/fixtures/bytes/physical-schema.json");
const AUTH: &str = r#"{"principal":"test:user","subject":"u","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_a"}}"#;

const MAX_RESULT_BYTES: u64 = 4_000;
const MAX_JSON_VALUES: u64 = 1_024;

fn runtime(max_result_bytes: u64, max_json_values: u64) -> PolicySqlRuntime {
    PolicySqlRuntime::new_with_physical_schema(
        CATALOG,
        POLICY,
        "bytes_schema",
        "bytes_policy",
        &format!(
            r#"{{"max_rows":1000,"max_result_bytes":{max_result_bytes},"timeout_ms":1000,"max_statements":8,"max_json_values":{max_json_values}}}"#
        ),
        PHYSICAL,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"))
}

/// A statement under test: its SQL and parameters, and the declared type of the physical column
/// each projection reads (`None` for an expression, which Hrana reports without one).
struct Shape {
    sql: String,
    params: Value,
    declared: Vec<Option<&'static str>>,
}

fn shapes() -> Vec<Shape> {
    let long_a = "a".repeat(120);
    let long_b = "é".repeat(60);
    vec![
        Shape {
            sql: "SELECT id, name FROM projects".to_owned(),
            params: json!({}),
            declared: vec![Some("TEXT"), Some("TEXT")],
        },
        // A conditional column: a visibility companion follows it in the raw result.
        Shape {
            sql: "SELECT private_state, id FROM projects".to_owned(),
            params: json!({}),
            declared: vec![Some("BLOB"), Some("TEXT")],
        },
        Shape {
            sql: "SELECT id AS a, name AS b, state AS c, metadata AS d, seed AS e, private_state AS f FROM projects".to_owned(),
            params: json!({}),
            declared: vec![
                Some("TEXT"),
                Some("TEXT"),
                Some("BLOB"),
                Some("TEXT"),
                Some("BLOB"),
                Some("BLOB"),
            ],
        },
        Shape {
            sql: format!(
                r#"SELECT id AS "{long_a}", metadata AS "{long_b}", private_state AS "z" FROM projects"#
            ),
            params: json!({}),
            declared: vec![Some("TEXT"), Some("TEXT"), Some("BLOB")],
        },
        // RETURNING with the check column.
        Shape {
            sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id, name, state, seed, metadata"
                .to_owned(),
            params: json!({"id": "n", "name": "n"}),
            declared: vec![
                Some("TEXT"),
                Some("TEXT"),
                Some("BLOB"),
                Some("BLOB"),
                Some("TEXT"),
            ],
        },
        Shape {
            sql: "UPDATE projects SET name=:n WHERE id='seed' RETURNING id".to_owned(),
            params: json!({"n": "x"}),
            declared: vec![Some("TEXT")],
        },
        // No RETURNING: the check column alone.
        Shape {
            sql: "INSERT INTO projects(id,name) VALUES(:id,:name)".to_owned(),
            params: json!({"id": "n", "name": "n"}),
            declared: vec![],
        },
    ]
}

/// One physical column of a statement's raw result.
struct Physical {
    name: String,
    /// The declared type Hrana reports (`None`: an expression).
    declared: Option<&'static str>,
    kind: Kind,
    /// A visibility companion (as opposed to the check column).
    companion: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Text,
    Bytes,
    Json,
    /// A visibility companion or the check column.
    Flag,
}

/// The raw columns of a compiled statement, from its plan (so the test and the compiler agree on
/// the shape), and the handle.
fn compile(runtime: &PolicySqlRuntime, shape: &Shape) -> (u64, Vec<Physical>, bool) {
    let output: Value = serde_json::from_str(&runtime.compile_json(
        AUTH,
        &json!({"statements":[{"sql": shape.sql, "params": shape.params}]}).to_string(),
        "execute",
    ))
    .unwrap_or_else(|_| unreachable!());
    let handle = output["executionHandle"]
        .as_u64()
        .unwrap_or_else(|| unreachable!("{}: {output}", shape.sql));
    let plans = runtime.plans.borrow();
    let plan = &plans[&handle].statements[0].plan;
    let mut columns = Vec::new();
    for (index, descriptor) in plan.result().iter().enumerate() {
        let kind = match descriptor.possible_types.first() {
            Some(policysql_core::LogicalType::Bytes) => Kind::Bytes,
            Some(policysql_core::LogicalType::Json) => Kind::Json,
            _ => Kind::Text,
        };
        columns.push(Physical {
            name: descriptor.name.as_str().to_owned(),
            declared: shape.declared.get(index).copied().flatten(),
            kind,
            companion: false,
        });
        if let Some(companion) = &descriptor.visibility_column {
            columns.push(Physical {
                name: companion.as_str().to_owned(),
                declared: None,
                kind: Kind::Flag,
                companion: true,
            });
        }
    }
    let check = plan.operation_check_column().is_some();
    if let Some(check_column) = plan.operation_check_column() {
        columns.push(Physical {
            name: check_column.as_str().to_owned(),
            declared: None,
            kind: Kind::Flag,
            companion: false,
        });
    }
    (handle, columns, check)
}

/// Text that stresses JSON escaping and UTF-8: quotes, backslashes, controls, 2-, 3-, and 4-byte
/// characters.
fn text_of(seed: u64, length: usize) -> String {
    const PIECES: [&str; 9] = ["a", "\"", "\\", "\n", "\u{1}", "é", "日", "🙂", "z"];
    let mut state = seed | 1;
    let mut out = String::new();
    while out.len() < length {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out.push_str(PIECES[usize::try_from(state % 9).unwrap_or(0)]);
    }
    out
}

/// One cell: the private ABI value (what the host hands core) and its Hrana form.
fn cell(column: &Physical, visible: bool, seed: u64, length: usize) -> (Value, Value) {
    match column.kind {
        Kind::Flag => (json!(1), json!({"type": "integer", "value": "1"})),
        _ if !visible => (Value::Null, json!({"type": "null"})),
        Kind::Text => {
            let text = text_of(seed, length);
            (json!(text), json!({"type": "text", "value": text}))
        }
        Kind::Json => {
            // A JSON document whose string holds escapes: the raw cell is its text, whose quotes
            // and backslashes double when the text is a Hrana string.
            let document = serde_json::to_string(&json!({"k": text_of(seed, length), "n": [1, 2]}))
                .unwrap_or_default();
            (json!(document), json!({"type": "text", "value": document}))
        }
        Kind::Bytes => {
            let bytes: Vec<u8> = (0..length / 2)
                .map(|index| u8::try_from((seed + index as u64) % 251).unwrap_or(0))
                .collect();
            // Hrana's STANDARD_NO_PAD form is never longer than the padded one.
            let padded = encode(&bytes);
            (
                json!({"type": "blob", "base64": padded}),
                json!({"type": "blob", "base64": padded.trim_end_matches('=')}),
            )
        }
    }
}

/// The raw result of `rows` rows, in both forms, and the length of the Hrana text of the whole
/// reply. With `hide`, some conditional values are hidden (NULL, companion 0).
fn generate(
    columns: &[Physical],
    check: bool,
    rows: usize,
    seed: u64,
    length: usize,
    hide: bool,
) -> (String, usize) {
    let mut private_rows = Vec::new();
    let mut hrana_rows = Vec::new();
    for row in 0..rows {
        let mut private = Vec::new();
        let mut hrana = Vec::new();
        let mut index = 0;
        while index < columns.len() {
            let column = &columns[index];
            if column.kind == Kind::Flag {
                // The check column (companions are emitted with their value below).
                let (value, wire) = cell(column, true, 0, 0);
                private.push(value);
                hrana.push(wire);
                index += 1;
                continue;
            }
            let has_companion = columns
                .get(index + 1)
                .is_some_and(|next| next.kind == Kind::Flag && next.companion);
            let visible = !(has_companion && hide && (row + index) % 2 == 1);
            let cell_seed = seed.wrapping_add((row * 97 + index) as u64);
            let (value, wire) = cell(column, visible, cell_seed, length);
            private.push(value);
            hrana.push(wire);
            if has_companion {
                let flag = i64::from(visible);
                private.push(json!(flag));
                hrana.push(json!({"type": "integer", "value": flag.to_string()}));
                index += 1;
            }
            index += 1;
        }
        private_rows.push(private);
        hrana_rows.push(hrana);
    }
    let names: Vec<&str> = columns.iter().map(|column| column.name.as_str()).collect();
    // A SELECT affects nothing; a mutation's rows are the rows it changed.
    let affected = if check { rows } else { 0 };
    let raw = json!({"columns": names, "rows": private_rows, "affectedRows": affected}).to_string();
    let hrana = json!({
        "baton": "b".repeat(512),
        "base_url": null,
        "results": [{
            "type": "ok",
            "response": {"type": "execute", "result": {
                "cols": columns.iter().map(|column| json!({
                    "name": column.name,
                    "decltype": column.declared,
                })).collect::<Vec<_>>(),
                "rows": hrana_rows,
                "affected_row_count": 9_007_199_254_740_991_u64,
                "last_insert_rowid": "-9223372036854775808",
                "replication_index": "9223372036854775807",
                "rows_read": 9_007_199_254_740_991_u64,
                "rows_written": 9_007_199_254_740_991_u64,
                "query_duration_ms": f64::MAX,
            }},
        }],
    })
    .to_string();
    (raw, hrana.len())
}

/// The exact length of `JSON.stringify` of the rows as objects, as the machine counts them.
fn public_bytes(validated: &super::ValidatedExecuteResult) -> u64 {
    let rows: Vec<Value> = validated
        .rows
        .iter()
        .map(|row| {
            Value::Object(
                validated
                    .columns
                    .iter()
                    .cloned()
                    .zip(row.iter().cloned())
                    .collect(),
            )
        })
        .collect();
    u64::try_from(serde_json::to_string(&rows).unwrap_or_default().len()).unwrap_or(u64::MAX)
}

fn unbounded_raw(values: u64) -> ResultBudget {
    ResultBudget {
        raw_bytes: u64::MAX,
        values,
        result_bytes: u64::MAX,
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

    /// A result that passes the configured limits fits the compiled raw bound, as Hrana frames it.
    #[test]
    fn a_result_within_the_configured_limits_fits_the_compiled_raw_bound(
        shape in 0_usize..7,
        rows_permille in 0_usize..=1_000,
        fill_permille in 0_usize..=1_300,
        seed in any::<u64>(),
        hide in any::<bool>(),
    ) {
        let runtime = runtime(MAX_RESULT_BYTES, MAX_JSON_VALUES);
        let shapes = shapes();
        let (handle, columns, check) = compile(&runtime, &shapes[shape]);
        let per_row = columns.len().max(1);
        // Rows up to what the value limit admits after the column descriptors.
        let most = usize::try_from(MAX_JSON_VALUES).unwrap_or(0).saturating_sub(columns.len()) / per_row;
        let rows = most.min(1000) * rows_permille / 1_000;
        // An INSERT of one row changes one row; an UPDATE any few.
        let rows = if shapes[shape].sql.starts_with("INSERT") {
            1
        } else if check {
            rows.min(8)
        } else {
            rows
        };
        let cells = (rows * per_row).max(1);
        let length = usize::try_from(MAX_RESULT_BYTES).unwrap_or(0) * fill_permille / 1_000 / cells;
        let (raw, hrana_len) = generate(&columns, check, rows, seed, length, hide);
        let bound = usize::try_from(runtime.raw_result_bound(handle).unwrap_or(0)).unwrap_or(0);
        // The raw bound is a bound on the database's text; the step event holds the private form,
        // which is never larger.
        prop_assert!(raw.len() <= hrana_len, "private {} hrana {hrana_len}", raw.len());
        // Within the configured limits (values counted by core, public bytes measured exactly)?
        let validated = runtime.validate_result_within(handle, 0, &raw, unbounded_raw(MAX_JSON_VALUES));
        match validated {
            Ok(validated) => {
                if public_bytes(&validated) <= MAX_RESULT_BYTES {
                    prop_assert!(
                        hrana_len <= bound,
                        "shape {shape}: rows {rows} length {length}: hrana {hrana_len} > bound {bound}"
                    );
                }
            }
            // The generator keeps the values within the limit and the result well formed, so the
            // only refusal is the result-byte limit: nothing else may reject a generated result.
            Err(error) => prop_assert!(
                matches!(error, super::RuntimeError::Rejected(super::RejectionKind::LimitExceeded)),
                "{error:?}"
            ),
        }
        runtime.release_execution(handle);
    }
}

/// The values of a result are counted exactly: the column descriptors, every cell (companions and
/// the check column included), and every value inside a JSON cell; at the limit it is served,
/// one over it is 413, and the same text with fewer values is not.
#[test]
fn raw_values_are_counted_at_the_limit_and_one_over() {
    let runtime = runtime(MAX_RESULT_BYTES * 100, 1_024);
    let shapes = shapes();
    // `SELECT id, name`: 2 descriptors and 2 cells per row. 1,024 = 2 + 2 × 511 + 0 is even, so
    // use `private_state, id` (3 physical columns with the companion): 3 + 3 × 340 = 1,023, then
    // a 1-column result adds 1: 1,024.
    let (handle, columns, check) = compile(&runtime, &shapes[1]);
    assert_eq!(columns.len(), 3, "a conditional column has a companion");
    let at = |rows: usize| generate(&columns, check, rows, 7, 1, false).0;
    let budget = ResultBudget {
        raw_bytes: u64::MAX,
        values: 1_024,
        result_bytes: u64::MAX,
    };
    // 3 + 3 × 340 = 1,023 values: served. 3 + 3 × 341 = 1,026: over.
    let first = runtime.validate_result_within(handle, 0, &at(340), budget);
    assert!(first.is_ok(), "{first:?}");
    let over = runtime.validate_result_within(handle, 0, &at(341), budget);
    assert!(
        matches!(
            over,
            Err(super::RuntimeError::Rejected(
                super::RejectionKind::LimitExceeded
            ))
        ),
        "{over:?}"
    );
    // The reported consumption is the count.
    let served = runtime
        .validate_result_within(handle, 0, &at(340), budget)
        .unwrap_or_else(|_| unreachable!());
    assert_eq!(served.values, 1_023);
    // Exactly the limit: 1,024 values in a 4-column result (RETURNING with the check column).
    let (returning, columns, check) = compile(&runtime, &shapes[5]);
    assert_eq!(columns.len(), 2, "id and the check column");
    let rows = |count: usize| generate(&columns, check, count, 3, 1, false).0;
    // 2 + 2 × 511 = 1,024.
    let exact = runtime
        .validate_result_within(returning, 0, &rows(511), budget)
        .unwrap_or_else(|_| unreachable!());
    assert_eq!(exact.values, 1_024);
    assert!(
        runtime
            .validate_result_within(returning, 0, &rows(512), budget)
            .is_err()
    );
}

/// Values inside a JSON-typed cell count, with the cell itself and the descriptor.
#[test]
fn the_values_inside_a_json_cell_are_counted() {
    let runtime = runtime(MAX_RESULT_BYTES * 100, 1_024);
    let (handle, _, _) = compile(
        &runtime,
        &Shape {
            sql: "SELECT metadata FROM projects".to_owned(),
            params: json!({}),
            declared: vec![Some("TEXT")],
        },
    );
    let budget = ResultBudget {
        raw_bytes: u64::MAX,
        values: 1_024,
        result_bytes: u64::MAX,
    };
    let result = |numbers: usize| {
        let document = serde_json::to_string(&(0..numbers).collect::<Vec<_>>()).unwrap_or_default();
        json!({"columns": ["metadata"], "rows": [[document]], "affectedRows": 0}).to_string()
    };
    // 1 descriptor + 1 cell + the array and its numbers: 2 + 1 + numbers.
    let served = runtime
        .validate_result_within(handle, 0, &result(1_021), budget)
        .unwrap_or_else(|_| unreachable!());
    assert_eq!(served.values, 1_024);
    assert!(
        runtime
            .validate_result_within(handle, 0, &result(1_022), budget)
            .is_err()
    );
}

/// The raw text is checked against what remains before a byte is parsed.
#[test]
fn the_raw_text_is_bounded_by_the_remaining_raw_budget() {
    let runtime = runtime(MAX_RESULT_BYTES, 1_024);
    let shapes = shapes();
    let (handle, columns, check) = compile(&runtime, &shapes[0]);
    let (raw, _) = generate(&columns, check, 3, 1, 5, false);
    let length = u64::try_from(raw.len()).unwrap_or(u64::MAX);
    let budget = |raw_bytes: u64| ResultBudget {
        raw_bytes,
        values: 1_024,
        result_bytes: u64::MAX,
    };
    let served = runtime
        .validate_result_within(handle, 0, &raw, budget(length))
        .unwrap_or_else(|_| unreachable!());
    assert_eq!(served.raw_bytes, length);
    assert!(
        runtime
            .validate_result_within(handle, 0, &raw, budget(length - 1))
            .is_err()
    );
    // Unparseable text over the budget is still the limit, not a result error: nothing is parsed.
    let junk = "x".repeat(usize::try_from(length).unwrap_or(0) + 1);
    let output = runtime.validate_result_within(handle, 0, &junk, budget(length));
    assert!(matches!(
        output,
        Err(super::RuntimeError::Rejected(
            super::RejectionKind::LimitExceeded
        ))
    ));
}

/// The result bytes left stop a statement at the first row over them.
#[test]
fn the_remaining_result_bytes_stop_validation_at_the_first_row_over_them() {
    let runtime = runtime(MAX_RESULT_BYTES, 1_024);
    let shapes = shapes();
    let (handle, columns, check) = compile(&runtime, &shapes[0]);
    let (raw, _) = generate(&columns, check, 4, 1, 10, false);
    // The validator counts the value bytes of every string cell (the machine counts the exact
    // public encoding afterwards).
    let parsed: Value = serde_json::from_str(&raw).unwrap_or_default();
    let total: u64 = parsed["rows"].as_array().map_or(0, |rows| {
        rows.iter()
            .flat_map(|row| row.as_array().cloned().unwrap_or_default())
            .map(|value| value.as_str().map_or(0, |text| text.len() as u64))
            .sum()
    });
    let used = |result_bytes: u64| {
        runtime.validate_result_within(
            handle,
            0,
            &raw,
            ResultBudget {
                raw_bytes: u64::MAX,
                values: 1_024,
                result_bytes,
            },
        )
    };
    assert!(used(total).is_ok(), "{total}");
    assert!(used(total - 1).is_err());
    assert!(used(0).is_err());
}

/// The raw bound is the documented sum, computed from the compiled statement.
#[test]
fn the_raw_bound_of_a_statement_is_the_documented_sum() {
    let runtime = runtime(MAX_RESULT_BYTES, MAX_JSON_VALUES);
    let shapes = shapes();
    for shape in &shapes {
        let (handle, columns, _) = compile(&runtime, shape);
        let metadata = {
            let plans = runtime.plans.borrow();
            plans[&handle].statements[0].plan.column_metadata_bytes()
        };
        let emitted = u64::try_from(columns.len()).unwrap_or(0);
        let cells = (1_000 * emitted).min(MAX_JSON_VALUES - emitted);
        let expected = 2 * MAX_RESULT_BYTES + 64 * cells + 512 + metadata + 1_024;
        assert_eq!(
            runtime.raw_result_bound(handle).unwrap_or(0),
            expected,
            "{}",
            shape.sql
        );
        // The metadata is the exact sum over the emitted columns.
        let sum: u64 = columns
            .iter()
            .map(|column| {
                2 * column.name.len() as u64 + 2 * column.declared.map_or(0, str::len) as u64 + 32
            })
            .sum();
        assert_eq!(metadata, sum, "{}", shape.sql);
        runtime.release_execution(handle);
    }
    // The column-metadata guard of the compile pass is the constant the raw bound derives from.
    assert_eq!(
        policysql_gateway::MAX_COLUMN_METADATA_BYTES,
        policysql_transaction::bounds::COLUMN_METADATA_BYTES as u64
    );
}

/// At the limits themselves: for every shape, the largest result the configured limits admit
/// (rows at the value limit, then cell text grown until the public encoding is exactly at
/// `maxResultBytes`) fits the compiled raw bound, and one byte more is refused by the result limit.
#[test]
fn the_largest_result_the_limits_admit_fits_the_compiled_raw_bound() {
    let runtime = runtime(MAX_RESULT_BYTES, MAX_JSON_VALUES);
    for (index, shape) in shapes().iter().enumerate() {
        for hide in [false, true] {
            let (handle, columns, check) = compile(&runtime, shape);
            let bound = usize::try_from(runtime.raw_result_bound(handle).unwrap_or(0)).unwrap_or(0);
            // Few rows with long text, many rows with short text, and the value limit exactly.
            let per_row = columns.len().max(1);
            let most = (usize::try_from(MAX_JSON_VALUES).unwrap_or(0) - columns.len()) / per_row;
            let insert = shape.sql.starts_with("INSERT");
            let counts: Vec<usize> = if insert {
                vec![1]
            } else {
                vec![1, 3, most.clamp(1, 8), if check { 8 } else { most }]
            };
            for rows in counts {
                // Grow the text until the public encoding no longer fits.
                let mut length = 0_usize;
                let mut largest = None;
                for step in [4_096_usize, 512, 64, 8, 1] {
                    loop {
                        let (raw, hrana_len) =
                            generate(&columns, check, rows, 11, length + step, hide);
                        let fits = runtime
                            .validate_result_within(handle, 0, &raw, unbounded_raw(MAX_JSON_VALUES))
                            .ok()
                            .filter(|validated| public_bytes(validated) <= MAX_RESULT_BYTES);
                        if fits.is_none() {
                            break;
                        }
                        length += step;
                        largest = Some((raw.len(), hrana_len));
                        if length > 1_000_000 {
                            break;
                        }
                    }
                }
                let Some((private, hrana)) = largest else {
                    continue;
                };
                // A shape whose result holds no text (an INSERT without RETURNING) cannot grow.
                if length > 1_000_000 {
                    assert!(hrana <= bound);
                    continue;
                }
                assert!(
                    hrana <= bound,
                    "shape {index} rows {rows} hide {hide}: hrana {hrana} > bound {bound}"
                );
                assert!(private <= hrana);
                // One more byte of text is over the result limit (or the shape cannot grow).
                let (raw, _) = generate(&columns, check, rows, 11, length + 1, hide);
                let over = runtime
                    .validate_result_within(handle, 0, &raw, unbounded_raw(MAX_JSON_VALUES))
                    .map(|validated| public_bytes(&validated));
                assert!(
                    over.as_ref()
                        .map_or(true, |bytes| *bytes > MAX_RESULT_BYTES),
                    "shape {index}: {over:?}"
                );
            }
            runtime.release_execution(handle);
        }
    }
}

/// Many statements with many projections: the descriptors of `maxStatements` statements of
/// `maxProjections` columns (with conditional columns and their companions) fit the envelope's
/// raw bound with no rows at all, and the bound sums the statements' metadata exactly.
#[test]
fn the_column_descriptors_of_every_statement_fit_the_envelope_bound() {
    let runtime = runtime(MAX_RESULT_BYTES, MAX_JSON_VALUES);
    let projections = |statement: usize| {
        let columns: Vec<String> = (0..128)
            .map(|column| match column % 3 {
                0 => format!("id AS s{statement}c{column}"),
                1 => format!(
                    "private_state AS \"{}{column}\"",
                    "q".repeat(column % 40 + 1)
                ),
                _ => format!("metadata AS m{column}"),
            })
            .collect();
        format!("SELECT {} FROM projects", columns.join(", "))
    };
    let statements: Vec<Value> = (0..8)
        .map(|statement| json!({"sql": projections(statement), "params": {}}))
        .collect();
    let output: Value = serde_json::from_str(&runtime.compile_json(
        AUTH,
        &json!({"statements": statements}).to_string(),
        "execute",
    ))
    .unwrap_or_else(|_| unreachable!());
    let handle = output["executionHandle"]
        .as_u64()
        .unwrap_or_else(|| unreachable!("{output}"));
    let bound = usize::try_from(runtime.raw_result_bound(handle).unwrap_or(0)).unwrap_or(0);
    let plans = runtime.plans.borrow();
    let mut results = Vec::new();
    let mut emitted = 0_usize;
    let mut metadata = 0_u64;
    for statement in &plans[&handle].statements {
        let plan = &statement.plan;
        metadata += plan.column_metadata_bytes();
        let mut cols = Vec::new();
        for descriptor in plan.result() {
            let declared = match descriptor.possible_types.first() {
                Some(policysql_core::LogicalType::Bytes) => "BLOB",
                _ => "TEXT",
            };
            cols.push(json!({"name": descriptor.name.as_str(), "decltype": declared}));
            if let Some(companion) = &descriptor.visibility_column {
                cols.push(json!({"name": companion.as_str(), "decltype": null}));
            }
        }
        emitted += cols.len();
        results.push(json!({"type": "ok", "response": {"type": "execute", "result": {
            "cols": cols, "rows": [], "affected_row_count": 9_007_199_254_740_991_u64,
            "last_insert_rowid": "-9223372036854775808", "replication_index": "9223372036854775807",
            "rows_read": 9_007_199_254_740_991_u64, "rows_written": 9_007_199_254_740_991_u64,
            "query_duration_ms": f64::MAX,
        }}}));
    }
    // 8 statements of 128 projections, a third of them conditional: 8 x (128 + 43) descriptors.
    assert_eq!(emitted, 8 * (128 + 43));
    let hrana = json!({"baton": "b".repeat(512), "base_url": null, "results": results}).to_string();
    assert!(hrana.len() <= bound, "{} > {bound}", hrana.len());
    assert!(metadata <= 1_048_576);
    // No row is needed to fill the bound's column term: it is the exact metadata sum.
    assert!(u64::try_from(bound).unwrap_or(0) >= metadata + 2 * MAX_RESULT_BYTES + 8 * 512 + 1_024);
}
