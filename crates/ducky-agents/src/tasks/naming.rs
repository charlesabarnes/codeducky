//! Terminal names: unique among live terminals, 1-32 of `a-z 0-9 - _ .`.

const MAX: usize = 32;

pub fn sanitize(wanted: &str) -> String {
    let mut name = String::new();
    for c in wanted.trim().to_lowercase().chars() {
        let c = if c.is_ascii_alphanumeric() || matches!(c, '_' | '.') {
            c
        } else {
            '-'
        };
        if !(c == '-' && (name.is_empty() || name.ends_with('-'))) {
            name.push(c);
        }
    }
    let name: String = name.trim_end_matches('-').chars().take(MAX).collect();
    if name.is_empty() {
        "agent".into()
    } else {
        name
    }
}

/// `wanted`, sanitized, or with `-2`, `-3`, ... when a live terminal has it already.
pub fn unique(wanted: &str, taken: &[String]) -> String {
    let base = sanitize(wanted);
    if !taken.contains(&base) {
        return base;
    }
    (2..)
        .map(|n| {
            let suffix = format!("-{n}");
            let stem: String = base.chars().take(MAX - suffix.len()).collect();
            format!("{}{suffix}", stem.trim_end_matches('-'))
        })
        .find(|name| !taken.contains(name))
        .expect("an unused name")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_hc_rules() {
        assert_eq!(
            sanitize("Fix notes: feature/Login!"),
            "fix-notes-feature-login"
        );
        assert_eq!(sanitize("  "), "agent");
        assert_eq!(sanitize("a.b_c"), "a.b_c");
        assert_eq!(sanitize(&"x".repeat(40)).len(), 32);
    }

    #[test]
    fn taken_names_get_a_number() {
        let taken = vec!["duck".to_owned(), "duck-2".to_owned()];
        assert_eq!(unique("Duck", &taken), "duck-3");
        assert_eq!(unique("other", &taken), "other");
        let long = "y".repeat(32);
        assert_eq!(unique(&long, std::slice::from_ref(&long)).len(), 32);
    }
}
