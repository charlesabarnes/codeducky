use std::sync::LazyLock;

use regex::Regex;

use crate::remote::RepoRef;

static NEXT_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<([^>]+)>;\s*rel="next""#).expect("static pattern"));

/// Percent-encodes everything but RFC 3986's unreserved characters.
pub(crate) fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A path such as a branch name, encoded segment by segment so its slashes stay.
pub(crate) fn encode_path(path: &str) -> String {
    path.split('/').map(encode).collect::<Vec<_>>().join("/")
}

pub(crate) fn repo_path(repo: &RepoRef) -> String {
    format!("/repos/{}/{}", encode(&repo.owner), encode(&repo.name))
}

pub(crate) fn with_query(url: &str, query: &[(&str, String)]) -> String {
    if query.is_empty() {
        return url.to_owned();
    }
    let pairs = query
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let joiner = if url.contains('?') { '&' } else { '?' };
    format!("{url}{joiner}{pairs}")
}

/// `scheme://host[:port]` of a URL.
pub(crate) fn origin(url: &str) -> &str {
    let after_scheme = url.find("://").map_or(0, |i| i + 3);
    url[after_scheme..]
        .find('/')
        .map_or(url, |i| &url[..after_scheme + i])
}

/// The `rel="next"` URL of a `Link` header.
pub(crate) fn next_link(link: &str) -> Option<String> {
    link.split(',')
        .find_map(|part| NEXT_LINK.captures(part).map(|c| c[1].to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_components_and_paths() {
        assert_eq!(encode("acme:feat/x y"), "acme%3Afeat%2Fx%20y");
        assert_eq!(encode_path("feat/ü"), "feat/%C3%BC");
        assert_eq!(
            with_query("/a?x=1", &[("head", "o:b".into())]),
            "/a?x=1&head=o%3Ab"
        );
    }

    #[test]
    fn finds_the_origin() {
        assert_eq!(
            origin("https://api.github.com/repos/x"),
            "https://api.github.com"
        );
        assert_eq!(origin("http://127.0.0.1:4000"), "http://127.0.0.1:4000");
    }

    #[test]
    fn reads_the_next_link() {
        let link = r#"<https://api.github.com/repositories/1/pulls/48/files?per_page=10&page=2>; rel="next", <https://api.github.com/repositories/1/pulls/48/files?per_page=10&page=2>; rel="last""#;
        assert_eq!(
            next_link(link).as_deref(),
            Some("https://api.github.com/repositories/1/pulls/48/files?per_page=10&page=2")
        );
        assert_eq!(next_link(r#"<https://x/a?page=1>; rel="prev""#), None);
    }
}
