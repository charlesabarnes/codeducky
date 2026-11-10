//! A file's diff as a one-hunk unified patch holding the whole file, which is what gpui-kit's
//! diff view takes. With every line present, the view can fold and unfold context itself.

use std::fmt::Write as _;

use ducky_review::diff::{DiffLine, LineKind};
use ducky_session::{FileDiff, TextDiff};

pub fn unified_patch(diff: &FileDiff) -> Option<String> {
    let text = diff.text()?;
    let old_path = diff.old_path.as_deref().unwrap_or(&diff.path);
    Some(patch_for(old_path, &diff.path, text))
}

fn patch_for(old_path: &str, new_path: &str, text: &TextDiff) -> String {
    let mut out =
        String::with_capacity(text.lines.iter().map(|l| l.text.len() + 2).sum::<usize>() + 128);
    let _ = writeln!(out, "diff --git a/{old_path} b/{new_path}");
    let side = |present: bool, prefix: &str, path: &str| {
        if present {
            format!("{prefix}/{path}")
        } else {
            "/dev/null".to_owned()
        }
    };
    let _ = writeln!(out, "--- {}", side(text.old_text.is_some(), "a", old_path));
    let _ = writeln!(out, "+++ {}", side(text.new_text.is_some(), "b", new_path));
    if text.lines.is_empty() {
        return out;
    }
    let count = |kind: LineKind| text.lines.iter().filter(|l| l.kind != kind).count();
    let (old_count, new_count) = (count(LineKind::Add), count(LineKind::Del));
    let start = |count: usize| usize::from(count > 0);
    let _ = writeln!(
        out,
        "@@ -{},{old_count} +{},{new_count} @@",
        start(old_count),
        start(new_count)
    );
    for line in &text.lines {
        push_line(&mut out, line);
    }
    out
}

fn push_line(out: &mut String, line: &DiffLine) {
    let prefix = match line.kind {
        LineKind::Context => ' ',
        LineKind::Add => '+',
        LineKind::Del => '-',
    };
    out.push(prefix);
    out.push_str(&line.text);
    out.push('\n');
    if line.no_newline {
        out.push_str("\\ No newline at end of file\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use ducky_review::diff::{LineOptions, build_lines};
    use ducky_session::{DiffContent, DiffOptions};

    fn diff(old: Option<&str>, new: Option<&str>) -> FileDiff {
        FileDiff {
            path: "src/a.rs".into(),
            old_path: None,
            content: DiffContent::Text(TextDiff {
                old_text: old.map(str::to_owned),
                new_text: new.map(str::to_owned),
                lines: build_lines(old.unwrap_or(""), new.unwrap_or(""), LineOptions::default()),
                moved: Vec::new(),
                old_lines: Arc::from([]),
                new_lines: Arc::from([]),
            }),
            notices: Vec::new(),
            options: DiffOptions::default(),
        }
    }

    #[test]
    fn writes_the_whole_file_as_one_hunk() {
        let patch = unified_patch(&diff(Some("a\nb\nc"), Some("a\nB\nc\n"))).unwrap();
        assert_eq!(
            patch,
            "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,3 @@\n a\n-b\n-c\n\\ No newline at end of file\n+B\n+c\n"
        );
        let files = gpui_kit::component::diff::DiffFile::parse(&patch).unwrap();
        assert_eq!((files[0].additions(), files[0].deletions()), (2, 2));
    }

    #[test]
    fn marks_missing_sides() {
        let patch = unified_patch(&diff(None, Some("x\n"))).unwrap();
        assert!(patch.contains("--- /dev/null\n+++ b/src/a.rs\n@@ -0,0 +1,1 @@\n+x\n"));
        let files = gpui_kit::component::diff::DiffFile::parse(&patch).unwrap();
        assert!(files[0].original_path().is_none());
    }
}
