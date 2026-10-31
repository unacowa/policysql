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
/// The verified auth JSON core emits from a session (`A` plus the fields core adds).
pub const AUTH_BYTES: usize = SESSION_INPUT_BYTES + 1_024;
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

/// A step event: the body text embedded as a JSON string (at most doubled), the auth, the
/// binding, `result_bytes` of raw database results, and framing. `result_bytes` is the
/// result-side bound of the envelope (replaced by the compiled raw bound in ADR 0027 pull
/// request 6).
#[must_use]
pub const fn event_bytes(max_request_bytes: usize, result_bytes: usize) -> usize {
    max_request_bytes
        .saturating_mul(2)
        .saturating_add(AUTH_BYTES)
        .saturating_add(BINDING_BYTES)
        .saturating_add(result_bytes)
        .saturating_add(EVENT_FRAMING_BYTES)
}

#[cfg(test)]
mod tests {
    use super::{compile_input_bytes, event_bytes, hash_input_bytes};

    #[test]
    fn bounds_at_the_documented_defaults() {
        assert_eq!(compile_input_bytes(1_048_576), 1_116_160);
        assert_eq!(hash_input_bytes(1_048_576), 2_166_912);
        assert_eq!(event_bytes(1_048_576, 0), 2_166_912 - 1_024 - 128 + 4_096);
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
