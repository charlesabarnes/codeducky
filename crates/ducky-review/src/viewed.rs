use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::change::FileChange;
use crate::ids::Oid;
use crate::time::Timestamp;

/// Both sides' blob ids, `old:new` with `0` for an absent side: a viewed mark holds while it matches.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ContentHash(pub String);

impl ContentHash {
    pub fn of(change: &FileChange) -> Self {
        let side = |oid: &Option<Oid>| oid.as_ref().map_or("0", Oid::as_str).to_owned();
        Self(format!(
            "{}:{}",
            side(&change.old_oid),
            side(&change.new_oid)
        ))
    }
}

/// What you last reviewed of a file: its content's blob id (`None` when the file did not
/// exist), the head commit then, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Look {
    pub oid: Option<Oid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub at: Timestamp,
}

/// One file's viewed mark in a review.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileView {
    #[serde(default)]
    pub viewed: bool,
    #[serde(default)]
    pub content_hash: ContentHash,
    /// Kept when the file is unmarked or changes, so "since last look" can diff from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed: Option<Look>,
}

pub fn is_viewed(view: Option<&FileView>, hash: &ContentHash) -> bool {
    view.is_some_and(|view| view.viewed && view.content_hash == *hash)
}

pub fn viewed_paths(files: &[FileChange], views: &BTreeMap<String, FileView>) -> HashSet<String> {
    files
        .iter()
        .filter(|file| is_viewed(views.get(&file.path), &ContentHash::of(file)))
        .map(|file| file.path.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, new_oid: Option<&str>) -> FileChange {
        FileChange::new(path, Some("base"), new_oid)
    }

    fn view(change: &FileChange) -> FileView {
        FileView {
            viewed: true,
            content_hash: ContentHash::of(change),
            reviewed: None,
        }
    }

    #[test]
    fn is_viewed_only_while_the_content_hash_matches() {
        let marked = view(&change("a", Some("v1")));
        let v1 = ContentHash::of(&change("a", Some("v1")));
        assert!(is_viewed(Some(&marked), &v1));
        assert!(!is_viewed(
            Some(&marked),
            &ContentHash::of(&change("a", Some("v2")))
        ));
        let unmarked = FileView {
            viewed: false,
            ..marked.clone()
        };
        assert!(!is_viewed(Some(&unmarked), &v1));
        assert!(!is_viewed(None, &v1));
        assert_eq!(ContentHash::of(&change("c", None)).0, "base:0");
    }

    #[test]
    fn collects_viewed_paths_for_the_current_files() {
        let files = [
            change("a", Some("v1")),
            change("b", Some("v2")),
            change("c", None),
        ];
        let views = BTreeMap::from([
            ("a".to_owned(), view(&files[0])),
            ("b".to_owned(), view(&change("b", Some("old")))),
            ("c".to_owned(), view(&files[2])),
        ]);
        let mut paths: Vec<_> = viewed_paths(&files, &views).into_iter().collect();
        paths.sort();
        assert_eq!(paths, ["a", "c"]);
    }
}
