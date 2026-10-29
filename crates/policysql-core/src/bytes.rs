//! Hosting-independent bytes wire codec. Public JSON uses canonical RFC 4648 base64.

use base64::{Engine as _, engine::general_purpose::STANDARD};

/// Per-value decoded limit, also applied to policy presets and physical results.
/// Request, result and transaction limits apply independently and may be stricter.
pub const MAX_BYTES_PER_VALUE: usize = 262_144;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeError {
    InvalidEncoding,
    TooLarge,
}

/// Decodes standard padded base64, rejecting whitespace, URL-safe alphabet and
/// nonzero unused bits. Malformed input is `InvalidEncoding` regardless of its
/// length; only well-formed input whose decoded length exceeds the limit is
/// `TooLarge`. Both checks complete before the decoded payload is allocated.
///
/// # Errors
/// Returns a safe category for malformed encoding or a decoded value over the limit.
pub fn decode(value: &str) -> Result<Vec<u8>, DecodeError> {
    if value.len() % 4 != 0 {
        return Err(DecodeError::InvalidEncoding);
    }
    let bytes = value.as_bytes();
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2
        || bytes[..bytes.len() - padding]
            .iter()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'+' | b'/'))
    {
        return Err(DecodeError::InvalidEncoding);
    }
    // Validate padding and unused bits without allocating the decoded payload.
    if bytes.len() >= 4 {
        STANDARD
            .decode_slice(&bytes[bytes.len() - 4..], &mut [0; 3])
            .map_err(|_| DecodeError::InvalidEncoding)?;
    }
    let length = (value.len() / 4 * 3).saturating_sub(padding);
    if length > MAX_BYTES_PER_VALUE {
        return Err(DecodeError::TooLarge);
    }
    STANDARD
        .decode(value)
        .map_err(|_| DecodeError::InvalidEncoding)
}

#[must_use]
pub fn encode(value: &[u8]) -> String {
    STANDARD.encode(value)
}

#[cfg(test)]
mod tests {
    use super::{DecodeError, MAX_BYTES_PER_VALUE, decode, encode};

    #[test]
    fn exact_decoded_limit_and_canonical_encoding() {
        for length in [0, 1, 2, 3, MAX_BYTES_PER_VALUE - 1, MAX_BYTES_PER_VALUE] {
            let value = vec![255; length];
            assert_eq!(decode(&encode(&value)), Ok(value));
        }
        assert_eq!(
            decode(&encode(&vec![0; MAX_BYTES_PER_VALUE + 1])),
            Err(DecodeError::TooLarge)
        );
        for malformed in ["AB==", "AAB=", "AA", "AA==\n", "_w==", "===="] {
            assert_eq!(decode(malformed), Err(DecodeError::InvalidEncoding));
        }
    }

    // Regression (PR #19 review): long malformed input must not be classified
    // by its length as TooLarge, and the category must not depend on UTF-8 width.
    #[test]
    fn long_malformed_input_is_invalid_encoding_not_too_large() {
        let encoded_limit = MAX_BYTES_PER_VALUE.div_ceil(3) * 4;
        for malformed in [
            "!".repeat(encoded_limit + 4),
            "\u{e9}".repeat(encoded_limit / 2 + 2),
            "A".repeat(encoded_limit + 5),
            "AAAA".repeat(encoded_limit / 4 + 1) + "AB==",
            "AA==".repeat(encoded_limit / 4 + 1),
            "AAAA".repeat(encoded_limit / 4 + 1) + "A===",
        ] {
            assert_eq!(decode(&malformed), Err(DecodeError::InvalidEncoding));
        }
        assert_eq!(
            decode(&"AAAA".repeat(encoded_limit / 4 + 1)),
            Err(DecodeError::TooLarge)
        );
    }
}
