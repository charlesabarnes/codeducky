//! The text an agent receives for a task. Short on purpose: the notes README beside the file
//! carries the format, so the prompt only says what to do, where, and what not to touch.

use ducky_review::{Note, ReviewTarget};

use super::task::{Task, TaskContext};

/// First line of a note body kept in a fix list.
const BODY_CHARS: usize = 100;

pub fn render(task: &Task, context: &TaskContext) -> String {
    match task {
        Task::Review { base } => review(base, context),
        Task::Fix { notes, more_open } => fix(notes, *more_open, context),
        Task::Custom { text } => text.clone(),
    }
}

fn checkout_rule(target: &ReviewTarget) -> String {
    match target {
        ReviewTarget::Branch { branch } => format!(
            "The checkout must be on branch `{branch}`. If it is not, stop and say so; do not switch branches."
        ),
        ReviewTarget::PullRequest { number } => format!(
            "The checkout must be pull request #{number}. If it is not, stop and say so; do not switch branches."
        ),
    }
}

fn review(base: &str, context: &TaskContext) -> String {
    let TaskContext {
        repo_root,
        target,
        notes_path,
        readme_path,
    } = context;
    let checkout = checkout_rule(target);
    format!(
        "Code Ducky review task: review {target} in {repo_root} against `{base}` and record each finding as a note in Code Ducky's notes file.

Notes file: {notes_path}
How to add a note: {readme_path}

- {checkout}
- Diff: `git diff $(git merge-base {base} HEAD)` (it includes uncommitted changes). Read the surrounding code where you need it.
- Look for bugs, unhandled edge cases (empty input, errors, limits, concurrency), missing tests, leftover debug code and misleading names. Skip style nits and anything a linter would catch.
- Add one note per real finding: severity blocker, issue, suggestion or nit; the line on the new side; a body that says what is wrong and how to fix it. Skip findings an open note already covers.
- Edit no other file. Do not change or delete existing notes.
- Finish with a one-line summary of the notes you added."
    )
}

fn fix(notes: &[Note], more_open: usize, context: &TaskContext) -> String {
    let TaskContext {
        repo_root,
        target,
        notes_path,
        readme_path,
    } = context;
    let checkout = checkout_rule(target);
    let mut list: Vec<String> = notes.iter().map(note_line).collect();
    if more_open > 0 {
        list.push(format!(
            "(and {more_open} more open notes in the notes file; fix those too)"
        ));
    }
    let list = list.join("\n");
    format!(
        "Code Ducky fix task: fix these review notes on {target} in {repo_root}, then mark each one resolved in Code Ducky's notes file.

Notes file: {notes_path}
How to resolve a note: {readme_path}

{list}

- {checkout}
- Find the code from each note's anchor; line numbers may have moved. Make the smallest change that fixes it, in the code's existing style, and run the tests that cover it.
- Then set the note's status to \"resolved\" with a resolution text saying what you changed. Use \"dismissed\" with a reason for a note you decide not to act on; leave a note open if it is unclear, and say why.
- Only touch files these notes need. Do not delete notes or edit other notes. Do not commit or push.
- Finish with one line per note: its id and what happened."
    )
}

/// `k3x9qa  src/cart.rs:42  [issue]  First line of the body`
fn note_line(note: &Note) -> String {
    let body = note.body.lines().map(str::trim).find(|l| !l.is_empty());
    let mut body = body.unwrap_or_default().to_owned();
    if body.chars().count() > BODY_CHARS {
        body = body.chars().take(BODY_CHARS - 1).collect::<String>() + "…";
    }
    format!(
        "{}  {}:{}  [{}]  {body}",
        note.id.as_str(),
        note.path,
        note.anchor.line_span(),
        note.severity.as_str()
    )
}

#[cfg(test)]
mod tests {
    use ducky_review::{Anchor, Author, NewNote, NoteId, Severity, Side, Timestamp};

    use super::*;
    use crate::tasks::task::FixScope;

    fn context() -> TaskContext {
        TaskContext {
            repo_root: "/src/shop".into(),
            target: ReviewTarget::branch("feature/cart"),
            notes_path: "/src/shop/.git/codeducky/branches/feature/cart/notes.json".into(),
            readme_path: "/src/shop/.git/codeducky/README.md".into(),
        }
    }

    fn note(id: &str, line: u32, end: Option<u32>, severity: Severity, body: &str) -> Note {
        let mut new = NewNote::new("src/cart.rs", Anchor::at_line(Side::New, line, end), body);
        new.severity = severity;
        new.author = Author::Human;
        new.into_note(
            NoteId::new(id),
            "2026-11-10T10:00:00Z".parse::<Timestamp>().unwrap(),
        )
    }

    #[test]
    fn review_names_the_files_the_base_and_the_branch() {
        let text = render(&Task::review("origin/main"), &context());
        assert!(text.starts_with(
            "Code Ducky review task: review branch feature/cart in /src/shop against `origin/main`"
        ));
        assert!(
            text.contains(
                "Notes file: /src/shop/.git/codeducky/branches/feature/cart/notes.json\n"
            )
        );
        assert!(text.contains("How to add a note: /src/shop/.git/codeducky/README.md\n"));
        assert!(text.contains("`git diff $(git merge-base origin/main HEAD)`"));
        assert!(text.contains("on branch `feature/cart`"));
        assert!(text.lines().count() < 15, "{text}");
    }

    #[test]
    fn fix_lists_each_note_compactly() {
        let long = "x".repeat(150);
        let notes = vec![
            note(
                "k3x9qa",
                42,
                None,
                Severity::Issue,
                "\n`total` ignores the discount.\nMore.",
            ),
            note("b7", 10, Some(14), Severity::Blocker, &long),
        ];
        let task = Task::fix(&notes, &FixScope::AllOpen).unwrap();
        let text = render(&task, &context());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[5],
            format!("b7  src/cart.rs:10–14  [blocker]  {}…", "x".repeat(99))
        );
        assert_eq!(
            lines[6],
            "k3x9qa  src/cart.rs:42  [issue]  `total` ignores the discount."
        );
        assert!(text.contains("set the note's status to \"resolved\" with a resolution text"));
        assert!(text.contains("Do not delete notes"));
    }

    #[test]
    fn custom_text_goes_as_it_is() {
        assert_eq!(
            render(&Task::custom("run the tests"), &context()),
            "run the tests"
        );
    }

    #[test]
    fn pull_requests_say_which_checkout() {
        let context = TaskContext {
            target: ReviewTarget::pull_request(12),
            ..context()
        };
        let text = render(&Task::review("main"), &context);
        assert!(text.contains("review pull request #12 in /src/shop"));
        assert!(text.contains("The checkout must be pull request #12."));
    }
}
