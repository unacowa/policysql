//! `Date.prototype.toISOString` for the public `expiresAt` (the machine reads no clock; it
//! formats the injected time).

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for milliseconds since the Unix epoch, for years 1970-9999
/// (the host facts bound `now_ms` well inside that range).
#[must_use]
pub fn iso_from_ms(ms: u64) -> String {
    let millis = ms % 1000;
    let seconds = ms / 1000;
    let (second, minute, hour) = (seconds % 60, (seconds / 60) % 60, (seconds / 3600) % 24);
    let days = seconds / 86_400;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
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
    use super::iso_from_ms;

    #[test]
    fn formats_like_to_iso_string() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_793_366_096_789), "2026-10-30T13:14:56.789Z");
        assert_eq!(iso_from_ms(253_402_300_799_999), "9999-12-31T23:59:59.999Z");
    }
}
