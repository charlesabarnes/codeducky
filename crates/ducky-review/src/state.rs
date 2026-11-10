use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::change::FileChange;
use crate::ids::ChecklistItemId;
use crate::last_look::{LastLook, LastReview, last_looks};
use crate::time::Timestamp;
use crate::viewed::{ContentHash, FileView, Look, is_viewed};

/// Everything about one review except its notes: viewed marks, the last look, ticked checklist items.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_review: Option<LastReview>,
    /// Keyed by path.
    #[serde(default)]
    pub files: BTreeMap<String, FileView>,
    #[serde(default)]
    pub checked: BTreeSet<ChecklistItemId>,
}

impl ReviewState {
    pub fn is_viewed(&self, change: &FileChange) -> bool {
        is_viewed(self.files.get(&change.path), &ContentHash::of(change))
    }

    /// Marks a file viewed or not. Marking it records the reviewed blob id; unmarking keeps the
    /// last reviewed one, since that look still happened. `head` is the head commit when known
    /// now (pull requests); a local review records it later with `record_review_head`.
    pub fn mark_viewed(
        &mut self,
        change: &FileChange,
        viewed: bool,
        head: Option<&str>,
        now: Timestamp,
    ) {
        let previous = self
            .files
            .remove(&change.path)
            .and_then(|view| view.reviewed);
        let reviewed = if viewed {
            Some(Look {
                oid: change.new_oid.clone(),
                head: head.map(str::to_owned),
                at: now,
            })
        } else {
            previous
        };
        self.files.insert(
            change.path.clone(),
            FileView {
                viewed,
                content_hash: ContentHash::of(change),
                reviewed,
            },
        );
        if viewed && let Some(head) = head {
            self.record_head(head, now);
        }
    }

    /// Records the head a local review happened at, once the git layer has read it.
    pub fn record_review_head(&mut self, path: &str, head: &str, now: Timestamp) {
        if let Some(look) = self
            .files
            .get_mut(path)
            .and_then(|view| view.reviewed.as_mut())
        {
            look.head = Some(head.to_owned());
        }
        self.record_head(head, now);
    }

    /// A submitted review covers every file at that head: each is recorded as reviewed, keeping
    /// its viewed mark where the content still matches.
    pub fn record_reviewed_files(&mut self, head: &str, files: &[FileChange], now: Timestamp) {
        for change in files {
            let hash = ContentHash::of(change);
            let viewed = is_viewed(self.files.get(&change.path), &hash);
            self.files.insert(
                change.path.clone(),
                FileView {
                    viewed,
                    content_hash: hash,
                    reviewed: Some(Look {
                        oid: change.new_oid.clone(),
                        head: Some(head.to_owned()),
                        at: now,
                    }),
                },
            );
        }
        self.record_head(head, now);
    }

    fn record_head(&mut self, head: &str, now: Timestamp) {
        self.last_review = Some(LastReview {
            head: head.to_owned(),
            at: now,
        });
    }

    pub fn last_looks(&self) -> HashMap<String, LastLook> {
        last_looks(self.files.iter().map(|(path, view)| (path.as_str(), view)))
    }

    pub fn set_checked(&mut self, item: ChecklistItemId, checked: bool) {
        if checked {
            self.checked.insert(item);
        } else {
            self.checked.remove(&item);
        }
    }

    pub fn is_checked(&self, item: &ChecklistItemId) -> bool {
        self.checked.contains(item)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Oid;

    fn change(path: &str, old: Option<&str>, new: &str) -> FileChange {
        FileChange::new(path, old, Some(new))
    }

    #[test]
    fn records_the_reviewed_oid_on_view_and_keeps_it_when_unmarked() {
        let mut state = ReviewState::default();
        state.mark_viewed(&change("a.ts", Some("b"), "n1"), true, None, Timestamp(10));
        state.record_review_head("a.ts", "h1", Timestamp(11));
        let view = &state.files["a.ts"];
        assert!(view.viewed);
        assert_eq!(view.content_hash, ContentHash("b:n1".into()));
        assert_eq!(
            view.reviewed,
            Some(Look {
                oid: Some(Oid::from("n1")),
                head: Some("h1".into()),
                at: Timestamp(10)
            })
        );
        assert_eq!(
            state.last_review,
            Some(LastReview {
                head: "h1".into(),
                at: Timestamp(11)
            })
        );

        state.mark_viewed(&change("a.ts", Some("b"), "n2"), false, None, Timestamp(20));
        let view = &state.files["a.ts"];
        assert!(!view.viewed);
        assert_eq!(view.content_hash, ContentHash("b:n2".into()));
        let look = view.reviewed.as_ref().unwrap();
        assert_eq!(
            (look.oid.as_ref().unwrap().as_str(), look.at),
            ("n1", Timestamp(10))
        );
    }

    #[test]
    fn records_a_pull_request_head_straight_away_and_every_file_at_submit() {
        let mut state = ReviewState::default();
        state.mark_viewed(
            &change("a.ts", Some("b"), "n1"),
            true,
            Some("pr1"),
            Timestamp(5),
        );
        assert_eq!(state.last_review.as_ref().unwrap().head, "pr1");

        let files = [change("a.ts", Some("b"), "n1"), change("b.ts", None, "x1")];
        state.record_reviewed_files("pr2", &files, Timestamp(9));
        let a = &state.files["a.ts"];
        assert!(a.viewed);
        assert_eq!(a.reviewed.as_ref().unwrap().head.as_deref(), Some("pr2"));
        let b = &state.files["b.ts"];
        assert!(!b.viewed);
        assert_eq!(b.reviewed.as_ref().unwrap().oid, Some(Oid::from("x1")));
        assert_eq!(
            state.last_review,
            Some(LastReview {
                head: "pr2".into(),
                at: Timestamp(9)
            })
        );
        assert_eq!(state.last_looks()["b.ts"].head.as_deref(), Some("pr2"));
    }

    #[test]
    fn ticks_and_unticks_checklist_items() {
        let mut state = ReviewState::default();
        let item = ChecklistItemId::from("i1");
        state.set_checked(item.clone(), true);
        assert!(state.is_checked(&item));
        state.set_checked(item.clone(), false);
        assert!(!state.is_checked(&item));
    }
}
