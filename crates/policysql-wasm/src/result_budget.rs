//! The result side of the budgets (ADR 0027 pull request 6): the raw result bound of a compiled
//! envelope and the count of raw Hrana values a result carries.
//!
//! A raw result is the database's reply as the host decoded it. Its values are counted the way
//! the CPU and memory formulas use them: every cell (visibility and check companions included),
//! every column descriptor, and every value inside a JSON-typed cell (its members' names too,
//! like the request side counts them). The count stops at the first row over the limit.

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use std::cell::Cell;
use std::fmt;

/// Counts the JSON values and object member names of `text`, stopping as soon as the count would
/// exceed `limit`. `None` when it does: the caller answers `POLICYSQL_LIMIT_EXCEEDED`. Text that
/// is not JSON counts as zero values; the value conversion rejects it right after.
pub(crate) fn count_json_values(text: &str, limit: u64) -> Option<u64> {
    let count = Cell::new(0_u64);
    let counter = Counter {
        count: &count,
        limit,
    };
    let mut deserializer = serde_json::Deserializer::from_str(text);
    match counter.deserialize(&mut deserializer) {
        Ok(()) => Some(count.get()),
        Err(_) if count.get() > limit => None,
        Err(_) => Some(0),
    }
}

#[derive(Clone, Copy)]
struct Counter<'a> {
    count: &'a Cell<u64>,
    limit: u64,
}

impl Counter<'_> {
    fn bump<E: de::Error>(self) -> Result<(), E> {
        let next = self.count.get().saturating_add(1);
        self.count.set(next);
        if next > self.limit {
            Err(E::custom("value limit"))
        } else {
            Ok(())
        }
    }
}

impl<'de> DeserializeSeed<'de> for Counter<'_> {
    type Value = ();

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Counter<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        self.bump()
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
        self.bump()
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
        self.bump()
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        self.bump()
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<(), E> {
        self.bump()
    }

    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        self.bump()
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        self.bump()?;
        while seq.next_element_seed(self)?.is_some() {}
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        self.bump()?;
        while map.next_key_seed(self)?.is_some() {
            map.next_value_seed(self)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::count_json_values;

    #[test]
    fn counts_values_and_member_names() {
        assert_eq!(count_json_values("1", 10), Some(1));
        assert_eq!(count_json_values("null", 10), Some(1));
        assert_eq!(count_json_values("\"a\"", 10), Some(1));
        assert_eq!(count_json_values("[1,2,3]", 10), Some(4));
        assert_eq!(count_json_values("{\"a\":1,\"b\":[true]}", 10), Some(6));
        assert_eq!(count_json_values("[]", 10), Some(1));
        assert_eq!(count_json_values("{}", 10), Some(1));
    }

    #[test]
    fn stops_at_the_first_value_over_the_limit() {
        assert_eq!(count_json_values("[1,2,3]", 4), Some(4));
        assert_eq!(count_json_values("[1,2,3]", 3), None);
        // A document that would be far over the limit is refused without reading the rest.
        let long = format!("[{}]", "0,".repeat(100_000) + "0");
        assert_eq!(count_json_values(&long, 1_000), None);
    }

    #[test]
    fn text_that_is_not_json_counts_nothing() {
        assert_eq!(count_json_values("not json", 10), Some(0));
        assert_eq!(count_json_values("[1,", 10), Some(0));
    }
}
