//! UTC calendar spellings of a compile's time (ADR 0031). Reads no clock: the time is a host fact.

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for milliseconds since the Unix epoch, `ms <= MAX_COMPILE_TIME_MS`.
#[must_use]
pub fn rfc3339_millis(ms: u64) -> String {
    let (year, month, day, hour, minute, second) = fields(ms);
    let millis = ms % 1000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// `YYYY-MM-DD HH:MM:SS` (milliseconds truncated), the form of SQLite's `CURRENT_TIMESTAMP`.
#[must_use]
pub fn sqlite_datetime(ms: u64) -> String {
    let (year, month, day, hour, minute, second) = fields(ms);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
}

const fn fields(ms: u64) -> (u64, u64, u64, u64, u64, u64) {
    let seconds = ms / 1000;
    let (second, minute, hour) = (seconds % 60, (seconds / 60) % 60, (seconds / 3600) % 24);
    let (year, month, day) = civil_from_days(seconds / 86_400);
    (year, month, day, hour, minute, second)
}

/// Howard Hinnant's `civil_from_days` for days since 1970-01-01 (non-negative only).
const fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::{rfc3339_millis, sqlite_datetime};
    use crate::{CompileContext, MAX_COMPILE_TIME_MS};

    const GOLDEN: [(u64, &str, &str); 8] = [
        (0, "1970-01-01T00:00:00.000Z", "1970-01-01 00:00:00"),
        (
            946_684_799_999,
            "1999-12-31T23:59:59.999Z",
            "1999-12-31 23:59:59",
        ),
        (
            951_782_400_000,
            "2000-02-29T00:00:00.000Z",
            "2000-02-29 00:00:00",
        ),
        (
            1_709_164_800_000,
            "2024-02-29T00:00:00.000Z",
            "2024-02-29 00:00:00",
        ),
        (
            1_793_366_096_789,
            "2026-10-30T13:14:56.789Z",
            "2026-10-30 13:14:56",
        ),
        (
            4_102_444_800_000,
            "2100-01-01T00:00:00.000Z",
            "2100-01-01 00:00:00",
        ),
        (
            4_107_542_399_999,
            "2100-02-28T23:59:59.999Z",
            "2100-02-28 23:59:59",
        ),
        (
            253_402_300_799_999,
            "9999-12-31T23:59:59.999Z",
            "9999-12-31 23:59:59",
        ),
    ];

    #[test]
    fn spellings_match_the_calendar_golden_values() {
        for (ms, rfc3339, datetime) in GOLDEN {
            assert_eq!(rfc3339_millis(ms), rfc3339);
            assert_eq!(sqlite_datetime(ms), datetime);
        }
    }

    #[test]
    fn compile_context_accepts_exactly_the_four_digit_year_range() {
        assert!(CompileContext::new(0).is_some());
        assert!(CompileContext::new(MAX_COMPILE_TIME_MS).is_some());
        assert!(CompileContext::new(MAX_COMPILE_TIME_MS + 1).is_none());
        assert_eq!(
            CompileContext::new(1_793_366_096_789).map(|context| context.now_ms()),
            Some(1_793_366_096_789)
        );
    }

    #[test]
    fn the_formatters_read_no_clock() {
        let source = include_str!("time.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .unwrap_or_else(|| unreachable!());
        for word in ["std::time", "SystemTime", "Instant"] {
            assert!(
                !production.contains(word),
                "{word} must not appear in time.rs"
            );
        }
    }
}
