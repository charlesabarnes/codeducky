//! Short ages for GitHub timestamps.

use ducky_review::Timestamp;

/// `3d`, `5h`, `12m`, `now`; empty when the time does not parse.
pub fn short_age(iso: &str, now: Timestamp) -> String {
    iso.parse::<Timestamp>()
        .map(|at| age(at, now))
        .unwrap_or_default()
}

pub fn age(at: Timestamp, now: Timestamp) -> String {
    let minutes = (now.millis() - at.millis()).max(0) / 60_000;
    match minutes {
        0 => "now".into(),
        1..60 => format!("{minutes}m"),
        60..1440 => format!("{}h", minutes / 60),
        _ => format!("{}d", minutes / 1440),
    }
}

/// `3d ago`, or `just now`.
pub fn ago(iso: &str, now: Timestamp) -> String {
    match short_age(iso, now).as_str() {
        "" => String::new(),
        "now" => "just now".into(),
        age => format!("{age} ago"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_down_to_the_largest_unit() {
        let now = Timestamp::utc(2026, 11, 10, 12, 0);
        assert_eq!(short_age("2026-11-10T11:59:30Z", now), "now");
        assert_eq!(short_age("2026-11-10T11:15:00Z", now), "45m");
        assert_eq!(short_age("2026-11-10T07:00:00Z", now), "5h");
        assert_eq!(ago("2026-11-07T12:00:00Z", now), "3d ago");
        assert_eq!(short_age("garbage", now), "");
    }
}
