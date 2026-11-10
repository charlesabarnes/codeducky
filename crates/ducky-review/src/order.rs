use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::change::{ChangeStatus, FileChange, FileStats};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum FileOrder {
    /// Directory order, each test right after the file it tests.
    #[default]
    Folders,
    /// Highest review risk first.
    Risk,
}

const TEST_DIRS: [&str; 6] = ["test", "tests", "__tests__", "spec", "specs", "__specs__"];
/// Directory names that differ between a source tree and its test mirror.
const MIRROR_DIRS: [&str; 7] = ["src", "main", "lib", "java", "kotlin", "scala", "app"];

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

static TEST_NAMES: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    [
        regex(r"(?i)^(.+)\.(?:test|spec|tests|specs)\.[^/]+$"),
        regex(r"^(.+?)(?:Tests?|Spec|IT)\.(?:kt|kts|java|scala|groovy|cs|swift)$"),
        regex(r"^(.+)_test\.(?:go|py|rb|exs?|dart|rs)$"),
        regex(r"^test_(.+)\.py$"),
    ]
});

const WORD: &str = "[A-Za-z0-9_]";

static SENSITIVE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?i)(^|[/._-])(auth{WORD}*|oauth|login|session|passwords?|secrets?|tokens?|crypto|security|permissions?|acl|rbac|csrf|sanitiz{WORD}*|migrations?|migrate)([/._-]|$)"
    ))
});

static CONFIG: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"(?i)(^|/)(\.env[^/]*|[^/]*config[^/]*|settings\.[^/]+|dockerfile|[^/]*compose\.ya?ml|\.github/workflows/[^/]+|[^/]*\.tf|nginx\.conf|caddyfile)$",
    )
});

const LOCKFILES: [&str; 18] = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "cargo.lock",
    "gemfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
    "flake.lock",
    "gradle.lockfile",
    "podfile.lock",
    "mix.lock",
    "pubspec.lock",
];

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn dirs(path: &str) -> impl DoubleEndedIterator<Item = &str> {
    let mut parts: Vec<&str> = path.split('/').collect();
    parts.pop();
    parts.into_iter()
}

/// The name up to its first dot, ignoring a leading one.
fn strip_extension(name: &str) -> &str {
    match name.get(1..).and_then(|rest| rest.find('.')) {
        Some(dot) => &name[..dot + 1],
        None => name,
    }
}

/// For a test file, the stem of the file it tests (`hunks` for `hunks.test.ts`); `None` when it
/// is not a test.
pub fn test_subject(path: &str) -> Option<String> {
    let name = basename(path);
    for pattern in TEST_NAMES.iter() {
        if let Some(subject) = pattern.captures(name).and_then(|found| found.get(1)) {
            return Some(strip_extension(subject.as_str()).to_lowercase());
        }
    }
    dirs(path)
        .any(|dir| TEST_DIRS.contains(&dir.to_lowercase().as_str()))
        .then(|| strip_extension(name).to_lowercase())
}

pub fn is_test_path(path: &str) -> bool {
    test_subject(path).is_some()
}

pub fn is_lockfile(path: &str) -> bool {
    LOCKFILES.contains(&basename(path).to_lowercase().as_str())
}

/// Directories without the test/source mirror names, innermost first.
fn mirror_dirs(path: &str) -> Vec<&str> {
    dirs(path)
        .filter(|dir| {
            let dir = dir.to_lowercase();
            !TEST_DIRS.contains(&dir.as_str()) && !MIRROR_DIRS.contains(&dir.as_str())
        })
        .rev()
        .collect()
}

fn affinity(test: &str, source: &str) -> f64 {
    let (a, b) = (mirror_dirs(test), mirror_dirs(source));
    let shared = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    shared as f64 * 2.0 - a.len().abs_diff(b.len()) as f64 * 0.1
}

/// Maps each test path to the changed source file it most likely tests.
pub fn pair_tests<'a>(paths: impl IntoIterator<Item = &'a str> + Clone) -> HashMap<String, String> {
    let mut sources: HashMap<String, Vec<&str>> = HashMap::new();
    for path in paths.clone() {
        if !is_test_path(path) {
            let stem = strip_extension(basename(path)).to_lowercase();
            sources.entry(stem).or_default().push(path);
        }
    }
    let mut pairs = HashMap::new();
    for path in paths {
        let Some(candidates) = test_subject(path).and_then(|subject| sources.get(&subject)) else {
            continue;
        };
        let mut best = candidates[0];
        for candidate in candidates {
            if affinity(path, candidate) > affinity(path, best) {
                best = candidate;
            }
        }
        pairs.insert(path.to_owned(), best.to_owned());
    }
    pairs
}

/// File-tree order: compared segment by segment, folders before files at each level.
pub fn compare_paths(a: &str, b: &str) -> Ordering {
    let left: Vec<&str> = a.split('/').collect();
    let right: Vec<&str> = b.split('/').collect();
    for (i, (l, r)) in left.iter().zip(&right).enumerate() {
        if l == r {
            continue;
        }
        let left_is_file = i == left.len() - 1;
        let right_is_file = i == right.len() - 1;
        if left_is_file != right_is_file {
            return if left_is_file {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }
        return l.cmp(r);
    }
    left.len().cmp(&right.len())
}

/// Directory order, with each test right after the source file it tests.
pub fn folder_order<T: AsRef<FileChange>>(files: &[T]) -> Vec<&T> {
    let subjects = pair_tests(files.iter().map(|file| file.as_ref().path.as_str()));
    let key = |file: &T| {
        let path = &file.as_ref().path;
        subjects
            .get(path)
            .map_or(path.as_str(), String::as_str)
            .to_owned()
    };
    let mut ordered: Vec<&T> = files.iter().collect();
    ordered.sort_by(|a, b| {
        let (a_path, b_path) = (&a.as_ref().path, &b.as_ref().path);
        compare_paths(&key(a), &key(b))
            .then_with(|| {
                subjects
                    .contains_key(a_path)
                    .cmp(&subjects.contains_key(b_path))
            })
            .then_with(|| compare_paths(a_path, b_path))
    });
    ordered
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RiskInput {
    pub stats: Option<FileStats>,
    pub open_notes: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Risk {
    pub score: f64,
    pub reasons: Vec<String>,
}

/// A rough review-risk score; higher reads first. Lockfiles always score lowest.
pub fn risk_of(change: &FileChange, input: RiskInput) -> Risk {
    if is_lockfile(&change.path) {
        return Risk {
            score: -1.0,
            reasons: vec!["lockfile".into()],
        };
    }
    let mut reasons = Vec::new();
    let lines = input.stats.map_or(0, FileStats::changed_lines);
    let mut score = f64::from(lines).ln_1p() / std::f64::consts::LN_2;
    if lines >= 100 {
        reasons.push(format!("{lines} lines changed"));
    }
    if change.status == ChangeStatus::Added {
        score += 2.0;
        reasons.push("new file".into());
    }
    let paths: Vec<&str> = std::iter::once(change.path.as_str())
        .chain(change.old_path.as_deref())
        .collect();
    if paths.iter().any(|path| SENSITIVE.is_match(path)) {
        score += 6.0;
        reasons.push("sensitive path".into());
    } else if paths.iter().any(|path| CONFIG.is_match(path)) {
        score += 3.0;
        reasons.push("configuration".into());
    }
    if change.status == ChangeStatus::Deleted && is_test_path(&change.path) {
        score += 5.0;
        reasons.push("deleted test".into());
    }
    if input.open_notes > 0 {
        score += input.open_notes.min(3) as f64 * 3.0;
        let noun = if input.open_notes == 1 {
            "note"
        } else {
            "notes"
        };
        reasons.push(format!("{} open {noun}", input.open_notes));
    }
    Risk { score, reasons }
}

/// Highest risk first; ties keep directory order.
pub fn risk_order<T: AsRef<FileChange>>(files: &[T], input: impl Fn(&T) -> RiskInput) -> Vec<&T> {
    let mut scored: Vec<(f64, &T)> = folder_order(files)
        .into_iter()
        .map(|file| (risk_of(file.as_ref(), input(file)).score, file))
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.into_iter().map(|(_, file)| file).collect()
}

pub fn order_files<T: AsRef<FileChange>>(
    files: &[T],
    order: FileOrder,
    input: impl Fn(&T) -> RiskInput,
) -> Vec<&T> {
    match order {
        FileOrder::Folders => folder_order(files),
        FileOrder::Risk => risk_order(files, input),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str) -> FileChange {
        FileChange::new(path, Some("a"), Some("b"))
    }

    fn paths(files: &[&FileChange]) -> Vec<String> {
        files.iter().map(|file| file.path.clone()).collect()
    }

    #[test]
    fn names_the_subject_of_a_test() {
        for (path, subject) in [
            ("src/diff/hunks.test.ts", "hunks"),
            ("src/app/Layout.spec.tsx", "layout"),
            ("src/__tests__/format.ts", "format"),
            ("test/diff/hunks.test.ts", "hunks"),
            (
                "app/src/test/java/com/acme/InvoiceServiceTest.java",
                "invoiceservice",
            ),
            ("app/src/test/kotlin/com/acme/LedgerTests.kt", "ledger"),
            ("pkg/store/store_test.go", "store"),
            ("tests/test_parser.py", "parser"),
        ] {
            assert_eq!(test_subject(path).as_deref(), Some(subject), "{path}");
        }
        for path in ["src/diff/hunks.ts", "src/Contest.java", "docs/testing.md"] {
            assert_eq!(test_subject(path), None, "{path}");
        }
    }

    #[test]
    fn matches_mirrored_test_folders_to_the_closest_source() {
        let pairs = pair_tests([
            "src/diff/hunks.ts",
            "src/review/hunks.ts",
            "test/diff/hunks.test.ts",
            "app/src/main/java/com/acme/InvoiceService.java",
            "app/src/test/java/com/acme/InvoiceServiceTest.java",
            "test/orphan.test.ts",
        ]);
        assert_eq!(pairs["test/diff/hunks.test.ts"], "src/diff/hunks.ts");
        assert_eq!(
            pairs["app/src/test/java/com/acme/InvoiceServiceTest.java"],
            "app/src/main/java/com/acme/InvoiceService.java"
        );
        assert!(!pairs.contains_key("test/orphan.test.ts"));
    }

    #[test]
    fn sorts_by_folder_folders_first_with_tests_right_after_their_source() {
        let files: Vec<_> = [
            "README.md",
            "src/b.ts",
            "src/a.ts",
            "src/a.test.ts",
            "src/lib/util.ts",
            "test/b.test.ts",
            "test/lonely.test.ts",
            "src/__tests__/util.test.ts",
        ]
        .map(change)
        .into();
        assert_eq!(
            paths(&folder_order(&files)),
            [
                "src/lib/util.ts",
                "src/__tests__/util.test.ts",
                "src/a.ts",
                "src/a.test.ts",
                "src/b.ts",
                "test/b.test.ts",
                "test/lonely.test.ts",
                "README.md",
            ]
        );
    }

    #[test]
    fn compares_paths_segment_by_segment() {
        assert_eq!(compare_paths("a/b.ts", "a-b/c.ts"), Ordering::Less);
        assert_eq!(compare_paths("a/z/x.ts", "a/b.ts"), Ordering::Less);
    }

    #[test]
    fn scores_sensitive_paths_new_files_deleted_tests_and_open_notes() {
        let reasons = |change: FileChange, open_notes: usize| {
            risk_of(
                &change,
                RiskInput {
                    stats: None,
                    open_notes,
                },
            )
            .reasons
        };
        assert!(reasons(change("src/auth/session.ts"), 0).contains(&"sensitive path".into()));
        assert!(
            reasons(change("db/migrations/0042_add_index.sql"), 0)
                .contains(&"sensitive path".into())
        );
        assert!(reasons(change("vite.config.ts"), 0).contains(&"configuration".into()));
        let added = change("src/new.ts").with_status(ChangeStatus::Added);
        assert!(reasons(added, 0).contains(&"new file".into()));
        let deleted = change("src/a.test.ts").with_status(ChangeStatus::Deleted);
        assert!(reasons(deleted, 0).contains(&"deleted test".into()));
        assert!(reasons(change("src/a.ts"), 2).contains(&"2 open notes".into()));
    }

    #[test]
    fn puts_lockfiles_last_and_keeps_folder_order_for_ties() {
        let files: Vec<_> = [
            "package-lock.json",
            "src/z.ts",
            "src/a.ts",
            "src/auth/login.ts",
            "src/big.ts",
        ]
        .map(change)
        .into();
        let order = risk_order(&files, |file| RiskInput {
            stats: Some(if file.path == "src/big.ts" {
                FileStats::Lines {
                    additions: 40,
                    deletions: 10,
                }
            } else {
                FileStats::Lines {
                    additions: 3,
                    deletions: 1,
                }
            }),
            open_notes: 0,
        });
        assert_eq!(
            paths(&order),
            [
                "src/auth/login.ts",
                "src/big.ts",
                "src/a.ts",
                "src/z.ts",
                "package-lock.json"
            ]
        );
        assert!(is_lockfile("web/pnpm-lock.yaml"));
    }
}
