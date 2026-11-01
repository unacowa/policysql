#![forbid(unsafe_code)]
//! The strict JSON check of an untrusted body (ADR 0027 pull request 7, #60, #66).
//!
//! One parser, `serde_json`'s, does syntax, Unicode escapes, and number range; this module's
//! visitors add the rules the engine used to scan for in TypeScript: every JSON value and every
//! object member name counts toward `maxJsonValues`, object member names are unique after
//! escape decoding, and arrays and objects nest at most [`MAX_DEPTH`] levels. Nothing is
//! materialized: strings are visited in place, an object keeps only its keys for the duplicate
//! check, and the walk stops at the first value over the limit. An escaped lone surrogate
//! (`"\ud800"` as six ASCII characters) is a [`StrictError::LoneSurrogate`], the same text a
//! raw lone surrogate denotes (ADR 0025).

use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use std::borrow::Cow;
use std::collections::HashSet;
use std::fmt;

pub use crate::canonical::MAX_DEPTH;

/// Why strict JSON text was rejected.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StrictError {
    /// Not strict JSON, including trailing content and a number outside the double range.
    Syntax,
    /// Two object member names are equal after decoding escapes.
    DuplicateKey,
    /// An array or object nests deeper than [`MAX_DEPTH`].
    TooDeep,
    /// More JSON values (and object member names) than the limit allows.
    TooManyValues,
    /// An escaped lone surrogate: the string it denotes has no UTF-8 form (ADR 0025).
    LoneSurrogate,
}

const DUPLICATE_KEY: &str = "policysql: strict json: duplicate key";
const TOO_DEEP: &str = "policysql: strict json: nesting too deep";
const TOO_MANY_VALUES: &str = "policysql: strict json: too many values";

/// Checks `text` as strict JSON without building it.
///
/// `max_values` bounds the number of JSON values plus object member names; `None` counts them
/// without a limit (a compile-time cross-check of an already bounded body).
///
/// # Errors
///
/// Returns the first [`StrictError`] the text breaks.
pub fn check(text: &str, max_values: Option<usize>) -> Result<(), StrictError> {
    check_with_max_depth(text, max_values, MAX_DEPTH)
}

/// [`check`] with an explicit nesting bound. Only an internal caller that wraps a
/// client-checked body in a fixed-size envelope uses a bound above [`MAX_DEPTH`]; the client
/// body limit remains [`MAX_DEPTH`].
///
/// # Errors
///
/// Returns the first [`StrictError`] the text breaks.
pub fn check_with_max_depth(
    text: &str,
    max_values: Option<usize>,
    max_depth: usize,
) -> Result<(), StrictError> {
    let mut counter = Counter {
        values: 0,
        max_values,
        max_depth,
    };
    let mut deserializer = serde_json::Deserializer::from_str(text);
    CheckSeed {
        depth: 0,
        counter: &mut counter,
    }
    .deserialize(&mut deserializer)
    .map_err(|error| classify(&error))?;
    deserializer.end().map_err(|_| StrictError::Syntax)?;
    Ok(())
}

/// `serde_json`'s error, mapped to the rule it broke. Our own errors are custom messages; the
/// two surrogate messages are the parser's names for an escaped lone surrogate.
fn classify(error: &serde_json::Error) -> StrictError {
    let message = error.to_string();
    if message.contains(DUPLICATE_KEY) {
        StrictError::DuplicateKey
    } else if message.contains(TOO_DEEP) {
        StrictError::TooDeep
    } else if message.contains(TOO_MANY_VALUES) {
        StrictError::TooManyValues
    } else if message.contains("lone leading surrogate")
        || message.contains("unexpected end of hex escape")
    {
        StrictError::LoneSurrogate
    } else {
        StrictError::Syntax
    }
}

struct Counter {
    values: usize,
    max_values: Option<usize>,
    max_depth: usize,
}

impl Counter {
    fn count<E: de::Error>(&mut self) -> Result<(), E> {
        self.values = self.values.saturating_add(1);
        if self.max_values.is_some_and(|max| self.values > max) {
            return Err(E::custom(TOO_MANY_VALUES));
        }
        Ok(())
    }
}

struct CheckSeed<'a> {
    depth: usize,
    counter: &'a mut Counter,
}

impl<'de> DeserializeSeed<'de> for CheckSeed<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(Check {
            depth: self.depth,
            counter: self.counter,
        })
    }
}

struct Check<'a> {
    depth: usize,
    counter: &'a mut Counter,
}

impl<'de> Visitor<'de> for Check<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        self.counter.count()
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        self.counter.count()
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
        self.counter.count()
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
        self.counter.count()
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        self.counter.count()
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<(), E> {
        self.counter.count()
    }

    fn visit_borrowed_str<E: de::Error>(self, _: &'de str) -> Result<(), E> {
        self.counter.count()
    }

    fn visit_string<E: de::Error>(self, _: String) -> Result<(), E> {
        self.counter.count()
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<(), A::Error> {
        if self.depth >= self.counter.max_depth {
            return Err(de::Error::custom(TOO_DEEP));
        }
        self.counter.count()?;
        while access
            .next_element_seed(CheckSeed {
                depth: self.depth + 1,
                counter: &mut *self.counter,
            })?
            .is_some()
        {}
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<(), A::Error> {
        if self.depth >= self.counter.max_depth {
            return Err(de::Error::custom(TOO_DEEP));
        }
        self.counter.count()?;
        // One set per object level, as the TypeScript scan had: it is released when the object
        // ends, so the live memory is the nesting path's keys, not every key in the body.
        let mut keys: HashSet<Cow<'de, str>> = HashSet::new();
        while let Some(key) = access.next_key::<Cow<'de, str>>()? {
            self.counter.count()?;
            if !keys.insert(key) {
                return Err(de::Error::custom(DUPLICATE_KEY));
            }
            access.next_value_seed(CheckSeed {
                depth: self.depth + 1,
                counter: &mut *self.counter,
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::{MAX_DEPTH, StrictError, check, check_with_max_depth};

    #[test]
    fn values_and_member_names_count_exactly() {
        for (text, values) in [
            ("1", 1),
            ("[]", 1),
            ("{}", 1),
            ("[1,2]", 3),
            (r#"{"a":1}"#, 3),
            (r#"{"a":[1,"x",null,true]}"#, 7),
            (r#"[{"a":1},{"b":2}]"#, 7),
            (r#""s""#, 1),
            (r#"{"a":{"b":{"c":1}}}"#, 7),
        ] {
            assert_eq!(check(text, Some(values)), Ok(()), "{text} at {values}");
            assert_eq!(
                check(text, Some(values - 1)),
                Err(StrictError::TooManyValues),
                "{text} at {}",
                values - 1
            );
        }
        assert_eq!(check("[1,2,3,4]", Some(3)), Err(StrictError::TooManyValues));
    }

    #[test]
    fn duplicate_keys_are_rejected_after_escape_decoding() {
        assert_eq!(
            check(r#"{"a":1,"a":2}"#, None),
            Err(StrictError::DuplicateKey)
        );
        assert_eq!(
            check(r#"{"id":1,"id":2}"#, None),
            Err(StrictError::DuplicateKey)
        );
        // Escapes are decoded before comparison: this key is also "id".
        let escaped = format!("{{\"{}u0069d\":1,\"id\":2}}", char::from(92));
        assert_eq!(check(&escaped, None), Err(StrictError::DuplicateKey));
        assert_eq!(check(r#"{"a":1,"b":2}"#, None), Ok(()));
        // The same name in different objects is not a duplicate.
        assert_eq!(check(r#"[{"a":1},{"a":2}]"#, None), Ok(()));
    }

    #[test]
    fn nesting_is_bounded_at_the_documented_depth() {
        let arrays = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        let objects = |depth: usize| format!("{}1{}", r#"{"a":"#.repeat(depth), "}".repeat(depth));
        assert_eq!(check(&arrays(MAX_DEPTH), None), Ok(()));
        assert_eq!(check(&objects(MAX_DEPTH), None), Ok(()));
        assert_eq!(
            check(&arrays(MAX_DEPTH + 1), None),
            Err(StrictError::TooDeep)
        );
        assert_eq!(
            check(&objects(MAX_DEPTH + 1), None),
            Err(StrictError::TooDeep)
        );
    }

    #[test]
    fn an_internal_envelope_bound_is_explicit_and_still_bounded() {
        let arrays = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert_eq!(
            check_with_max_depth(&arrays(MAX_DEPTH + 2), None, MAX_DEPTH + 2),
            Ok(())
        );
        assert_eq!(
            check_with_max_depth(&arrays(MAX_DEPTH + 3), None, MAX_DEPTH + 2),
            Err(StrictError::TooDeep)
        );
        // The public check is unchanged.
        assert_eq!(
            check(&arrays(MAX_DEPTH + 2), None),
            Err(StrictError::TooDeep)
        );
    }

    #[test]
    fn syntax_and_surrogates_are_distinguished() {
        for text in ["", "[1,", "{\"a\":}", "1 2", "01", "1e400"] {
            assert_eq!(check(text, None), Err(StrictError::Syntax), "{text}");
        }
        // Escaped lone surrogates are rejected as the raw one is (ADR 0025).
        for text in [
            r#""\ud800""#,
            r#""\udc00""#,
            r#"{"a":"\ud800"}"#,
            r#"{"a":"x\ud800y"}"#,
            r#"{"a":"\ud800A"}"#,
            r#"{"\ud800":1}"#,
            r#"{"a":"\ud800\ud800"}"#,
        ] {
            assert_eq!(check(text, None), Err(StrictError::LoneSurrogate), "{text}");
        }
        assert_eq!(check(r#""😀""#, None), Ok(()));
        assert_eq!(check(r#""\\ud800""#, None), Ok(()));
    }

    #[test]
    fn object_names_do_not_allocate_a_tree() {
        // A wide object is bounded by maxJsonValues like every other value; the check stops at
        // the first over the limit without materializing the members.
        let members = |count: usize| {
            let mut text = String::from("{");
            for index in 0..count {
                if index > 0 {
                    text.push(',');
                }
                let _ = write!(text, r#""k{index}":1"#);
            }
            text.push('}');
            text
        };
        assert_eq!(check(&members(10), Some(1 + 2 * 10)), Ok(()));
        assert_eq!(
            check(&members(10), Some(2 * 10)),
            Err(StrictError::TooManyValues)
        );
    }
}
