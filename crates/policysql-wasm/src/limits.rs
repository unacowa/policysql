//! Runtime limits: the one place a deployment configures `PolicySQL`'s limits (ADR 0024,
//! "One place for limits").
//!
//! The wrapper passes `limits_json` to the runtime constructor. This module validates it,
//! fills the documented defaults, and reports the effective values through
//! `PolicySqlRuntime::limits_json`, which the engine reads both to enforce the limits it
//! still enforces in TypeScript and to advertise them in Capabilities. Nothing else holds a
//! copy, so an advertised value is always the enforced one.
//!
//! The four original fields stay required; every other configurable field is optional with
//! a default. ADR 0027 pull request 3 added `max_request_bytes`, `max_json_values`, and
//! `max_sql_bytes` (with a minimum, because a request limit below 64 KiB cannot carry the
//! envelope) and made `limits_json` report every limit the ADR adds. Pull request 6 gave
//! `max_statements`, `max_rows`, and `max_result_bytes` their hard maxima, made
//! `max_response_bytes` a constructor field (its range depends on `max_result_bytes`, so it is
//! validated after the table), and made `max_json_values` bound the result side too. Pull request 4 made the four input-side parser
//! limits (`max_parameters`, `max_expression_depth`, `max_projections`, `max_joins`)
//! constructor fields: they bound only `PolicySQL`'s own work on the client's SQL and promise
//! nothing about the emitted statement. Pull request 5 made `max_bytes_per_value` (decoded
//! bytes of one bytes value) a constructor field; every path it bounds takes it from here.

use serde::Serialize;
use serde_json::{Map, Value};

/// The default and the hard maximum of `max_bytes_per_value`, in decoded bytes; core owns both.
const DEFAULT_MAX_BYTES_PER_VALUE: u64 = policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE as u64;
const HARD_MAX_BYTES_PER_VALUE: u64 = policysql_core::bytes::HARD_MAX_BYTES_PER_VALUE as u64;

/// The largest value JavaScript reads exactly; every limit crosses into the engine as a
/// JSON number.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Durable owner records hold the last statement response, which the transaction result-byte
/// limit bounds. A Durable Object value holds at most 128 KiB; ADR 0024 bounds durable state
/// to 96 KiB, so the response may use at most 64 KiB of it.
const MAX_TRANSACTION_RESULT_BYTES: u64 = 65_536;

/// One configurable field: its constructor name, default (`None` when required), and range.
struct Field {
    name: &'static str,
    default: Option<u64>,
    min: u64,
    max: u64,
}

/// The largest `max_sql_bytes`, before the cross-check with `max_request_bytes`.
const MAX_SQL_BYTES_CEILING: u64 = 1_048_576;

/// Hard maxima of the result-side limits (ADR 0027): they keep the raw result, the validated
/// result, and the response inside the memory model's bounds.
const HARD_MAX_ROWS: u64 = 100_000;
const HARD_MAX_RESULT_BYTES: u64 = 524_288;
const HARD_MAX_STATEMENTS: u64 = 64;
/// The hard maximum of `max_response_bytes`; the idempotency lookup bound derives from it.
const HARD_MAX_RESPONSE_BYTES: u64 = 589_824;
/// The smallest room `max_response_bytes` leaves above `max_result_bytes`: the envelope of a
/// one-statement response and the reserve for the fields added after commit.
const MIN_RESPONSE_HEADROOM_BYTES: u64 = 3_072;

const FIELDS: [Field; 18] = [
    Field {
        name: "max_rows",
        default: None,
        min: 1,
        max: HARD_MAX_ROWS,
    },
    Field {
        name: "max_result_bytes",
        default: None,
        min: 1,
        max: HARD_MAX_RESULT_BYTES,
    },
    Field {
        name: "timeout_ms",
        default: None,
        min: 1,
        max: MAX_SAFE_INTEGER,
    },
    Field {
        name: "max_statements",
        default: None,
        min: 1,
        max: HARD_MAX_STATEMENTS,
    },
    // Interactive transaction duration from begin; also the atomic owner execution deadline.
    Field {
        name: "transaction_ms",
        default: Some(4_000),
        min: 1,
        max: 60_000,
    },
    // Statements per interactive transaction; also the callback query sequence cap per check.
    Field {
        name: "max_transaction_statements",
        default: Some(8),
        min: 1,
        max: 256,
    },
    // Cumulative result bytes per interactive transaction and per commit check's callbacks.
    Field {
        name: "max_transaction_result_bytes",
        default: Some(64_000),
        min: 1,
        max: MAX_TRANSACTION_RESULT_BYTES,
    },
    // Cumulative callback query rows per commit check.
    Field {
        name: "max_callback_rows",
        default: Some(100),
        min: 1,
        max: 10_000,
    },
    // Timeout of BEGIN for an interactive transaction.
    Field {
        name: "begin_timeout_ms",
        default: Some(1_000),
        min: 1,
        max: 60_000,
    },
    // Connection and BEGIN timeout of the after-response cost observation.
    Field {
        name: "cost_timeout_ms",
        default: Some(1_000),
        min: 1,
        max: 10_000,
    },
    // UTF-8 bytes of a request body as received (BOM included). At least the envelope a
    // minimal request needs; at most what keeps the WASM peak under half the isolate.
    Field {
        name: "max_request_bytes",
        default: Some(1_048_576),
        min: 65_536,
        max: 2_097_152,
    },
    // JSON values plus object member names in one request body.
    Field {
        name: "max_json_values",
        default: Some(65_536),
        min: 1_024,
        max: 131_072,
    },
    // UTF-8 bytes of one statement's SQL; also at most `max_request_bytes`.
    Field {
        name: "max_sql_bytes",
        default: Some(65_536),
        min: 1_024,
        max: MAX_SQL_BYTES_CEILING,
    },
    // Decoded bytes of one bytes value: a client parameter, a policy preset, a result cell.
    // The hard maximum keeps its base64 form (1,398,104 bytes) inside the largest request. On
    // every path the smallest applicable limit governs (ADR 0027).
    Field {
        name: "max_bytes_per_value",
        default: Some(DEFAULT_MAX_BYTES_PER_VALUE),
        min: 1,
        max: HARD_MAX_BYTES_PER_VALUE,
    },
    // Distinct client parameter names in one statement (input-side).
    Field {
        name: "max_parameters",
        default: Some(1_024),
        min: 1,
        max: 16_384,
    },
    // Binder expression depth of the client's SQL (input-side).
    Field {
        name: "max_expression_depth",
        default: Some(32),
        min: 1,
        max: 64,
    },
    // Result columns per SELECT/RETURNING in the client's SQL (input-side).
    Field {
        name: "max_projections",
        default: Some(128),
        min: 1,
        max: 2_000,
    },
    // Joins per FROM in the client's SQL (input-side; SQLite allows 64 tables in a join).
    Field {
        name: "max_joins",
        default: Some(8),
        min: 1,
        max: 63,
    },
];

/// The effective limits of one runtime, as the engine reads them.
///
/// The configurable fields come from `limits_json`; the rest are fixed protocol constants
/// that core enforces and the engine only reports.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeLimits {
    pub(crate) max_rows: u64,
    pub(crate) max_result_bytes: u64,
    pub(crate) timeout_ms: u64,
    pub(crate) max_statements: u64,
    pub(crate) transaction_ms: u64,
    pub(crate) max_transaction_statements: u64,
    pub(crate) max_transaction_result_bytes: u64,
    pub(crate) max_callback_rows: u64,
    pub(crate) begin_timeout_ms: u64,
    pub(crate) cost_timeout_ms: u64,
    pub(crate) max_request_bytes: u64,
    pub(crate) max_json_values: u64,
    pub(crate) max_sql_bytes: u64,
    pub(crate) max_parameters: u64,
    pub(crate) max_expression_depth: u64,
    pub(crate) max_projections: u64,
    pub(crate) max_joins: u64,
    /// Decoded bytes of one bytes value (ADR 0027 pull request 5).
    pub(crate) max_bytes_per_value: u64,
    /// UTF-8 bytes of a complete success response (ADR 0027 pull request 6).
    pub(crate) max_response_bytes: u64,
    // Fixed protocol constants, enforced by core, never configured.
    pub(crate) max_commit_checks: u64,
    pub(crate) max_hook_duration_ms: u64,
}

/// Fixed limits reported next to the configured ones.
#[allow(clippy::struct_field_names)]
pub(crate) struct FixedLimits {
    pub(crate) max_commit_checks: usize,
    pub(crate) max_hook_duration_ms: u64,
}

/// The default of `max_response_bytes` beyond `max_result_bytes`.
const RESPONSE_HEADROOM_BYTES: u64 = 65_536;
const RESPONSE_FIELD: &str = "max_response_bytes";

/// Parses and validates the constructor's limits. Every failure names the field.
pub(crate) fn parse(limits_json: &str, fixed: &FixedLimits) -> Result<RuntimeLimits, String> {
    let object: Map<String, Value> = serde_json::from_str(limits_json)
        .map_err(|_| "runtime limits are invalid: expected a JSON object".to_owned())?;
    if let Some(unknown) = object.keys().find(|key| {
        key.as_str() != RESPONSE_FIELD && !FIELDS.iter().any(|field| field.name == key.as_str())
    }) {
        return Err(format!(
            "runtime limits are invalid: unknown field `{}`",
            printable(unknown)
        ));
    }
    let mut values = [0_u64; FIELDS.len()];
    for (slot, field) in values.iter_mut().zip(FIELDS.iter()) {
        *slot = match (object.get(field.name), field.default) {
            (None, Some(default)) => default,
            (None, None) => {
                return Err(format!(
                    "runtime limits are invalid: `{}` is required",
                    field.name
                ));
            }
            (Some(value), _) => match value.as_u64() {
                Some(value) if (field.min..=field.max).contains(&value) => value,
                _ => {
                    return Err(format!(
                        "runtime limits are invalid: `{}` must be an integer from {} to {}",
                        field.name, field.min, field.max
                    ));
                }
            },
        };
    }
    let [
        max_rows,
        max_result_bytes,
        timeout_ms,
        max_statements,
        transaction_ms,
        max_transaction_statements,
        max_transaction_result_bytes,
        max_callback_rows,
        begin_timeout_ms,
        cost_timeout_ms,
        max_request_bytes,
        max_json_values,
        max_sql_bytes,
        max_bytes_per_value,
        max_parameters,
        max_expression_depth,
        max_projections,
        max_joins,
    ] = values;
    // A statement cannot be longer than the body that carries it.
    if max_sql_bytes > max_request_bytes {
        return Err(
            "runtime limits are invalid: `max_sql_bytes` must not exceed `max_request_bytes`"
                .to_owned(),
        );
    }
    let response_min = max_result_bytes + MIN_RESPONSE_HEADROOM_BYTES;
    let max_response_bytes = match object.get(RESPONSE_FIELD) {
        None => (max_result_bytes + RESPONSE_HEADROOM_BYTES).min(HARD_MAX_RESPONSE_BYTES),
        Some(value) => match value.as_u64() {
            Some(value) if (response_min..=HARD_MAX_RESPONSE_BYTES).contains(&value) => value,
            _ => {
                return Err(format!(
                    "runtime limits are invalid: `{RESPONSE_FIELD}` must be an integer from \
                     `max_result_bytes` + {MIN_RESPONSE_HEADROOM_BYTES} ({response_min}) to \
                     {HARD_MAX_RESPONSE_BYTES}"
                ));
            }
        },
    };
    Ok(RuntimeLimits {
        max_rows,
        max_result_bytes,
        timeout_ms,
        max_statements,
        transaction_ms,
        max_transaction_statements,
        max_transaction_result_bytes,
        max_callback_rows,
        begin_timeout_ms,
        cost_timeout_ms,
        max_request_bytes,
        max_json_values,
        max_sql_bytes,
        max_parameters,
        max_expression_depth,
        max_projections,
        max_joins,
        max_bytes_per_value,
        max_response_bytes,
        max_commit_checks: as_u64(fixed.max_commit_checks),
        max_hook_duration_ms: fixed.max_hook_duration_ms,
    })
}

fn as_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

/// An unknown key is wrapper configuration, not client input, but the message still stays
/// one short line of plain characters.
fn printable(key: &str) -> String {
    key.chars()
        .take(64)
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '?'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{FIELDS, FixedLimits, parse};

    const FIXED: FixedLimits = FixedLimits {
        max_commit_checks: 4,
        max_hook_duration_ms: 1_500,
    };
    const REQUIRED: &str =
        r#""max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8"#;

    fn with(extra: &str) -> Result<super::RuntimeLimits, String> {
        let separator = if extra.is_empty() { "" } else { "," };
        parse(&format!("{{{REQUIRED}{separator}{extra}}}"), &FIXED)
    }

    #[test]
    fn omitted_fields_take_the_constants_they_replace() {
        let limits = with("").unwrap_or_else(|error| unreachable!("{error}"));
        assert_eq!(limits.transaction_ms, 4_000);
        assert_eq!(limits.max_transaction_statements, 8);
        assert_eq!(limits.max_transaction_result_bytes, 64_000);
        assert_eq!(limits.max_callback_rows, 100);
        assert_eq!(limits.begin_timeout_ms, 1_000);
        assert_eq!(limits.cost_timeout_ms, 1_000);
        assert_eq!(limits.max_request_bytes, 1_048_576);
        assert_eq!(limits.max_json_values, 65_536);
        assert_eq!(limits.max_sql_bytes, 65_536);
        assert_eq!(limits.max_bytes_per_value, 262_144);
        assert_eq!(limits.max_parameters, 1_024);
        assert_eq!(limits.max_expression_depth, 32);
        assert_eq!(limits.max_projections, 128);
        assert_eq!(limits.max_joins, 8);
        assert_eq!(limits.max_response_bytes, 64_000 + 65_536);
        assert_eq!(limits.max_hook_duration_ms, 1_500);
    }

    #[test]
    fn configured_fields_are_reported_exactly() {
        let limits = with(
            r#""transaction_ms":2500,"max_transaction_statements":3,"max_transaction_result_bytes":4096,"max_callback_rows":7,"begin_timeout_ms":600,"cost_timeout_ms":700"#,
        )
        .unwrap_or_else(|error| unreachable!("{error}"));
        let json = serde_json::to_value(limits).unwrap_or_else(|error| unreachable!("{error}"));
        assert_eq!(json["transactionMs"], 2_500);
        assert_eq!(json["maxTransactionStatements"], 3);
        assert_eq!(json["maxTransactionResultBytes"], 4_096);
        assert_eq!(json["maxCallbackRows"], 7);
        assert_eq!(json["beginTimeoutMs"], 600);
        assert_eq!(json["costTimeoutMs"], 700);
        assert_eq!(json["maxRows"], 100);
        let limits = with(
            r#""max_parameters":16384,"max_expression_depth":64,"max_projections":2000,"max_joins":63,"max_bytes_per_value":1048576"#,
        )
        .unwrap_or_else(|error| unreachable!("{error}"));
        let json = serde_json::to_value(limits).unwrap_or_else(|error| unreachable!("{error}"));
        assert_eq!(json["maxBytesPerValue"], 1_048_576);
        assert_eq!(json["maxParameters"], 16_384);
        assert_eq!(json["maxExpressionDepth"], 64);
        assert_eq!(json["maxProjections"], 2_000);
        assert_eq!(json["maxJoins"], 63);
        assert_eq!(json.as_object().map(serde_json::Map::len), Some(21));
    }

    #[test]
    fn every_invalid_value_is_rejected_and_names_its_field() {
        let text_with = |name: &str, raw: &str| {
            let mut object = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(
                &format!("{{{REQUIRED}}}"),
            )
            .unwrap_or_else(|error| unreachable!("{error}"));
            object.insert(
                name.to_owned(),
                serde_json::from_str(raw).unwrap_or_else(|error| unreachable!("{error}")),
            );
            serde_json::to_string(&object).unwrap_or_else(|error| unreachable!("{error}"))
        };
        for field in &FIELDS {
            let too_large = (field.max + 1).to_string();
            let too_small = (field.min - 1).to_string();
            for bad in [
                too_small.as_str(),
                "-1",
                "1.5",
                "\"8\"",
                "null",
                "true",
                too_large.as_str(),
            ] {
                let error = parse(&text_with(field.name, bad), &FIXED)
                    .err()
                    .unwrap_or_else(|| unreachable!("{} = {bad}", field.name));
                assert!(error.contains(&format!("`{}`", field.name)), "{error}");
            }
            for good in [field.min.to_string(), field.max.to_string()] {
                let accepted = parse(&text_with(field.name, &good), &FIXED);
                assert!(accepted.is_ok(), "{} = {good}: {accepted:?}", field.name);
            }
        }
    }

    #[test]
    fn the_result_side_limits_have_hard_maxima_and_the_response_limit_follows_the_result_limit() {
        // Hard maxima (ADR 0027), at the cap and one over.
        let required_with = |name: &str, value: u64| {
            let mut object: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&format!("{{{REQUIRED}}}"))
                    .unwrap_or_else(|error| unreachable!("{error}"));
            object.insert(name.to_owned(), value.into());
            serde_json::to_string(&object).unwrap_or_else(|error| unreachable!("{error}"))
        };
        for (name, max) in [
            ("max_rows", 100_000_u64),
            ("max_result_bytes", 524_288),
            ("max_statements", 64),
        ] {
            assert!(
                parse(&required_with(name, max), &FIXED).is_ok(),
                "{name} = {max}"
            );
            let error = parse(&required_with(name, max + 1), &FIXED)
                .err()
                .unwrap_or_default();
            assert!(error.contains(&format!("`{name}`")), "{error}");
        }
        // `max_response_bytes` is at least `max_result_bytes` + 3,072 and at most 589,824; the
        // default is `max_result_bytes` + 65,536, capped at the maximum.
        let response = |value: &str| with(&format!(r#""max_response_bytes":{value}"#));
        assert_eq!(response("67072").map(|l| l.max_response_bytes), Ok(67_072));
        assert_eq!(
            response("589824").map(|l| l.max_response_bytes),
            Ok(589_824)
        );
        for bad in ["67071", "589825", "0", "-1", "1.5", "\"70000\"", "null"] {
            let error = response(bad).err().unwrap_or_default();
            assert!(error.contains("`max_response_bytes`"), "{bad}: {error}");
            assert!(error.contains("67072"), "names the minimum: {error}");
        }
        let large = |extra: &str| {
            parse(
                &format!(
                    r#"{{"max_rows":100,"max_result_bytes":524288,"timeout_ms":1000,"max_statements":8{extra}}}"#
                ),
                &FIXED,
            )
        };
        assert_eq!(large("").map(|l| l.max_response_bytes), Ok(589_824));
        assert_eq!(
            large(r#","max_response_bytes":527360"#).map(|l| l.max_response_bytes),
            Ok(527_360)
        );
        assert!(large(r#","max_response_bytes":527359"#).is_err());
        assert_eq!(
            with(r#""max_response_bytes":589824"#).map(|l| l.max_result_bytes),
            Ok(64_000)
        );
    }

    #[test]
    fn missing_required_and_unknown_fields_are_rejected() {
        let error = parse(
            r#"{"max_rows":1,"max_result_bytes":1,"timeout_ms":1}"#,
            &FIXED,
        )
        .err()
        .unwrap_or_default();
        assert!(error.contains("`max_statements` is required"), "{error}");
        let error = with(r#""transactionMs":4000"#).err().unwrap_or_default();
        assert!(error.contains("unknown field `transactionMs`"), "{error}");
        let error = with(r#""bad key\n":1"#).err().unwrap_or_default();
        assert!(error.contains("unknown field `bad?key?`"), "{error}");
        for text in ["", "[]", "null", "{", "1"] {
            assert!(parse(text, &FIXED).is_err(), "{text}");
        }
    }
}
