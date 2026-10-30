//! Core's canonical JSON (ADR 0025). This module is its only definition; it is not required
//! to equal what any TypeScript function prints.
//!
//! The text is parsed by `serde_json` (strict RFC 8259, the grammar `JSON.parse` accepts),
//! with correctly rounded decimal-to-double conversion (`float_roundtrip`), into a [`Json`]
//! value. Parsing fails closed with [`ParseError`] on anything else: a duplicate key, nesting
//! deeper than [`MAX_DEPTH`], a number outside the finite IEEE double range (`1e400`), and an
//! escaped lone surrogate (`"\ud800"`), which `serde_json` rejects. The canonical text is:
//!
//! - no insignificant whitespace; arrays in their order; `true`, `false`, and `null` as such;
//! - **numbers** (ADR 0025 (b)): a number whose value is an integer of magnitude at most
//!   2^53 − 1 is printed as its decimal digits, with a leading `-` when negative, whatever its
//!   spelling (`1`, `1.0`, `1e0`, and `10E-1` print `1`; `-0` prints `0`). Every other number
//!   is printed as `serde_json` prints the number it read: an integer lexeme within the
//!   64-bit range (`9007199254740993`) as its exact digits, anything else as the shortest text
//!   that reads back as the same double (`1.5`, `1e+21`, `1e-7`,
//!   `1.8446744073709552e+19`);
//! - **strings** (ADR 0025 (c)): escaped as `JSON.stringify` escapes them: `"` as `\"`, `\` as
//!   `\\`, U+0008, U+0009, U+000A, U+000C, and U+000D as `\b`, `\t`, `\n`, `\f`, and `\r`,
//!   every other character below U+0020 as `\u00xx` with lowercase hexadecimal digits, and
//!   every other character (`/`, U+007F, U+2028, U+2029, and all non-ASCII included) raw, as
//!   its UTF-8 bytes;
//! - **object keys** (ADR 0025 (d)): members sorted by the UTF-8 bytes of their keys (the
//!   order of Unicode code points), keys printed as strings.
//!
//! Parsing and printing are linear in the text, except sorting each object's members, which
//! is `O(n log n)` in its member count.

use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt::{self, Write as _};

/// The deepest nesting accepted: `serde_json`'s recursion limit. The engine rejects bodies
/// nested deeper than 64 levels before any identity is computed, so every body it accepts is
/// within this bound.
pub const MAX_DEPTH: usize = 127;

/// The largest integer magnitude printed as plain digits whatever its spelling: 2^53 − 1.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A parsed JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    /// Members with unique keys. [`parse`] returns them sorted by key; the writer sorts every
    /// object, so a value built in code may list them in any order.
    Object(Vec<(String, Json)>),
}

/// The text is not strict JSON, has a duplicate key, nests too deeply, has a number outside
/// the double range, or has an escaped lone surrogate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParseError;

impl Json {
    /// A string value from Rust text.
    #[must_use]
    pub fn string(text: &str) -> Self {
        Self::String(text.to_owned())
    }

    /// The member `key` of an object, if this is an object that has it.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Json> {
        let Self::Object(members) = self else {
            return None;
        };
        members
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    /// The value as Rust text, if it is a string.
    #[must_use]
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }
}

/// Parses strict JSON text.
///
/// # Errors
///
/// Returns [`ParseError`] for text that is not strict JSON, a duplicate key, nesting deeper
/// than [`MAX_DEPTH`], a number outside the double range, or an escaped lone surrogate.
pub fn parse(text: &str) -> Result<Json, ParseError> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = ValueSeed
        .deserialize(&mut deserializer)
        .map_err(|_| ParseError)?;
    deserializer.end().map_err(|_| ParseError)?;
    Ok(value)
}

/// The canonical text of a JSON text.
///
/// # Errors
///
/// Returns [`ParseError`] as [`parse`] does.
pub fn canonical_json(text: &str) -> Result<String, ParseError> {
    Ok(to_canonical(&parse(text)?))
}

/// The canonical text of a value.
#[must_use]
pub fn to_canonical(value: &Json) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// Builds a [`Json`] from `serde_json`'s events, rejecting duplicate keys.
struct ValueSeed;

impl<'de> DeserializeSeed<'de> for ValueSeed {
    type Value = Json;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Json, D::Error> {
        deserializer.deserialize_any(ValueVisitor)
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Json;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
        Ok(Json::Bool(value))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
        Ok(Json::Number(value.into()))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
        Ok(Json::Number(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Json, E> {
        serde_json::Number::from_f64(value)
            .map(Json::Number)
            .ok_or_else(|| E::custom("number out of range"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Json, E> {
        Ok(Json::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Json, E> {
        Ok(Json::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = access.next_element_seed(ValueSeed)? {
            items.push(item);
        }
        Ok(Json::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Json, A::Error> {
        let mut members = Vec::new();
        while let Some(key) = access.next_key::<String>()? {
            members.push((key, access.next_value_seed(ValueSeed)?));
        }
        // One sort and one pass over neighbours: `O(n log n)` key comparisons. Checking each
        // new key against every earlier one is quadratic in the member count, which a body
        // within the 1 MiB limit can make take seconds (#55 review).
        members.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        if members.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return Err(de::Error::custom("duplicate key"));
        }
        Ok(Json::Object(members))
    }
}

fn write_value(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Number(number) => write_number(number, out),
        Json::String(text) => write_string(text, out),
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
            let mut sorted: Vec<&(String, Json)> = members.iter().collect();
            // `str` orders by UTF-8 bytes, which is the order of code points.
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

/// ADR 0025 (b): integers within 2^53 − 1 as digits, whatever their spelling; everything else
/// as `serde_json` prints it.
fn write_number(number: &serde_json::Number, out: &mut String) {
    if number.is_f64() {
        let value = number.as_f64().unwrap_or(f64::NAN);
        if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
            // An integer of magnitude below 2^53: the conversion is exact; `-0` becomes `0`.
            #[allow(clippy::cast_possible_truncation)]
            let integer = value as i64;
            let _ = write!(out, "{integer}");
            return;
        }
    }
    let _ = write!(out, "{number}");
}

/// ADR 0025 (c): `JSON.stringify`'s escapes; every other character raw.
fn write_string(text: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    let bytes = text.as_bytes();
    let mut start = 0;
    for (index, &byte) in bytes.iter().enumerate() {
        let escape: &str = match byte {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            0x08 => "\\b",
            0x09 => "\\t",
            0x0a => "\\n",
            0x0c => "\\f",
            0x0d => "\\r",
            0x00..=0x1f => "",
            _ => continue,
        };
        // Every byte below 0x80 is a whole character, so `index` is a character boundary.
        out.push_str(&text[start..index]);
        if escape.is_empty() {
            out.push_str("\\u00");
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0xf)]));
        } else {
            out.push_str(escape);
        }
        start = index + 1;
    }
    out.push_str(&text[start..]);
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::{Json, MAX_DEPTH, ParseError, canonical_json, parse, to_canonical};

    fn canonical(text: &str) -> String {
        canonical_json(text).unwrap_or_else(|_| "<error>".to_owned())
    }

    #[test]
    fn integers_within_2_pow_53_print_as_digits_whatever_their_spelling() {
        for (text, expected) in [
            ("0", "0"),
            ("-0", "0"),
            ("-0.0", "0"),
            ("-0e5", "0"),
            ("1", "1"),
            ("1.0", "1"),
            ("1e0", "1"),
            ("10E-1", "1"),
            ("100e-2", "1"),
            ("0.99999999999999999999", "1"),
            ("1E5", "100000"),
            ("1.50E+3", "1500"),
            ("-12.5e3", "-12500"),
            ("1e15", "1000000000000000"),
            ("9007199254740991", "9007199254740991"),
            ("9007199254740991.0", "9007199254740991"),
            ("9.007199254740991e15", "9007199254740991"),
            ("-9007199254740991", "-9007199254740991"),
            ("-9007199254740991.0", "-9007199254740991"),
            ("1e-400", "0"),
        ] {
            assert_eq!(canonical(text), expected, "{text}");
        }
    }

    #[test]
    fn other_numbers_print_as_serde_json_prints_them() {
        for (text, expected) in [
            ("0.1", "0.1"),
            ("1.5", "1.5"),
            ("-37.40", "-37.4"),
            ("4503599627370495.5", "4503599627370495.5"),
            ("1e-7", "1e-7"),
            ("5e-324", "5e-324"),
            ("1e21", "1e+21"),
            ("1e16", "1e+16"),
            ("9007199254740992.0", "9007199254740992.0"),
            ("1.7976931348623157e308", "1.7976931348623157e+308"),
            // Integer lexemes of the 64-bit range keep their exact digits, as compile reads them.
            ("9007199254740992", "9007199254740992"),
            ("9007199254740993", "9007199254740993"),
            ("-9223372036854775808", "-9223372036854775808"),
            ("18446744073709551615", "18446744073709551615"),
            ("18446744073709551616", "1.8446744073709552e+19"),
        ] {
            assert_eq!(canonical(text), expected, "{text}");
        }
        // Every printed number reads back as the same value.
        for text in ["0.1", "1e21", "5e-324", "123.456e-2", "-1.5e300"] {
            let printed = canonical(text);
            assert_eq!(canonical(&printed), printed, "{text}");
            assert_eq!(
                printed.parse::<f64>().ok(),
                text.parse::<f64>().ok(),
                "{text}"
            );
        }
    }

    #[test]
    fn numbers_outside_the_double_range_are_rejected() {
        for text in ["1e400", "-1e400", "[1e309]", "{\"a\":-2e308}"] {
            assert_eq!(parse(text), Err(ParseError), "{text}");
        }
    }

    #[test]
    fn strings_use_json_stringify_escapes() {
        assert_eq!(
            canonical(r#""\u0000\u0001\u001f\b\f\n\r\t\"\\\/ \u2028\u2029\u007f""#),
            "\"\\u0000\\u0001\\u001f\\b\\f\\n\\r\\t\\\"\\\\/ \u{2028}\u{2029}\u{7f}\""
        );
        assert_eq!(canonical(r#""\u000B\u001A""#), r#""\u000b\u001a""#);
        // An escaped pair is the character, printed raw; non-ASCII stays raw.
        assert_eq!(canonical(r#""\ud83d\ude00""#), "\"\u{1f600}\"");
        assert_eq!(canonical(r#""\u0041é山""#), "\"Aé山\"");
        assert_eq!(
            canonical("\"\u{1f600}\u{e000}\u{ffff}\""),
            "\"\u{1f600}\u{e000}\u{ffff}\""
        );
        assert_eq!(
            to_canonical(&Json::string("a\u{0}\"\\\u{7f}")),
            "\"a\\u0000\\\"\\\\\u{7f}\""
        );
    }

    #[test]
    fn escaped_lone_surrogates_are_rejected() {
        for text in [
            r#""\ud800""#,
            r#""\uDBFF""#,
            r#""\udc00""#,
            r#""\ud800x""#,
            r#""\udc00\ud800""#,
            r#""\ud800\u0041""#,
            r#"{"\ud800":1}"#,
        ] {
            assert_eq!(parse(text), Err(ParseError), "{text}");
        }
    }

    #[test]
    fn keys_sort_by_utf8_bytes() {
        // By code point: U+E000 and U+FFFF before U+1F600 (UTF-16 code units would put U+1F600
        // first, as D83D DE00).
        assert_eq!(
            canonical(
                "{\"\u{ffff}\":1,\"\u{e000}\":2,\"\u{1f600}\":3,\"b\":4,\"a\":5,\"\":6,\"aa\":7,\"B\":8,\"é\":9}"
            ),
            "{\"\":6,\"B\":8,\"a\":5,\"aa\":7,\"b\":4,\"é\":9,\"\u{e000}\":2,\"\u{ffff}\":1,\"\u{1f600}\":3}"
        );
        assert_eq!(
            canonical(r#"{"b":[{"d":1,"c":2}],"a":{"z":null,"y":true}}"#),
            r#"{"a":{"y":true,"z":null},"b":[{"c":2,"d":1}]}"#
        );
        // A value built in code is sorted when written.
        assert_eq!(
            to_canonical(&Json::Object(vec![
                ("z".to_owned(), Json::Null),
                ("a".to_owned(), Json::Bool(true)),
            ])),
            r#"{"a":true,"z":null}"#
        );
    }

    #[test]
    fn canonical_text_is_deterministic_and_a_fixed_point() {
        for text in [
            " { \"b\" : [ 1 , { \"d\" : null , \"c\" : \"x\" } ] , \"a\" : { } } ",
            r#"{"z":[1.0,-0,1e21,0.1,"\u2028"],"a":{"é":"\u0000","e":false}}"#,
        ] {
            let once = canonical(text);
            assert_eq!(canonical(text), once);
            assert_eq!(canonical(&once), once, "{text}");
        }
        assert_eq!(
            canonical(" { \"b\" : [ 1 , { \"d\" : null , \"c\" : \"x\" } ] , \"a\" : { } } "),
            r#"{"a":{},"b":[1,{"c":"x","d":null}]}"#
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
            "{\"b\":1,\"a\":2,\"c\":3,\"a\":4}",
            "[{\"x\":{\"y\":1,\"y\":1}}]",
            "\u{feff}{}",
            "\u{a0}1",
        ] {
            assert_eq!(parse(text), Err(ParseError), "{text:?}");
        }
        assert!(parse(r#"{"a":1,"a\u0000":2,"A":3}"#).is_ok());
        assert_eq!(canonical(" \t\r\n{ \"a\" : [ ] } \n"), r#"{"a":[]}"#);
    }

    #[test]
    fn nesting_is_bounded() {
        let arrays = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        let objects = |depth: usize| format!("{}1{}", "{\"a\":".repeat(depth), "}".repeat(depth));
        assert_eq!(canonical(&arrays(MAX_DEPTH)), arrays(MAX_DEPTH));
        assert_eq!(canonical(&objects(MAX_DEPTH)), objects(MAX_DEPTH));
        assert_eq!(parse(&arrays(MAX_DEPTH + 1)), Err(ParseError));
        assert_eq!(parse(&objects(MAX_DEPTH + 1)), Err(ParseError));
        // The engine's bound (64 levels) is well within.
        assert_eq!(canonical(&arrays(65)), arrays(65));
    }
}
