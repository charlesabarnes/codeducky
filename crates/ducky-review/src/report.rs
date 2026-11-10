use crate::note::{Author, Note, NoteStatus, Severity};
use crate::summary::{compare_notes, count_notes};
use crate::time::Timestamp;

/// What a Markdown review report is made from.
#[derive(Debug, Clone, Copy)]
pub struct ReportInput<'a> {
    pub repo_name: &'a str,
    pub base_branch: &'a str,
    pub branch: &'a str,
    pub head_sha: &'a str,
    pub base_sha: &'a str,
    pub started_at: Timestamp,
    /// Omitted from the summary when `None`.
    pub files: Option<&'a [ReportFile]>,
    pub notes: &'a [Note],
    pub checklists: &'a [ReportChecklist],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportFile {
    pub path: String,
    pub viewed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportChecklist {
    pub title: String,
    pub items: Vec<ReportItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportItem {
    pub text: String,
    pub checked: bool,
}

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

/// A code fence longer than any run of backticks in `text`.
pub fn fence_for(text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat((longest + 1).max(3))
}

/// The anchored lines with their context, numbered, the anchored ones marked with `>`.
pub fn note_excerpt(note: &Note) -> String {
    let anchor = &note.anchor;
    let line = i64::from(anchor.line);
    let end = i64::from(anchor.last_line());
    let first = line - anchor.before.len() as i64;
    let rows: Vec<&str> = anchor
        .before
        .iter()
        .map(String::as_str)
        .chain(anchor.anchored_text())
        .chain(anchor.after.iter().map(String::as_str))
        .collect();
    let width = (first + rows.len() as i64 - 1).to_string().len();
    rows.iter()
        .zip(first..)
        .map(|(row, number)| {
            let marker = if (line..=end).contains(&number) {
                '>'
            } else {
                ' '
            };
            format!("{marker} {number:>width$} | {row}")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn summary_lines(input: &ReportInput, notes: &[&Note]) -> Vec<String> {
    let counts = count_notes(notes.iter().copied());
    let mut statuses: Vec<String> = NoteStatus::ALL
        .into_iter()
        .filter(|status| counts.status(*status) > 0)
        .map(|status| format!("{} {}", counts.status(status), status.as_str()))
        .collect();
    if counts.possibly_resolved > 0 {
        statuses.push(format!("{} possibly resolved", counts.possibly_resolved));
    }
    let severities: Vec<String> = Severity::ALL
        .into_iter()
        .rev()
        .filter(|severity| counts.severity(*severity) > 0)
        .map(|severity| format!("{} {}", counts.severity(severity), severity.as_str()))
        .collect();
    let short = |sha: &str| sha.get(..7).unwrap_or(sha).to_owned();
    let mut lines = vec![
        format!(
            "- Branch: `{}` against `origin/{}`",
            input.branch, input.base_branch
        ),
        format!(
            "- Head: `{}`, merge base `{}`",
            short(input.head_sha),
            short(input.base_sha)
        ),
        format!("- Started: {}", input.started_at.minute_utc()),
    ];
    if let Some(files) = input.files {
        let viewed = files.iter().filter(|file| file.viewed).count();
        lines.push(format!(
            "- Files: {} changed, {viewed} of {} viewed",
            plural(files.len(), "file"),
            files.len()
        ));
    }
    let mut notes_line = format!("- Notes: {}", plural(counts.total, "note"));
    if !statuses.is_empty() {
        notes_line += &format!(" ({})", statuses.join(", "));
    }
    if !severities.is_empty() {
        notes_line += &format!("; {}", severities.join(", "));
    }
    lines.push(notes_line);
    lines
}

fn checklist_section(checklists: &[ReportChecklist]) -> Vec<String> {
    if checklists.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![String::new(), "## Checklists".to_owned()];
    for checklist in checklists {
        let done = checklist.items.iter().filter(|item| item.checked).count();
        lines.push(String::new());
        lines.push(format!(
            "### {} ({done}/{})",
            checklist.title,
            checklist.items.len()
        ));
        lines.push(String::new());
        for item in &checklist.items {
            let tick = if item.checked { 'x' } else { ' ' };
            lines.push(format!("- [{tick}] {}", item.text));
        }
    }
    lines
}

fn note_heading(note: &Note) -> String {
    let anchor = &note.anchor;
    let place = if note.anchor_lost {
        format!("last seen at {}", anchor.lines_label())
    } else if anchor.side == crate::side::Side::Old {
        format!("{} (base)", anchor.lines_label())
    } else {
        anchor.lines_label()
    };
    let status = if note.possibly_resolved() {
        "open, possibly resolved"
    } else {
        note.status.as_str()
    };
    let source = match &note.author {
        Author::Human => String::new(),
        agent => format!(" · from {}", agent.label()),
    };
    format!(
        "**{}** · {status} · {place}{source}",
        note.severity.as_str()
    )
}

fn resolution_lines(note: &Note) -> Vec<String> {
    let Some(resolution) = &note.resolution else {
        return Vec::new();
    };
    let mut lines = vec![
        String::new(),
        format!(
            "> **Resolved by {}** · {}",
            resolution.by.label(),
            resolution.at.minute_utc()
        ),
    ];
    if resolution.text.trim().is_empty() {
        return lines;
    }
    lines.push(">".to_owned());
    lines.extend(resolution.text.trim().split('\n').map(|line| {
        if line.is_empty() {
            ">".to_owned()
        } else {
            format!("> {line}")
        }
    }));
    lines
}

fn notes_section(notes: &[&Note]) -> Vec<String> {
    let mut lines = vec![String::new(), "## Notes".to_owned()];
    if notes.is_empty() {
        lines.extend([String::new(), "No notes.".to_owned()]);
        return lines;
    }
    let mut sorted = notes.to_vec();
    sorted.sort_by(|a, b| compare_notes(a, b));
    let mut path: Option<&str> = None;
    for note in sorted {
        if path != Some(note.path.as_str()) {
            path = Some(&note.path);
            lines.extend([String::new(), format!("### `{}`", note.path)]);
        }
        let excerpt = note_excerpt(note);
        let fence = fence_for(&excerpt);
        let body = note.body.trim();
        lines.extend([
            String::new(),
            note_heading(note),
            String::new(),
            if body.is_empty() {
                "_No text._".to_owned()
            } else {
                body.to_owned()
            },
            String::new(),
            fence.clone(),
            excerpt,
            fence,
        ]);
        lines.extend(resolution_lines(note));
    }
    lines
}

/// Dismissed notes stay out of the report.
pub fn is_reportable(note: &Note) -> bool {
    note.status != NoteStatus::Dismissed
}

pub fn build_report(input: &ReportInput) -> String {
    let notes: Vec<&Note> = input
        .notes
        .iter()
        .filter(|note| is_reportable(note))
        .collect();
    let mut lines = vec![
        format!("# Review: {} · {}", input.repo_name, input.branch),
        String::new(),
    ];
    lines.extend(summary_lines(input, &notes));
    lines.extend(checklist_section(input.checklists));
    lines.extend(notes_section(&notes));
    lines.push(String::new());
    lines.join("\n")
}

/// e.g. `review-me-repo-feature-notes-2026-10-03.md`.
pub fn report_file_name(repo_name: &str, branch: &str, started_at: Timestamp) -> String {
    let mut slug = String::new();
    for c in format!("{repo_name}-{branch}").chars() {
        let keep = c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-');
        if keep && c != '-' {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    format!("review-{slug}-{}.md", started_at.date())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::Anchor;
    use crate::ids::NoteId;
    use crate::note::{NewNote, Resolution};
    use crate::side::Side;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn anchor() -> Anchor {
        Anchor {
            side: Side::New,
            line: 12,
            end_line: None,
            code: strings(&["const x = 1"]),
            before: strings(&["// a", "// b"]),
            after: strings(&["export { x }"]),
        }
    }

    fn note(id: &str) -> Note {
        NewNote::new("src/a.ts", anchor(), "Rename **x**.")
            .into_note(NoteId::from(id), Timestamp(0))
    }

    fn input<'a>(notes: &'a [Note], checklists: &'a [ReportChecklist]) -> ReportInput<'a> {
        ReportInput {
            repo_name: "me/repo",
            base_branch: "main",
            branch: "feature/notes",
            head_sha: "abcdef1234567890",
            base_sha: "1234567abcdef",
            started_at: Timestamp::utc(2026, 10, 3, 14, 5),
            files: None,
            notes,
            checklists,
        }
    }

    #[test]
    fn renders_an_excerpt_with_the_anchored_line_marked() {
        assert_eq!(
            note_excerpt(&note("n1")),
            [
                "  10 | // a",
                "  11 | // b",
                "> 12 | const x = 1",
                "  13 | export { x }"
            ]
            .join("\n")
        );
    }

    #[test]
    fn marks_every_line_of_a_range() {
        let mut range = note("n1");
        range.anchor = Anchor {
            end_line: Some(13),
            code: strings(&["const x = 1", "const y = 2"]),
            before: strings(&["// b"]),
            ..anchor()
        };
        assert_eq!(
            note_excerpt(&range),
            [
                "  11 | // b",
                "> 12 | const x = 1",
                "> 13 | const y = 2",
                "  14 | export { x }"
            ]
            .join("\n")
        );
        let notes = [range];
        assert!(build_report(&input(&notes, &[])).contains("**issue** · open · lines 12–13"));
    }

    #[test]
    fn builds_summary_checklist_state_and_notes_grouped_by_file() {
        let mut resolved = note("n2");
        resolved.path = "src/b.ts".into();
        resolved.severity = Severity::Nit;
        resolved.status = NoteStatus::Resolved;
        resolved.body = "Typo".into();
        let mut lost = note("n3");
        lost.severity = Severity::Blocker;
        lost.anchor_lost = true;
        lost.body = "Null check".into();
        lost.anchor = Anchor {
            side: Side::Old,
            line: 3,
            end_line: None,
            code: strings(&["if (x) {"]),
            before: vec![],
            after: vec![],
        };
        let notes = [resolved, note("n1"), lost];
        let files = [
            ReportFile {
                path: "src/a.ts".into(),
                viewed: true,
            },
            ReportFile {
                path: "src/b.ts".into(),
                viewed: false,
            },
        ];
        let checklists = [ReportChecklist {
            title: "Before push".into(),
            items: vec![
                ReportItem {
                    text: "Tests pass".into(),
                    checked: true,
                },
                ReportItem {
                    text: "No logs".into(),
                    checked: false,
                },
            ],
        }];
        let markdown = build_report(&ReportInput {
            files: Some(&files),
            ..input(&notes, &checklists)
        });
        let expected = [
            "# Review: me/repo · feature/notes",
            "",
            "- Branch: `feature/notes` against `origin/main`",
            "- Head: `abcdef1`, merge base `1234567`",
            "- Started: 2026-10-03 14:05 UTC",
            "- Files: 2 files changed, 1 of 2 viewed",
            "- Notes: 3 notes (2 open, 1 resolved, 1 possibly resolved); 1 blocker, 1 issue, 1 nit",
            "",
            "## Checklists",
            "",
            "### Before push (1/2)",
            "",
            "- [x] Tests pass",
            "- [ ] No logs",
            "",
            "## Notes",
            "",
            "### `src/a.ts`",
            "",
            "**blocker** · open, possibly resolved · last seen at line 3",
            "",
            "Null check",
            "",
            "```",
            "> 3 | if (x) {",
            "```",
            "",
            "**issue** · open · line 12",
            "",
            "Rename **x**.",
            "",
            "```",
            "  10 | // a",
            "  11 | // b",
            "> 12 | const x = 1",
            "  13 | export { x }",
            "```",
            "",
            "### `src/b.ts`",
            "",
            "**nit** · resolved · line 12",
            "",
            "Typo",
            "",
            "```",
            "  10 | // a",
            "  11 | // b",
            "> 12 | const x = 1",
            "  13 | export { x }",
            "```",
            "",
        ]
        .join("\n");
        assert_eq!(markdown, expected);
    }

    #[test]
    fn lengthens_the_fence_when_the_code_contains_backticks() {
        let mut fenced = note("n1");
        fenced.anchor = Anchor {
            line: 1,
            code: strings(&["const s = ```"]),
            ..Anchor::default()
        };
        let notes = [fenced];
        let markdown = build_report(&input(&notes, &[]));
        assert!(markdown.contains("````\n> 1 | const s = ```\n````"));
        assert!(!markdown.contains("## Checklists"));
        assert!(!markdown.contains("- Files:"));
    }

    #[test]
    fn quotes_the_resolution_under_a_resolved_note_and_marks_agent_notes() {
        let mut fixed = note("n1");
        fixed.status = NoteStatus::Resolved;
        fixed.author = Author::agent("Claude Code");
        fixed.resolution = Some(Resolution {
            by: Author::agent("Claude Code"),
            text: "Fixed in a1b2c3.\n\nAdded a test.".into(),
            at: Timestamp::utc(2026, 10, 3, 15, 0),
        });
        let notes = [fixed];
        let markdown = build_report(&input(&notes, &[]));
        assert!(markdown.contains("**issue** · resolved · line 12 · from Claude Code"));
        let quote = [
            "```",
            "",
            "> **Resolved by Claude Code** · 2026-10-03 15:00 UTC",
            ">",
            "> Fixed in a1b2c3.",
            ">",
            "> Added a test.",
            "",
        ]
        .join("\n");
        assert!(markdown.contains(&quote));
    }

    #[test]
    fn leaves_dismissed_notes_out() {
        let mut dismissed = note("n1");
        dismissed.status = NoteStatus::Dismissed;
        let notes = [dismissed];
        assert!(build_report(&input(&notes, &[])).contains("No notes."));
    }

    #[test]
    fn suggests_a_safe_file_name() {
        assert_eq!(
            report_file_name(
                "me/repo",
                "feature/notes",
                Timestamp::utc(2026, 10, 3, 14, 5)
            ),
            "review-me-repo-feature-notes-2026-10-03.md"
        );
    }
}
