use serde::{Deserialize, Serialize};

use crate::ids::{ChecklistId, ChecklistItemId};

/// A checklist as imported or exported: titles and item texts only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecklistDraft {
    pub title: String,
    pub items: Vec<String>,
    /// Unticked items block a push. JSON files keep it; Markdown does not.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecklistItem {
    pub id: ChecklistItemId,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checklist {
    pub id: ChecklistId,
    pub title: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    #[serde(default)]
    pub items: Vec<ChecklistItem>,
}

impl Checklist {
    /// A checklist from a draft, with ids from `next_id`.
    pub fn from_draft(draft: ChecklistDraft, mut next_id: impl FnMut() -> String) -> Self {
        Self {
            id: ChecklistId::new(next_id()),
            title: draft.title,
            required: draft.required,
            items: draft
                .items
                .into_iter()
                .map(|text| ChecklistItem {
                    id: ChecklistItemId::new(next_id()),
                    text,
                })
                .collect(),
        }
    }

    pub fn to_draft(&self) -> ChecklistDraft {
        ChecklistDraft {
            title: self.title.clone(),
            items: self.items.iter().map(|item| item.text.clone()).collect(),
            required: self.required,
        }
    }
}

/// Global checklists apply to every repo (app preferences); repo ones live with the repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChecklistScope {
    Global,
    Repo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopedChecklist<'a> {
    pub scope: ChecklistScope,
    pub checklist: &'a Checklist,
}

/// The checklists for a review: global ones first, each group by title.
pub fn applicable_checklists<'a>(
    global: &'a [Checklist],
    repo: &'a [Checklist],
) -> Vec<ScopedChecklist<'a>> {
    let scoped = |scope, lists: &'a [Checklist]| {
        lists
            .iter()
            .map(move |checklist| ScopedChecklist { scope, checklist })
    };
    let mut all: Vec<_> = scoped(ChecklistScope::Global, global)
        .chain(scoped(ChecklistScope::Repo, repo))
        .collect();
    all.sort_by(|a, b| {
        a.scope.cmp(&b.scope).then_with(|| {
            let (x, y) = (&a.checklist.title, &b.checklist.title);
            x.to_lowercase()
                .cmp(&y.to_lowercase())
                .then_with(|| x.cmp(y))
        })
    });
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(title: &str) -> Checklist {
        let mut n = 0;
        Checklist::from_draft(
            ChecklistDraft {
                title: title.into(),
                items: vec!["a".into()],
                required: false,
            },
            || {
                n += 1;
                format!("{title}{n}")
            },
        )
    }

    #[test]
    fn makes_ids_for_the_list_and_each_item() {
        let checklist = list("T");
        assert_eq!(checklist.id.as_str(), "T1");
        assert_eq!(checklist.items[0].id.as_str(), "T2");
        assert_eq!(checklist.to_draft().items, ["a"]);
    }

    #[test]
    fn lists_global_checklists_first_then_by_title() {
        let global = [list("zeta"), list("Alpha")];
        let repo = [list("beta")];
        let titles: Vec<_> = applicable_checklists(&global, &repo)
            .iter()
            .map(|scoped| scoped.checklist.title.as_str())
            .collect();
        assert_eq!(titles, ["Alpha", "zeta", "beta"]);
    }
}
