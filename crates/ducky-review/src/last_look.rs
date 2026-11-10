use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::change::{ChangeStatus, FileChange};
use crate::ids::Oid;
use crate::time::Timestamp;
use crate::viewed::FileView;

/// Your last look at one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastLook {
    pub path: String,
    /// `None` when the file did not exist when you looked.
    pub oid: Option<Oid>,
    pub head: Option<String>,
    pub at: Timestamp,
}

/// The head commit when a file was last marked viewed or a review was submitted: "since last
/// look" starts here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastReview {
    pub head: String,
    pub at: Timestamp,
}

/// The latest look per path across the given views (one review, or several of the same branch).
pub fn last_looks<'a>(
    views: impl IntoIterator<Item = (&'a str, &'a FileView)>,
) -> HashMap<String, LastLook> {
    let mut looks: HashMap<String, LastLook> = HashMap::new();
    for (path, view) in views {
        let Some(look) = &view.reviewed else {
            continue;
        };
        if looks.get(path).is_some_and(|current| current.at >= look.at) {
            continue;
        }
        looks.insert(
            path.to_owned(),
            LastLook {
                path: path.to_owned(),
                oid: look.oid.clone(),
                head: look.head.clone(),
                at: look.at,
            },
        );
    }
    looks
}

pub fn latest_review<'a>(
    reviews: impl IntoIterator<Item = Option<&'a LastReview>>,
) -> Option<&'a LastReview> {
    reviews
        .into_iter()
        .flatten()
        .fold(None, |latest: Option<&LastReview>, review| match latest {
            Some(latest) if latest.at >= review.at => Some(latest),
            _ => Some(review),
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinceKind {
    /// Never viewed: the full diff, badged "new since last look".
    New,
    /// The interdiff from the reviewed content to the current content.
    Changed,
    /// Identical to what you reviewed; hidden behind a count.
    Unchanged,
    /// Changed, but the reviewed content is not available here: the full diff with a notice.
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SinceEntry {
    pub kind: SinceKind,
    /// What the diff shows: the interdiff for `Changed`, otherwise the file's own change.
    pub change: FileChange,
    /// The file's change against the base.
    pub original: FileChange,
    pub look: Option<LastLook>,
}

pub fn interdiff(change: &FileChange, reviewed: Option<&Oid>) -> FileChange {
    let status = match (reviewed, &change.new_oid) {
        (_, None) => ChangeStatus::Deleted,
        (None, _) => ChangeStatus::Added,
        _ => ChangeStatus::Modified,
    };
    FileChange {
        path: change.path.clone(),
        status,
        old_oid: reviewed.cloned(),
        new_oid: change.new_oid.clone(),
        old_path: None,
    }
}

/// Sorts the review's files by what changed since you last looked at each one. `available` says
/// whether the reviewed content can still be read (a git object, or a GitHub blob).
pub fn classify_since(
    files: &[FileChange],
    looks: &HashMap<String, LastLook>,
    available: impl Fn(&Oid) -> bool,
) -> Vec<SinceEntry> {
    files
        .iter()
        .map(|file| {
            let look = looks.get(&file.path).cloned();
            let (kind, change) = match &look {
                None => (SinceKind::New, file.clone()),
                Some(look) if look.oid == file.new_oid => (SinceKind::Unchanged, file.clone()),
                Some(LastLook { oid: Some(oid), .. }) if !available(oid) => {
                    (SinceKind::Missing, file.clone())
                }
                Some(look) => (SinceKind::Changed, interdiff(file, look.oid.as_ref())),
            };
            SinceEntry {
                kind,
                change,
                original: file.clone(),
                look,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SinceCounts {
    pub changed: usize,
    pub unchanged: usize,
    pub fresh: usize,
    pub missing: usize,
}

pub fn count_since(entries: &[SinceEntry]) -> SinceCounts {
    let mut counts = SinceCounts::default();
    for entry in entries {
        match entry.kind {
            SinceKind::Changed => counts.changed += 1,
            SinceKind::Unchanged => counts.unchanged += 1,
            SinceKind::New => counts.fresh += 1,
            SinceKind::Missing => counts.missing += 1,
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::viewed::{ContentHash, Look as Reviewed};

    fn view(oid: Option<&str>, at: i64, head: Option<&str>, viewed: bool) -> FileView {
        FileView {
            viewed,
            content_hash: ContentHash("b:n".into()),
            reviewed: Some(Reviewed {
                oid: oid.map(Oid::from),
                head: head.map(str::to_owned),
                at: Timestamp(at),
            }),
        }
    }

    #[test]
    fn keeps_the_latest_look_per_path_and_skips_files_never_reviewed() {
        let views = [
            ("a.ts", view(Some("a1"), 1, Some("h1"), true)),
            ("a.ts", view(Some("a2"), 5, Some("h2"), true)),
            ("never.ts", FileView::default()),
            ("unmarked.ts", view(Some("m1"), 2, None, false)),
        ];
        let looks = last_looks(views.iter().map(|(path, view)| (*path, view)));
        assert_eq!(
            looks["a.ts"],
            LastLook {
                path: "a.ts".into(),
                oid: Some(Oid::from("a2")),
                head: Some("h2".into()),
                at: Timestamp(5)
            }
        );
        assert!(!looks.contains_key("never.ts"));
        assert_eq!(looks["unmarked.ts"].oid, Some(Oid::from("m1")));

        let x = LastReview {
            head: "x".into(),
            at: Timestamp(1),
        };
        let y = LastReview {
            head: "y".into(),
            at: Timestamp(9),
        };
        assert_eq!(latest_review([Some(&x), None, Some(&y)]), Some(&y));
        assert_eq!(latest_review([None]), None);
    }

    #[test]
    fn classifies_files_as_new_changed_unchanged_or_missing() {
        let files = [
            FileChange::new("same.ts", Some("b1"), Some("n1")),
            FileChange::new("edited.ts", Some("b2"), Some("n2")),
            FileChange::new("never.ts", Some("b3"), Some("n3")),
            FileChange::new("gone-reviewed.ts", Some("b4"), Some("n4")),
            FileChange::new("deleted-since.ts", Some("b5"), None),
            FileChange::new("was-deleted.ts", None, Some("n6")),
        ];
        let views = [
            ("same.ts", view(Some("n1"), 1, None, true)),
            ("edited.ts", view(Some("r2"), 1, None, true)),
            ("gone-reviewed.ts", view(Some("lost"), 1, None, true)),
            ("deleted-since.ts", view(Some("r5"), 1, None, true)),
            ("was-deleted.ts", view(None, 1, None, true)),
        ];
        let looks = last_looks(views.iter().map(|(path, view)| (*path, view)));
        let entries = classify_since(&files, &looks, |oid| oid.as_str() != "lost");
        let kinds: Vec<_> = entries
            .iter()
            .map(|e| (e.change.path.as_str(), e.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("same.ts", SinceKind::Unchanged),
                ("edited.ts", SinceKind::Changed),
                ("never.ts", SinceKind::New),
                ("gone-reviewed.ts", SinceKind::Missing),
                ("deleted-since.ts", SinceKind::Changed),
                ("was-deleted.ts", SinceKind::Changed),
            ]
        );
        assert_eq!(
            entries[1].change,
            FileChange::new("edited.ts", Some("r2"), Some("n2"))
        );
        assert_eq!(entries[2].change, files[2]);
        assert_eq!(
            entries[4].change,
            FileChange::new("deleted-since.ts", Some("r5"), None)
        );
        assert_eq!(
            interdiff(&files[5], None),
            FileChange::new("was-deleted.ts", None, Some("n6"))
        );
        assert_eq!(
            count_since(&entries),
            SinceCounts {
                changed: 3,
                unchanged: 1,
                fresh: 1,
                missing: 1
            }
        );
    }
}
