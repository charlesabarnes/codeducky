//! github.com repositories and pull requests from remote URLs and pasted links. GitHub
//! Enterprise hosts are not recognised: the old app only spoke to github.com.

use std::fmt;
use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
}

impl RepoRef {
    pub fn new(owner: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            owner: owner.into(),
            name: name.into(),
        }
    }
}

impl fmt::Display for RepoRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.owner, self.name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PullRef {
    pub repo: RepoRef,
    pub number: u64,
}

impl PullRef {
    pub fn html_url(&self) -> String {
        format!("https://github.com/{}/pull/{}", self.repo, self.number)
    }
}

static GITHUB_REMOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:https?://(?:[^@/]+@)?github\.com/|ssh://git@github\.com(?::\d+)?/|git@github\.com:)([^/]+)/([^/]+?)(?:\.git)?/?$",
    )
    .expect("static pattern")
});

static SEGMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+$").expect("static pattern"));
static SHORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\d+)$").expect("static pattern")
});
static BARE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#?(\d+)$").expect("static pattern"));
static PULL_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/([^/]+)/([^/]+)/pull/(\d+)(?:/(?:files|commits|checks|changes)(?:/.*)?)?/?$")
        .expect("static pattern")
});
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").expect("static pattern"));

/// The repository a github.com remote URL points at (https, ssh, scp-style; `.git` optional).
pub fn parse_github_remote(url: &str) -> Option<RepoRef> {
    let captures = GITHUB_REMOTE.captures(url.trim())?;
    Some(RepoRef::new(&captures[1], &captures[2]))
}

fn valid(owner: &str, name: &str, number: &str) -> Option<PullRef> {
    let number = number.parse::<u64>().ok().filter(|n| *n > 0)?;
    (SEGMENT.is_match(owner) && SEGMENT.is_match(name)).then(|| PullRef {
        repo: RepoRef::new(owner, name),
        number,
    })
}

/// A pull request from a github.com path: `/owner/name/pull/123`, optionally `/files`, ...
pub fn match_pull_path(path: &str) -> Option<PullRef> {
    let captures = PULL_PATH.captures(path)?;
    valid(&captures[1], &captures[2], &captures[3])
}

/// What someone pasted to open a pull request: a GitHub URL (scheme optional), `owner/name#123`,
/// or `#123` / `123` for the repository in `context`.
pub fn parse_pull_reference(input: &str, context: Option<&RepoRef>) -> Option<PullRef> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }
    if let Some(short) = SHORT.captures(text) {
        return valid(&short[1], &short[2], &short[3]);
    }
    if let Some(bare) = BARE.captures(text) {
        return context.and_then(|repo| valid(&repo.owner, &repo.name, &bare[1]));
    }
    let rest = SCHEME
        .find(text)
        .map_or(text, |scheme| &text[scheme.end()..]);
    let path = &rest[rest.find('/')?..];
    let path = path.split(['?', '#']).next().unwrap_or_default();
    match_pull_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pull(owner: &str, name: &str, number: u64) -> Option<PullRef> {
        Some(PullRef {
            repo: RepoRef::new(owner, name),
            number,
        })
    }

    #[test]
    fn parses_github_remotes() {
        for url in [
            "git@github.com:acme/widgets.git",
            "git@github.com:acme/widgets",
            "https://github.com/acme/widgets.git",
            "https://token@github.com/acme/widgets",
            "ssh://git@github.com/acme/widgets.git",
            "ssh://git@github.com:22/acme/widgets",
            "https://github.com/acme/widgets/",
            "  https://github.com/acme/widgets\n",
        ] {
            assert_eq!(
                parse_github_remote(url),
                Some(RepoRef::new("acme", "widgets")),
                "{url}"
            );
        }
    }

    #[test]
    fn keeps_dots_inside_repository_names() {
        assert_eq!(
            parse_github_remote("git@github.com:acme/site.github.io.git"),
            Some(RepoRef::new("acme", "site.github.io"))
        );
    }

    #[test]
    fn rejects_other_remotes() {
        assert_eq!(parse_github_remote("git@gitlab.com:acme/widgets.git"), None);
        assert_eq!(
            parse_github_remote("https://github.example.com/acme/w.git"),
            None
        );
        assert_eq!(parse_github_remote("/tmp/local/repo"), None);
    }

    #[test]
    fn matches_pull_paths() {
        let r = pull("charlesabarnes", "codeducky", 12);
        assert_eq!(match_pull_path("/charlesabarnes/codeducky/pull/12"), r);
        assert_eq!(
            match_pull_path("/charlesabarnes/codeducky/pull/12/files"),
            r
        );
        assert_eq!(
            match_pull_path("/charlesabarnes/codeducky/pull/12/commits/0a1b2c"),
            r
        );
        assert_eq!(
            match_pull_path("/my.org/repo_name-2/pull/7"),
            pull("my.org", "repo_name-2", 7)
        );
        for path in [
            "/charlesabarnes/codeducky",
            "/charlesabarnes/codeducky/issues/12",
            "/a/b/pull/12/blame",
            "/a%2Fx/b/pull/1",
            "/a/b/pull/0",
        ] {
            assert_eq!(match_pull_path(path), None, "{path}");
        }
    }

    #[test]
    fn reads_pasted_references() {
        let r = pull("charlesabarnes", "codeducky", 12);
        let here = RepoRef::new("charlesabarnes", "codeducky");
        assert_eq!(
            parse_pull_reference("https://github.com/charlesabarnes/codeducky/pull/12", None),
            r
        );
        assert_eq!(
            parse_pull_reference(
                "  https://github.com/charlesabarnes/codeducky/pull/12/files#diff-abc  ",
                None
            ),
            r
        );
        assert_eq!(
            parse_pull_reference("github.com/charlesabarnes/codeducky/pull/12?w=1", None),
            r
        );
        assert_eq!(parse_pull_reference("charlesabarnes/codeducky#12", None), r);
        assert_eq!(parse_pull_reference("#12", Some(&here)), r);
        assert_eq!(parse_pull_reference("12", Some(&here)), r);
        assert_eq!(parse_pull_reference("#12", None), None);
        for input in [
            "",
            "   ",
            "codeducky#12",
            "https://github.com/charlesabarnes/codeducky/issues/12",
            "not a url",
            "a/b#0",
            "a/b#x",
        ] {
            assert_eq!(parse_pull_reference(input, Some(&here)), None, "{input}");
        }
        assert_eq!(
            r.unwrap().html_url(),
            "https://github.com/charlesabarnes/codeducky/pull/12"
        );
    }
}
