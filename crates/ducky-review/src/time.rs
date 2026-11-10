use std::fmt;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Milliseconds since the Unix epoch, UTC. Written as RFC 3339 (`2026-11-10T14:05:00Z`) so people and
/// agents can read and write it; plain millisecond numbers are read too.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(pub i64);

const MS_PER_DAY: i64 = 86_400_000;

impl Timestamp {
    pub fn now() -> Self {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        Self(i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
    }

    pub fn from_millis(ms: i64) -> Self {
        Self(ms)
    }

    pub fn millis(self) -> i64 {
        self.0
    }

    pub fn utc(year: i64, month: u32, day: u32, hour: u32, minute: u32) -> Self {
        let days = days_from_civil(year, month, day);
        Self(days * MS_PER_DAY + i64::from(hour * 3600 + minute * 60) * 1000)
    }

    fn parts(self) -> Parts {
        let days = self.0.div_euclid(MS_PER_DAY);
        let rest = self.0.rem_euclid(MS_PER_DAY);
        let (year, month, day) = civil_from_days(days);
        Parts {
            year,
            month,
            day,
            hour: (rest / 3_600_000) as u32,
            minute: (rest / 60_000 % 60) as u32,
            second: (rest / 1000 % 60) as u32,
            millis: (rest % 1000) as u32,
        }
    }

    /// `2026-10-03`.
    pub fn date(self) -> String {
        let p = self.parts();
        format!("{:04}-{:02}-{:02}", p.year, p.month, p.day)
    }

    /// `2026-10-03 14:05 UTC`.
    pub fn minute_utc(self) -> String {
        let p = self.parts();
        format!("{} {:02}:{:02} UTC", self.date(), p.hour, p.minute)
    }
}

struct Parts {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    millis: u32,
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let p = self.parts();
        write!(
            f,
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            p.year, p.month, p.day, p.hour, p.minute, p.second
        )?;
        if p.millis != 0 {
            write!(f, ".{:03}", p.millis)?;
        }
        f.write_str("Z")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("`{0}` is not a timestamp like 2026-11-10T14:05:00Z")]
pub struct TimestampError(String);

impl FromStr for Timestamp {
    type Err = TimestampError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse(text.trim()).ok_or_else(|| TimestampError(text.to_owned()))
    }
}

/// RFC 3339, leniently: `T` or a space, optional seconds and fraction, `Z` or a `±HH:MM` offset.
fn parse(text: &str) -> Option<Timestamp> {
    let mut cursor = Cursor(text.as_bytes());
    let year = cursor.number(4)?;
    cursor.expect(b'-')?;
    let month = cursor.number(2)?;
    cursor.expect(b'-')?;
    let day = cursor.number(2)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month as u32, day as u32) * MS_PER_DAY;
    if cursor.is_empty() {
        return Some(Timestamp(ms));
    }
    cursor.expect_any(b"Tt ")?;
    let hour = cursor.number(2)?;
    cursor.expect(b':')?;
    let minute = cursor.number(2)?;
    let mut second = 0;
    if cursor.peek() == Some(b':') {
        cursor.expect(b':')?;
        second = cursor.number(2)?;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    ms += (hour * 3600 + minute * 60 + second) * 1000;
    if cursor.peek() == Some(b'.') {
        cursor.expect(b'.')?;
        ms += cursor.fraction_millis()?;
    }
    match cursor.next()? {
        b'Z' | b'z' => {}
        sign @ (b'+' | b'-') => {
            let hours = cursor.number(2)?;
            cursor.expect(b':')?;
            let minutes = cursor.number(2)?;
            let offset = (hours * 60 + minutes) * 60_000;
            ms += if sign == b'+' { -offset } else { offset };
        }
        _ => return None,
    }
    cursor.is_empty().then_some(Timestamp(ms))
}

struct Cursor<'a>(&'a [u8]);

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.0.first().copied()
    }

    fn next(&mut self) -> Option<u8> {
        let (first, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(*first)
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn expect(&mut self, byte: u8) -> Option<()> {
        (self.next()? == byte).then_some(())
    }

    fn expect_any(&mut self, bytes: &[u8]) -> Option<()> {
        bytes.contains(&self.next()?).then_some(())
    }

    fn number(&mut self, digits: usize) -> Option<i64> {
        let mut value = 0;
        for _ in 0..digits {
            let byte = self.next()?;
            if !byte.is_ascii_digit() {
                return None;
            }
            value = value * 10 + i64::from(byte - b'0');
        }
        Some(value)
    }

    fn fraction_millis(&mut self) -> Option<i64> {
        let mut millis = 0;
        let mut digits = 0;
        while let Some(byte) = self.peek().filter(u8::is_ascii_digit) {
            self.next();
            if digits < 3 {
                millis = millis * 10 + i64::from(byte - b'0');
            }
            digits += 1;
        }
        if digits == 0 {
            return None;
        }
        for _ in digits..3 {
            millis *= 10;
        }
        Some(millis)
    }
}

/// Howard Hinnant's `days_from_civil`: days since 1970-01-01 in the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Millis(i64),
            Text(String),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Millis(ms) => Ok(Self(ms)),
            Raw::Text(text) => text.parse().map_err(serde::de::Error::custom),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_rfc3339_utc() {
        let at = Timestamp::utc(2026, 10, 3, 14, 5);
        assert_eq!(at.to_string(), "2026-10-03T14:05:00Z");
        assert_eq!(Timestamp(at.0 + 42).to_string(), "2026-10-03T14:05:00.042Z");
        assert_eq!(at.minute_utc(), "2026-10-03 14:05 UTC");
        assert_eq!(Timestamp(0).to_string(), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn parses_what_it_writes_and_common_variants() {
        let at = Timestamp::utc(2026, 2, 28, 23, 59);
        assert_eq!(at.to_string().parse::<Timestamp>().unwrap(), at);
        assert_eq!("2026-02-28 23:59".parse::<Timestamp>().ok(), None);
        assert_eq!("2026-02-28T23:59Z".parse::<Timestamp>().unwrap(), at);
        assert_eq!(
            "2026-03-01T01:59:00+02:00".parse::<Timestamp>().unwrap(),
            at
        );
        assert_eq!(
            "2026-02-28T23:59:00.5Z".parse::<Timestamp>().unwrap(),
            Timestamp(at.0 + 500)
        );
        assert_eq!(
            "2026-02-28".parse::<Timestamp>().unwrap(),
            Timestamp::utc(2026, 2, 28, 0, 0)
        );
        assert!("yesterday".parse::<Timestamp>().is_err());
        assert!("2026-13-01T00:00:00Z".parse::<Timestamp>().is_err());
    }

    #[test]
    fn reads_strings_and_millis_from_json() {
        let parsed: Vec<Timestamp> =
            serde_json::from_str(r#"["1970-01-01T00:00:01Z", 2000]"#).unwrap();
        assert_eq!(parsed, [Timestamp(1000), Timestamp(2000)]);
        assert_eq!(
            serde_json::to_string(&Timestamp(1000)).unwrap(),
            r#""1970-01-01T00:00:01Z""#
        );
    }
}
