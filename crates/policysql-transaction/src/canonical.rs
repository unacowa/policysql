//! Canonical JSON, byte for byte as `stableJson` in `deploy/cloudflare/src/idempotency.ts`
//! prints a value that `JSON.parse` produced (ADR 0024, "Where byte-equal hashing is
//! load-bearing").
//!
//! The text is read with this module's own tokenizer, not through `serde_json` values or a
//! JavaScript string:
//!
//! - strings are decoded to UTF-16 code units, so an escaped lone surrogate (`"\ud800"`)
//!   survives, and they are printed with exactly the escapes `JSON.stringify` uses (a lone
//!   surrogate as a lowercase `\uXXXX`, other control characters below U+0020 as `\u00xx`
//!   unless they have a short escape, everything else literally, `/` and U+2028 included);
//! - object keys are sorted by UTF-16 code units, as `Array.prototype.sort` sorts strings;
//! - numbers are parsed as IEEE doubles (correctly rounded, overflow to infinity) and printed
//!   by the ECMAScript `Number::toString` algorithm; a non-finite double prints `null`, and
//!   `-0` prints `0`, as `JSON.stringify` prints them.
//!
//! The tokenizer accepts strict JSON (RFC 8259, the grammar `JSON.parse` accepts) and fails
//! closed on everything else, on duplicate keys (the engine rejects them before this runs), and
//! on nesting deeper than [`MAX_DEPTH`].

use std::fmt::Write as _;

/// The deepest nesting accepted. The engine rejects bodies nested deeper than 65 levels before
/// any identity is computed, so every body it accepts is within this bound.
pub const MAX_DEPTH: usize = 128;

/// A JSON value as `JSON.parse` would produce it, with strings as UTF-16 code units.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<Json>),
    /// Members with unique keys. [`parse`] returns them sorted by key; the writer sorts every
    /// object, so a value built in code may list them in any order.
    Object(Vec<(Vec<u16>, Json)>),
}

/// The text is not strict JSON, has a duplicate key, or nests too deeply.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParseError;

impl Json {
    /// A string value from Rust text.
    #[must_use]
    pub fn string(text: &str) -> Self {
        Self::String(text.encode_utf16().collect())
    }

    /// The member `key` of an object, if this is an object that has it.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Json> {
        let Self::Object(members) = self else {
            return None;
        };
        let wanted: Vec<u16> = key.encode_utf16().collect();
        members
            .iter()
            .find(|(name, _)| *name == wanted)
            .map(|(_, value)| value)
    }

    /// The value as Rust text, if it is a string of well-formed UTF-16.
    #[must_use]
    pub fn as_text(&self) -> Option<String> {
        match self {
            Self::String(units) => String::from_utf16(units).ok(),
            _ => None,
        }
    }
}

/// Parses strict JSON text.
///
/// # Errors
///
/// Returns [`ParseError`] for anything `JSON.parse` would reject, a duplicate key, or nesting
/// deeper than [`MAX_DEPTH`].
pub fn parse(text: &str) -> Result<Json, ParseError> {
    let mut parser = Parser { text, offset: 0 };
    parser.whitespace();
    let value = parser.value(0)?;
    parser.whitespace();
    if parser.offset == text.len() {
        Ok(value)
    } else {
        Err(ParseError)
    }
}

/// `stableJson(JSON.parse(text))`.
///
/// # Errors
///
/// Returns [`ParseError`] as [`parse`] does.
pub fn stable_json(text: &str) -> Result<String, ParseError> {
    Ok(to_stable(&parse(text)?))
}

/// The canonical text of a value.
#[must_use]
pub fn to_stable(value: &Json) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// The members sorted by key (UTF-16 code units), or an error for a duplicate key.
///
/// One sort and one pass over neighbours: `O(n log n)` key comparisons. Checking each new key
/// against every earlier one is quadratic in the member count, which a body within the 1 MiB
/// limit can make take seconds (20,000 keys with a shared 40-character prefix).
fn sorted_unique(mut members: Vec<(Vec<u16>, Json)>) -> Result<Json, ParseError> {
    members.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    if members.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(ParseError);
    }
    Ok(Json::Object(members))
}

struct Parser<'a> {
    text: &'a str,
    offset: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.offset).copied()
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.offset += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), ParseError> {
        if self.peek() == Some(byte) {
            self.offset += 1;
            Ok(())
        } else {
            Err(ParseError)
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, ParseError> {
        if self.text.as_bytes()[self.offset..].starts_with(word.as_bytes()) {
            self.offset += word.len();
            Ok(value)
        } else {
            Err(ParseError)
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, ParseError> {
        match self.peek().ok_or(ParseError)? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => Ok(Json::String(self.string()?)),
            b't' => self.literal("true", Json::Bool(true)),
            b'f' => self.literal("false", Json::Bool(false)),
            b'n' => self.literal("null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(ParseError),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, ParseError> {
        if depth >= MAX_DEPTH {
            return Err(ParseError);
        }
        self.expect(b'{')?;
        let mut members: Vec<(Vec<u16>, Json)> = Vec::new();
        self.whitespace();
        if self.peek() == Some(b'}') {
            self.offset += 1;
            return Ok(Json::Object(members));
        }
        loop {
            self.whitespace();
            let key = self.string()?;
            self.whitespace();
            self.expect(b':')?;
            self.whitespace();
            let value = self.value(depth + 1)?;
            members.push((key, value));
            self.whitespace();
            match self.peek() {
                Some(b',') => self.offset += 1,
                Some(b'}') => {
                    self.offset += 1;
                    return sorted_unique(members);
                }
                _ => return Err(ParseError),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, ParseError> {
        if depth >= MAX_DEPTH {
            return Err(ParseError);
        }
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.whitespace();
        if self.peek() == Some(b']') {
            self.offset += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.whitespace();
            items.push(self.value(depth + 1)?);
            self.whitespace();
            match self.peek() {
                Some(b',') => self.offset += 1,
                Some(b']') => {
                    self.offset += 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err(ParseError),
            }
        }
    }

    fn hex4(&mut self) -> Result<u16, ParseError> {
        let digits = self
            .text
            .get(self.offset..self.offset + 4)
            .ok_or(ParseError)?;
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ParseError);
        }
        self.offset += 4;
        u16::from_str_radix(digits, 16).map_err(|_| ParseError)
    }

    fn string(&mut self) -> Result<Vec<u16>, ParseError> {
        self.expect(b'"')?;
        let mut units = Vec::new();
        loop {
            let byte = self.peek().ok_or(ParseError)?;
            match byte {
                b'"' => {
                    self.offset += 1;
                    return Ok(units);
                }
                b'\\' => {
                    self.offset += 1;
                    let escape = self.peek().ok_or(ParseError)?;
                    self.offset += 1;
                    let unit = match escape {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => return Err(ParseError),
                    };
                    units.push(unit);
                }
                0x00..=0x1f => return Err(ParseError),
                0x20..=0x7f => {
                    units.push(u16::from(byte));
                    self.offset += 1;
                }
                _ => {
                    let character = self.text[self.offset..].chars().next().ok_or(ParseError)?;
                    let mut buffer = [0_u16; 2];
                    units.extend_from_slice(character.encode_utf16(&mut buffer));
                    self.offset += character.len_utf8();
                }
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.offset;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.offset += 1;
        }
        self.offset - start
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.offset;
        if self.peek() == Some(b'-') {
            self.offset += 1;
        }
        match self.peek() {
            Some(b'0') => self.offset += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(ParseError),
        }
        if self.peek() == Some(b'.') {
            self.offset += 1;
            if self.digits() == 0 {
                return Err(ParseError);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            if self.digits() == 0 {
                return Err(ParseError);
            }
        }
        // Rust's float parsing is correctly rounded and overflows to infinity, as
        // ECMAScript's StringToNumber does.
        self.text[start..self.offset]
            .parse::<f64>()
            .map(Json::Number)
            .map_err(|_| ParseError)
    }
}

fn write_value(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Number(number) => out.push_str(&json_number(*number)),
        Json::String(units) => write_string(units, out),
        Json::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Json::Object(members) => {
            let mut sorted: Vec<&(Vec<u16>, Json)> = members.iter().collect();
            // `Vec<u16>` orders lexicographically by code unit, a prefix first: the order of
            // the default `Array.prototype.sort` on strings.
            sorted.sort_by(|left, right| left.0.cmp(&right.0));
            out.push('{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_value(item, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify` of a string of UTF-16 code units (ECMAScript `QuoteJSONString`).
fn write_string(units: &[u16], out: &mut String) {
    out.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(character) if u32::from(character) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(character));
            }
            Ok(character) => out.push(character),
            Err(lone) => {
                let _ = write!(out, "\\u{:04x}", lone.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

/// `JSON.stringify` of a number: `null` when not finite, else `Number::toString`.
fn json_number(value: f64) -> String {
    if value.is_finite() {
        number_to_string(value)
    } else {
        "null".to_owned()
    }
}

/// ECMAScript `Number::toString(x)` (radix 10) for a finite `x`.
///
/// The shortest round-trip digits come from Rust's `{:e}` formatting, which, like the
/// ECMAScript algorithm, picks the fewest digits `s` (and among those the closest to `x`) for
/// which `s × 10^(n−k)` reads back as `x`. The placement of the decimal point and exponent
/// follows the specification's steps.
fn number_to_string(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    if value < 0.0 {
        return format!("-{}", number_to_string(-value));
    }
    // Fast path: a whole number below 2^53 prints as its integer digits, which is step 6 of
    // the algorithm (k ≤ n ≤ 21) with the shortest digits of an exact integer.
    if value.fract() == 0.0 && value < 9_007_199_254_740_992.0 {
        // Exact: a whole double below 2^53 converts to `u64` without truncation.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let whole = value as u64;
        return whole.to_string();
    }
    let (digits, exponent) = shortest_digits(value);
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let n = exponent + 1;
    let zeros = |count: i64| "0".repeat(usize::try_from(count).unwrap_or(0));
    if k <= n && n <= 21 {
        format!("{digits}{}", zeros(n - k))
    } else if 0 < n && n <= 21 {
        let split = usize::try_from(n).unwrap_or(0);
        format!("{}.{}", &digits[..split], &digits[split..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", zeros(-n))
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let magnitude = (n - 1).abs();
        if k == 1 {
            format!("{digits}e{sign}{magnitude}")
        } else {
            format!("{}.{}e{sign}{magnitude}", &digits[..1], &digits[1..])
        }
    }
}

/// Splits Rust's `{:e}` rendering into its digits and its exponent.
fn scientific(text: &str) -> (String, i64) {
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    (
        mantissa.chars().filter(char::is_ascii_digit).collect(),
        exponent.parse().unwrap_or(0),
    )
}

/// The digits `n` and the exponent `n − 1` of ECMAScript `Number::toString` step 5 for a
/// finite `x > 0`: the fewest digits `k` for which `n × 10^(e−k+1)` reads back as `x`; among
/// several such `n` the one closest to `x`, and of two equally close the even one.
///
/// Rust's shortest rendering has the fewest digits and the closest value, but breaks an exact
/// tie between the two closest candidates upward (`93794707416597.125` prints as `…597.13`,
/// where ECMAScript prints `…597.12`). This resolves a tie to the even candidate. A tie needs
/// the exact expansion of `x` to have `k + 1` digits, which for a normal double requires
/// `k ≥ 15`, because every decimal of at most 15 digits reads back as a distinct double
/// (a subnormal's exact expansion has hundreds of digits, so it never ties).
///
/// The tie test is constant-time integer arithmetic ([`is_exactly`]), not an exact decimal
/// expansion: a body may hold tens of thousands of numbers.
fn shortest_digits(value: f64) -> (String, i64) {
    let (digits, exponent) = scientific(&format!("{value:e}"));
    if digits.len() < 15 {
        return (digits, exponent);
    }
    let Ok(candidate) = digits.parse::<u64>() else {
        return (digits, exponent);
    };
    if candidate % 2 == 0 {
        return (digits, exponent);
    }
    let k = digits.len();
    // The candidate's value is `candidate × 10^scale`.
    let scale = exponent + 1 - i64::try_from(k).unwrap_or(0);
    for neighbor in [candidate - 1, candidate + 1] {
        let text = format!("{neighbor:0k$}");
        if text.len() != k || text.starts_with('0') {
            continue;
        }
        // `x` is exactly the midpoint `(10 × lower + 5) × 10^(scale − 1)` of the two.
        let lower = u128::from(neighbor.min(candidate));
        if is_exactly(value, lower * 10 + 5, scale - 1)
            && format!("{neighbor}e{scale}").parse::<f64>() == Ok(value)
        {
            return (text, exponent);
        }
    }
    (digits, exponent)
}

/// Whether the finite `x > 0` equals `m × 10^t` exactly, for `m < 2^64 × 10`.
///
/// `x = b × 2^e` with `b < 2^53`. For `t ≥ 0`, `m × 5^t × 2^t` has the odd part of `m × 5^t`,
/// which must be the odd part of `b`, so `5^t < 2^53` (`t ≤ 22`). For `t < 0`,
/// `m = b × 5^−t × 2^(e−t)`, so `5^−t ≤ m < 2^68` (`−t ≤ 29`). Beyond those bounds `x` cannot
/// equal `m × 10^t`. Within them every product fits a `u128`.
fn is_exactly(value: f64, m: u128, t: i64) -> bool {
    let bits = value.to_bits();
    let field = i64::try_from((bits >> 52) & 0x7ff).unwrap_or(0);
    let fraction = bits & ((1 << 52) - 1);
    let (b, e) = if field == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1 << 52), field - 1075)
    };
    if b == 0 || m == 0 {
        return false;
    }
    let odd = |n: u128| -> (u128, i64) {
        let zeros = n.trailing_zeros();
        (n >> zeros, i64::from(zeros))
    };
    let power_of_five = |n: i64| u32::try_from(n).ok().and_then(|n| 5_u128.checked_pow(n));
    if t >= 0 {
        if t > 22 {
            return false;
        }
        let Some(left) = power_of_five(t).and_then(|five| m.checked_mul(five)) else {
            return false;
        };
        let (left_odd, left_twos) = odd(left);
        let (right_odd, right_twos) = odd(u128::from(b));
        left_odd == right_odd && left_twos + t == right_twos + e
    } else {
        if -t > 29 {
            return false;
        }
        let Some(right) = power_of_five(-t).and_then(|five| u128::from(b).checked_mul(five)) else {
            return false;
        };
        let (left_odd, left_twos) = odd(m);
        let (right_odd, right_twos) = odd(right);
        left_odd == right_odd && left_twos == right_twos + e - t
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_DEPTH, ParseError, number_to_string, parse, stable_json};

    fn canonical(text: &str) -> String {
        stable_json(text).unwrap_or_else(|_| "<error>".to_owned())
    }

    #[test]
    fn numbers_print_as_ecmascript_number_to_string() {
        for (text, expected) in [
            ("0", "0"),
            ("-0", "0"),
            ("-0.0", "0"),
            ("1.0", "1"),
            ("1E5", "100000"),
            ("1e21", "1e+21"),
            ("1e20", "100000000000000000000"),
            ("123456789012345678901", "123456789012345680000"),
            ("1e-7", "1e-7"),
            ("1e-6", "0.000001"),
            ("1.5e-7", "1.5e-7"),
            ("0.1", "0.1"),
            ("5e-324", "5e-324"),
            ("1.7976931348623157e308", "1.7976931348623157e+308"),
            ("9007199254740993", "9007199254740992"),
            ("9007199254740995", "9007199254740996"),
            ("18446744073709551616", "18446744073709552000"),
            ("1e400", "null"),
            ("-1e400", "null"),
            ("123.456", "123.456"),
            ("-12.5e3", "-12500"),
            ("0.000001234", "0.000001234"),
            ("1.25e+30", "1.25e+30"),
            ("100", "100"),
            // Exact ties between two shortest candidates resolve to the even one.
            ("93794707416597.1317", "93794707416597.12"),
            ("70368744177664.125", "70368744177664.12"),
            ("70368744177664.375", "70368744177664.38"),
            ("1e23", "1e+23"),
            ("9007199254740993e10", "9.007199254740994e+25"),
            ("5.5e-310", "5.5e-310"),
        ] {
            assert_eq!(canonical(text), expected, "{text}");
        }
        assert_eq!(
            number_to_string(f64::MIN_POSITIVE),
            "2.2250738585072014e-308"
        );
    }

    #[test]
    fn strings_use_json_stringify_escapes() {
        assert_eq!(
            canonical(r#""\u0000\u001f\b\f\n\r\t\"\\\/ \u2028\u2029\u007f""#),
            "\"\\u0000\\u001f\\b\\f\\n\\r\\t\\\"\\\\/ \u{2028}\u{2029}\u{7f}\""
        );
        // Lone surrogates survive as lowercase escapes; an escaped pair becomes the character.
        assert_eq!(canonical(r#""\uD800""#), r#""\ud800""#);
        assert_eq!(canonical(r#""\udc00x\ud800""#), r#""\udc00x\ud800""#);
        assert_eq!(canonical(r#""\ud83d\ude00""#), "\"\u{1f600}\"");
        assert_eq!(canonical(r#""\u0041é""#), "\"Aé\"");
    }

    #[test]
    fn keys_sort_by_utf16_code_units() {
        // U+1F600 is D83D DE00 in UTF-16, which sorts before U+E000 and U+FFFF, though its code
        // point is larger.
        assert_eq!(
            canonical(
                "{\"\u{ffff}\":1,\"\u{e000}\":2,\"\u{1f600}\":3,\"b\":4,\"a\":5,\"\":6,\"aa\":7}"
            ),
            "{\"\":6,\"a\":5,\"aa\":7,\"b\":4,\"\u{1f600}\":3,\"\u{e000}\":2,\"\u{ffff}\":1}"
        );
        assert_eq!(
            canonical(r#"{"b":[{"d":1,"c":2}],"a":{"z":null,"y":true}}"#),
            r#"{"a":{"y":true,"z":null},"b":[{"c":2,"d":1}]}"#
        );
    }

    #[test]
    fn rejects_what_json_parse_rejects_and_duplicates() {
        for text in [
            "",
            " ",
            "01",
            "1.",
            ".1",
            "+1",
            "1e",
            "-",
            "NaN",
            "Infinity",
            "[1,]",
            "{\"a\":1,}",
            "\"\u{1}\"",
            "\"\\x\"",
            "\"\\u12\"",
            "tru",
            "nul",
            "[] []",
            "{\"a\" 1}",
            "'a'",
            "{\"a\":1,\"a\":2}",
            "{\"a\":1,\"\\u0061\":2}",
            "\u{feff}{}",
            "\u{a0}1",
        ] {
            assert_eq!(parse(text), Err(ParseError), "{text:?}");
        }
        assert_eq!(canonical(" \t\r\n{ \"a\" : [ ] } \n"), r#"{"a":[]}"#);
    }

    #[test]
    fn exactness_test_for_ties() {
        use super::is_exactly;
        assert!(is_exactly(
            93_794_707_416_597.0 + 0.125,
            93_794_707_416_597_125,
            -3
        ));
        assert!(!is_exactly(
            93_794_707_416_597.0 + 0.125,
            93_794_707_416_597_135,
            -3
        ));
        assert!(is_exactly(1e22, 1, 22));
        assert!(!is_exactly(1e23, 1, 23), "1e23 is not a double");
        assert!(is_exactly(0.5, 5, -1));
        assert!(!is_exactly(0.1, 1, -1));
        assert!(is_exactly(6_144.0, 6_144, 0));
        assert!(is_exactly(6_144.0, 6_144_000, -3));
        assert!(!is_exactly(5e-324, 5, -324));
        assert!(!is_exactly(f64::MAX, 17_976_931_348_623_157, 292));
    }

    #[test]
    fn nesting_is_bounded() {
        let deep = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert_eq!(canonical(&deep(MAX_DEPTH)), deep(MAX_DEPTH));
        assert_eq!(parse(&deep(MAX_DEPTH + 1)), Err(ParseError));
    }
}
