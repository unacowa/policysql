//! Runtime limits: the one place a deployment configures `PolicySQL`'s limits (ADR 0024,
//! "One place for limits").
//!
//! The wrapper passes `limits_json` to the runtime constructor. This module validates it,
//! fills the documented defaults, and reports the effective values through
//! `PolicySqlRuntime::limits_json`, which the engine reads both to enforce the limits it
//! still enforces in TypeScript and to advertise them in Capabilities. Nothing else holds a
//! copy, so an advertised value is always the enforced one.
//!
//! The constructor shape is additive: the four original fields keep their meaning and stay
//! required, and every field added by ADR 0024 pull request 3 is optional with a default
//! equal to the constant it replaces. An existing `limits_json` is therefore accepted and
//! enforced exactly as before, which is why adding them does not change `ABI_VERSION`.

use serde::Serialize;
use serde_json::{Map, Value};

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
    max: u64,
}

const FIELDS: [Field; 10] = [
    Field {
        name: "max_rows",
        default: None,
        max: MAX_SAFE_INTEGER,
    },
    Field {
        name: "max_result_bytes",
        default: None,
        max: MAX_SAFE_INTEGER,
    },
    Field {
        name: "timeout_ms",
        default: None,
        max: MAX_SAFE_INTEGER,
    },
    Field {
        name: "max_statements",
        default: None,
        // The gateway holds it as `usize`, which is 32 bits on wasm32.
        max: 4_294_967_295,
    },
    // Interactive transaction duration from begin; also the atomic owner execution deadline.
    Field {
        name: "transaction_ms",
        default: Some(4_000),
        max: 60_000,
    },
    // Statements per interactive transaction; also the callback query sequence cap per check.
    Field {
        name: "max_transaction_statements",
        default: Some(8),
        max: 256,
    },
    // Cumulative result bytes per interactive transaction and per commit check's callbacks.
    Field {
        name: "max_transaction_result_bytes",
        default: Some(64_000),
        max: MAX_TRANSACTION_RESULT_BYTES,
    },
    // Cumulative callback query rows per commit check.
    Field {
        name: "max_callback_rows",
        default: Some(100),
        max: 10_000,
    },
    // Timeout of BEGIN for an interactive transaction.
    Field {
        name: "begin_timeout_ms",
        default: Some(1_000),
        max: 60_000,
    },
    // Connection and BEGIN timeout of the after-response cost observation.
    Field {
        name: "cost_timeout_ms",
        default: Some(1_000),
        max: 10_000,
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
    // Fixed protocol constants, enforced by core, never configured.
    pub(crate) max_request_bytes: u64,
    pub(crate) max_sql_bytes: u64,
    pub(crate) max_joins: u64,
    pub(crate) max_commit_checks: u64,
    pub(crate) max_hook_duration_ms: u64,
}

/// Fixed protocol constants reported next to the configured limits.
#[allow(clippy::struct_field_names)]
pub(crate) struct FixedLimits {
    pub(crate) max_request_bytes: usize,
    pub(crate) max_sql_bytes: usize,
    pub(crate) max_joins: usize,
    pub(crate) max_commit_checks: usize,
    pub(crate) max_hook_duration_ms: u64,
}

/// Parses and validates the constructor's limits. Every failure names the field.
pub(crate) fn parse(limits_json: &str, fixed: &FixedLimits) -> Result<RuntimeLimits, String> {
    let object: Map<String, Value> = serde_json::from_str(limits_json)
        .map_err(|_| "runtime limits are invalid: expected a JSON object".to_owned())?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !FIELDS.iter().any(|field| field.name == key.as_str()))
    {
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
                Some(value) if (1..=field.max).contains(&value) => value,
                _ => {
                    return Err(format!(
                        "runtime limits are invalid: `{}` must be an integer from 1 to {}",
                        field.name, field.max
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
    ] = values;
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
        max_request_bytes: as_u64(fixed.max_request_bytes),
        max_sql_bytes: as_u64(fixed.max_sql_bytes),
        max_joins: as_u64(fixed.max_joins),
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
        max_request_bytes: 1_048_576,
        max_sql_bytes: 65_536,
        max_joins: 8,
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
        assert_eq!(json.as_object().map(serde_json::Map::len), Some(15));
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
            for bad in [
                "0",
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
            for good in ["1".to_owned(), field.max.to_string()] {
                let accepted = parse(&text_with(field.name, &good), &FIXED);
                assert!(accepted.is_ok(), "{} = {good}: {accepted:?}", field.name);
            }
        }
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
