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
/// nonzero unused bits. The decoded length is bounded before allocation.
///
/// # Errors
/// Returns a safe category for malformed encoding or a decoded value over the limit.
pub fn decode(value: &str) -> Result<Vec<u8>, DecodeError> {
    if value.len() > MAX_BYTES_PER_VALUE.div_ceil(3) * 4 {
        return Err(DecodeError::TooLarge);
    }
    if value.len() % 4 != 0 {
        return Err(DecodeError::InvalidEncoding);
    }
    let padding = value.bytes().rev().take_while(|byte| *byte == b'=').count();
    if padding > 2 {
        return Err(DecodeError::InvalidEncoding);
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
}
