//! Derived internal bounds of the request path (ADR 0027, "Derived internal bounds").
//!
//! A derived bound is a memory guard on an internal hop (WASM input, hash input, step
//! event). It is the sum of the maxima of its components plus explicitly stated framing,
//! computed from the configured `max_request_bytes`, never configured and never advertised.
//! It is never smaller than the largest input the configured limits admit, so it never
//! rejects data that every configured limit accepts. No other byte constant belongs on the
//! request path.

/// `A`: the wrapper-supplied session JSON. Larger is a wrapper fault (`POLICYSQL_INTERNAL`).
pub const SESSION_INPUT_BYTES: usize = 65_536;
/// The verified auth JSON core emits from a session. Its `role` is the one the client selected
/// with `PolicySQL-Role`, which must be one of the session's `roles`, so a long role name
/// appears twice (as `role` and inside `roles`): the auth is at most the session plus one role
/// name, and a role name is part of the session, so at most `2 A`, plus the fields core adds.
/// Role names have no length limit of their own; this is the sound bound without one.
pub const AUTH_BYTES: usize = 2 * SESSION_INPUT_BYTES + 1_024;
/// The database binding: four parts of at most 256 characters, JSON-escaped, plus framing.
pub const BINDING_BYTES: usize = 2_048;
/// An `Idempotency-Key` (16 to 128 characters).
pub const KEY_BYTES: usize = 128;
/// Envelope framing of a compile or hash input (member names, ids, separators).
pub const INPUT_FRAMING_BYTES: usize = 1_024;
/// Framing of a step event beyond its components (ids, kinds, separators).
pub const EVENT_FRAMING_BYTES: usize = 4_096;

/// WASM compile input: the verified auth plus the request body.
#[must_use]
pub const fn compile_input_bytes(max_request_bytes: usize) -> usize {
    AUTH_BYTES
        .saturating_add(max_request_bytes)
        .saturating_add(INPUT_FRAMING_BYTES)
}

/// `identity_json` and `cost_estimate_json` input: the auth, binding, key, and the body
/// embedded as a JSON string (at most doubled by escaping), plus framing.
#[must_use]
pub const fn hash_input_bytes(max_request_bytes: usize) -> usize {
    AUTH_BYTES
        .saturating_add(BINDING_BYTES)
        .saturating_add(KEY_BYTES)
        .saturating_add(max_request_bytes.saturating_mul(2))
        .saturating_add(INPUT_FRAMING_BYTES)
}

/// The largest Hrana framing of one raw cell (`{"type":"integer","value":"-9223372036854775808"},`
/// is 49 bytes with its comma); 64 leaves room for the row brackets.
pub const HRANA_CELL_BYTES: usize = 64;
/// The Hrana framing of one statement's reply (type markers, counters, the empty `cols` and
/// `rows` arrays, the optional ids); the column descriptors are counted separately.
pub const HRANA_STATEMENT_BYTES: usize = 512;
/// The Hrana framing of the whole reply: the next baton (at most 512 characters, JSON-escaped
/// by the server), `base_url`, and the `results` array.
pub const HRANA_ENVELOPE_BYTES: usize = 1_024;
/// The most column metadata (`cols`) one envelope's compiled statements may carry; over it the
/// envelope is `POLICYSQL_SQL_TOO_COMPLEX` (cause `column_metadata`), so the raw bound's column
/// term never exceeds it. Core's compile pass and this bound share the number.
pub const COLUMN_METADATA_BYTES: usize = 1_048_576;
/// The hard maximum of `max_response_bytes` (`RuntimeLimits`).
pub const HARD_MAX_RESPONSE_BYTES: usize = 589_824;
/// The idempotency lookup reply's read cap: a stored `response_json` (at most the hard
/// maximum of `max_response_bytes`, twice for escaping as a TEXT cell inside Hrana) plus framing.
/// Derived from the hard maximum, never from the current configuration, so a replay still
/// returns a response committed under a larger limit.
pub const LOOKUP_BYTES: usize = 2 * HARD_MAX_RESPONSE_BYTES + 4_096;
/// What a response measured before COMMIT leaves for the fields added after it: the request
/// id (at most 128 bytes) and `meta`.
pub const RESPONSE_RESERVE_BYTES: usize = 1_024;
/// The read cap of a statement whose reply carries no result data (the idempotency row's
/// INSERT): a fixed protocol constant like the control replies.
pub const NO_RESULT_BYTES: usize = 65_536;

/// The raw database result bound of one compiled envelope or interactive statement
/// (ADR 0027 "Derived internal bounds"), in bytes of Hrana text:
/// `2P + 64·C + Σᵢ 512 + M + 1,024`, where `P` is `max_result_bytes` (doubled for the JSON
/// escaping of a JSON-typed value inside a text cell), `C` the most cells the statements can
/// return (`min(Σᵢ rowsᵢ × eᵢ, max_json_values − Σᵢ eᵢ)`, `rowsᵢ` the statement's row limit,
/// `eᵢ` its emitted column count), and `M` the exact column metadata of the compiled
/// statements. `statements` holds `(rowsᵢ, eᵢ)`.
#[must_use]
pub fn raw_result_bound(
    max_result_bytes: u64,
    max_json_values: u64,
    statements: &[(u64, u64)],
    column_metadata_bytes: u64,
) -> u64 {
    let columns: u64 = statements.iter().map(|(_, columns)| *columns).sum();
    let cells: u64 = statements
        .iter()
        .map(|(rows, columns)| rows.saturating_mul(*columns))
        .fold(0_u64, u64::saturating_add)
        .min(max_json_values.saturating_sub(columns));
    let statement_count = u64::try_from(statements.len()).unwrap_or(u64::MAX);
    max_result_bytes
        .saturating_mul(2)
        .saturating_add(cells.saturating_mul(HRANA_CELL_BYTES as u64))
        .saturating_add(statement_count.saturating_mul(HRANA_STATEMENT_BYTES as u64))
        .saturating_add(column_metadata_bytes)
        .saturating_add(HRANA_ENVELOPE_BYTES as u64)
}

/// The largest raw result bound any compile can produce under these limits (every value
/// limit at its maximum, every statement at its largest, column metadata at its guard).
#[must_use]
pub const fn raw_result_bound_max(
    max_result_bytes: usize,
    max_json_values: usize,
    max_statements: usize,
) -> usize {
    max_result_bytes
        .saturating_mul(2)
        .saturating_add(max_json_values.saturating_mul(HRANA_CELL_BYTES))
        .saturating_add(max_statements.saturating_mul(HRANA_STATEMENT_BYTES))
        .saturating_add(COLUMN_METADATA_BYTES)
        .saturating_add(HRANA_ENVELOPE_BYTES)
}

/// The largest raw text any result-bearing read may carry: the envelope bound or the
/// idempotency lookup, whichever is larger.
#[must_use]
pub const fn largest_read_bytes(raw_bound_max: usize) -> usize {
    if raw_bound_max > LOOKUP_BYTES {
        raw_bound_max
    } else {
        LOOKUP_BYTES
    }
}

/// A step event: the body text embedded as a JSON string (at most doubled), the auth, the
/// binding, `result_bytes` of raw database results (see [`largest_read_bytes`]), and framing.
#[must_use]
pub const fn event_bytes(max_request_bytes: usize, result_bytes: usize) -> usize {
    max_request_bytes
        .saturating_mul(2)
        .saturating_add(AUTH_BYTES)
        .saturating_add(BINDING_BYTES)
        .saturating_add(result_bytes)
        .saturating_add(EVENT_FRAMING_BYTES)
}

/// The volatile state: the body text (at most doubled by escaping) and either the validated
/// public results (under `max_response_bytes`, doubled for escaping) or a pending replay
/// reply (under the lookup bound), never raw results.
#[must_use]
pub const fn volatile_bytes(max_request_bytes: usize, max_response_bytes: usize) -> usize {
    let response = max_response_bytes.saturating_mul(2);
    let held = if response > LOOKUP_BYTES {
        response
    } else {
        LOOKUP_BYTES
    };
    crate::machine::MAX_VOLATILE_BYTES
        .saturating_add(max_request_bytes.saturating_mul(2))
        .saturating_add(held)
}

#[cfg(test)]
mod tests {
    use super::{
        LOOKUP_BYTES, compile_input_bytes, event_bytes, hash_input_bytes, raw_result_bound,
        raw_result_bound_max, volatile_bytes,
    };

    #[test]
    fn bounds_at_the_documented_defaults() {
        assert_eq!(compile_input_bytes(1_048_576), 1_181_696);
        assert_eq!(hash_input_bytes(1_048_576), 2_232_448);
        assert_eq!(event_bytes(1_048_576, 0), 2_232_448 - 1_024 - 128 + 4_096);
    }

    #[test]
    fn the_lookup_and_volatile_bounds_derive_from_the_hard_maximum() {
        assert_eq!(LOOKUP_BYTES, 1_183_744);
        assert_eq!(
            volatile_bytes(1_048_576, 589_824),
            262_144 + 2_097_152 + 1_183_744
        );
        assert_eq!(
            volatile_bytes(1_048_576, 1),
            262_144 + 2_097_152 + 1_183_744
        );
    }

    #[test]
    fn the_raw_bound_is_the_documented_sum_and_never_exceeds_the_maximum() {
        // One statement, 100 rows of 3 columns, 64,000 result bytes, 300 bytes of metadata.
        let bound = raw_result_bound(64_000, 65_536, &[(100, 3)], 300);
        assert_eq!(bound, 128_000 + 64 * 300 + 512 + 300 + 1_024);
        // Cells are capped by the value limit net of the column descriptors.
        let capped = raw_result_bound(64_000, 1_024, &[(100_000, 4)], 0);
        assert_eq!(capped, 128_000 + 64 * (1_024 - 4) + 512 + 1_024);
        let maximum = raw_result_bound_max(64_000, 65_536, 8);
        assert_eq!(maximum, 128_000 + 64 * 65_536 + 512 * 8 + 1_048_576 + 1_024);
        assert!(
            usize::try_from(capped).unwrap_or(usize::MAX) <= raw_result_bound_max(64_000, 1_024, 1)
        );
        assert!(usize::try_from(bound).unwrap_or(usize::MAX) <= maximum);
    }

    #[test]
    fn bounds_never_shrink_as_the_request_limit_grows() {
        let mut last = (0, 0, 0);
        for limit in [65_536, 1_048_576, 2_097_152] {
            let next = (
                compile_input_bytes(limit),
                hash_input_bytes(limit),
                event_bytes(limit, 1),
            );
            assert!(next.0 > last.0 && next.1 > last.1 && next.2 > last.2);
            last = next;
        }
    }
}
