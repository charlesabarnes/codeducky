use std::collections::HashSet;

use crate::changes::ChangedFile;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeEntry {
    /// `path` is the full folder path; `name` may span several folders that hold nothing else.
    Folder {
        path: String,
        name: String,
        collapsed: bool,
        files: usize,
    },
    /// `index` is into the review's files; `name` is what to show (a file name or a whole path).
    File { index: usize, name: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeRow {
    pub depth: usize,
    pub entry: TreeEntry,
}

/// All of the query's words appear in the path, ignoring case.
pub fn matches_filter(path: &str, query: &str) -> bool {
    let path = path.to_lowercase();
    query
        .split_whitespace()
        .all(|word| path.contains(&word.to_lowercase()))
}

struct Folder {
    name: String,
    path: String,
    children: Vec<Child>,
}

enum Child {
    Folder(Folder),
    File(usize, String),
}

impl Folder {
    fn new(name: &str, path: String) -> Self {
        Self {
            name: name.to_owned(),
            path,
            children: Vec::new(),
        }
    }

    fn insert(&mut self, index: usize, parts: &[&str]) {
        let [first, rest @ ..] = parts else {
            return;
        };
        if rest.is_empty() {
            self.children.push(Child::File(index, (*first).to_owned()));
            return;
        }
        let existing = self
            .children
            .iter_mut()
            .position(|child| matches!(child, Child::Folder(folder) if folder.name == *first));
        let at = existing.unwrap_or_else(|| {
            let path = if self.path.is_empty() {
                (*first).to_owned()
            } else {
                format!("{}/{first}", self.path)
            };
            self.children.push(Child::Folder(Folder::new(first, path)));
            self.children.len() - 1
        });
        if let Child::Folder(folder) = &mut self.children[at] {
            folder.insert(index, rest);
        }
    }

    /// Joins folders that hold only one folder: `src/webhooks` instead of `src` > `webhooks`.
    fn compact(mut self) -> Self {
        while let [Child::Folder(_)] = self.children[..] {
            let Some(Child::Folder(only)) = self.children.pop() else {
                unreachable!()
            };
            self.name = format!("{}/{}", self.name, only.name);
            self.path = only.path;
            self.children = only.children;
        }
        self.children = self
            .children
            .into_iter()
            .map(|child| match child {
                Child::Folder(folder) => Child::Folder(folder.compact()),
                file => file,
            })
            .collect();
        self
    }

    fn file_count(&self) -> usize {
        self.children
            .iter()
            .map(|child| match child {
                Child::Folder(folder) => folder.file_count(),
                Child::File(..) => 1,
            })
            .sum()
    }

    fn emit(&self, depth: usize, collapsed: &HashSet<String>, rows: &mut Vec<TreeRow>) {
        for child in &self.children {
            match child {
                Child::File(index, name) => rows.push(TreeRow {
                    depth,
                    entry: TreeEntry::File {
                        index: *index,
                        name: name.clone(),
                    },
                }),
                Child::Folder(folder) => {
                    let is_collapsed = collapsed.contains(&folder.path);
                    rows.push(TreeRow {
                        depth,
                        entry: TreeEntry::Folder {
                            path: folder.path.clone(),
                            name: folder.name.clone(),
                            collapsed: is_collapsed,
                            files: folder.file_count(),
                        },
                    });
                    if !is_collapsed {
                        folder.emit(depth + 1, collapsed, rows);
                    }
                }
            }
        }
    }
}

/// The rows of the file list for `order` (indexes into `files`). Nested groups files under
/// their folders; flat lists whole paths, keeping `order` exactly (for risk order).
pub fn build_tree(
    files: &[ChangedFile],
    order: &[usize],
    nested: bool,
    collapsed: &HashSet<String>,
) -> Vec<TreeRow> {
    if !nested {
        return order
            .iter()
            .map(|&index| TreeRow {
                depth: 0,
                entry: TreeEntry::File {
                    index,
                    name: files[index].path().to_owned(),
                },
            })
            .collect();
    }
    let mut root = Folder::new("", String::new());
    for &index in order {
        let parts: Vec<&str> = files[index].path().split('/').collect();
        root.insert(index, &parts);
    }
    root.children = root
        .children
        .into_iter()
        .map(|child| match child {
            Child::Folder(folder) => Child::Folder(folder.compact()),
            file => file,
        })
        .collect();
    let mut rows = Vec::new();
    root.emit(0, collapsed, &mut rows);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use ducky_git::{ChangeStatus, FileChange, Mode};

    fn file(path: &str) -> ChangedFile {
        ChangedFile::from_git(FileChange {
            path: path.into(),
            old_path: None,
            status: ChangeStatus::Modified,
            similarity: None,
            old_mode: Some(Mode::FILE),
            new_mode: Some(Mode::FILE),
            old_oid: Some("a".into()),
            new_oid: Some("b".into()),
            stats: None,
            untracked: false,
        })
    }

    fn shape(rows: &[TreeRow]) -> Vec<String> {
        rows.iter()
            .map(|row| {
                let label = match &row.entry {
                    TreeEntry::Folder { name, files, .. } => format!("{name}/ ({files})"),
                    TreeEntry::File { name, .. } => name.clone(),
                };
                format!("{}{label}", "  ".repeat(row.depth))
            })
            .collect()
    }

    #[test]
    fn nests_files_and_joins_single_folder_chains() {
        let files: Vec<ChangedFile> = [
            "src/webhooks/dispatch.ts",
            "src/webhooks/retry/backoff.ts",
            "src/config.ts",
            "README.md",
        ]
        .map(file)
        .to_vec();
        let order: Vec<usize> = (0..files.len()).collect();
        let rows = build_tree(&files, &order, true, &HashSet::new());
        assert_eq!(
            shape(&rows),
            [
                "src/ (3)",
                "  webhooks/ (2)",
                "    dispatch.ts",
                "    retry/ (1)",
                "      backoff.ts",
                "  config.ts",
                "README.md",
            ]
        );
        let collapsed = HashSet::from(["src/webhooks".to_owned()]);
        let rows = build_tree(&files, &order, true, &collapsed);
        assert_eq!(shape(&rows)[1..3], ["  webhooks/ (2)", "  config.ts"]);
    }

    #[test]
    fn flat_rows_keep_the_order_and_whole_paths() {
        let files: Vec<ChangedFile> = ["a/x.rs", "b.rs"].map(file).to_vec();
        let rows = build_tree(&files, &[1, 0], false, &HashSet::new());
        assert_eq!(shape(&rows), ["b.rs", "a/x.rs"]);
    }

    #[test]
    fn filter_needs_every_word() {
        assert!(matches_filter("src/Webhooks/dispatch.ts", "hook disp"));
        assert!(!matches_filter("src/webhooks/dispatch.ts", "hook retry"));
        assert!(matches_filter("anything", "  "));
    }
}
