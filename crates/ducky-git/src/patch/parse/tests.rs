use super::*;

fn one(patch: &str) -> FileDiff {
    let mut files = parse_patch(patch.as_bytes()).unwrap();
    assert_eq!(files.len(), 1, "{files:#?}");
    files.remove(0)
}

fn numbers(file: &FileDiff) -> Vec<(LineKind, Option<u32>, Option<u32>, &str)> {
    file.hunks
        .iter()
        .flat_map(|h| &h.lines)
        .map(|l| (l.kind, l.old_line, l.new_line, l.text.as_str()))
        .collect()
}

use LineKind::{Added as A, Context as C, Removed as R};

#[test]
fn modified_file_with_two_hunks_and_sections() {
    let file = one("diff --git a/src/lib.rs b/src/lib.rs
index 83db48f..bf269f4 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,3 @@ fn main() {
 one
-two
+TWO
 three
@@ -10 +10,2 @@
 ten
+eleven
");
    assert_eq!(file.status, ChangeStatus::Modified);
    assert_eq!(file.old_path.as_deref(), Some("src/lib.rs"));
    assert_eq!(file.new_path.as_deref(), Some("src/lib.rs"));
    assert_eq!(file.old_oid.as_deref(), Some("83db48f"));
    assert_eq!(file.old_mode, Some(Mode::FILE));
    assert_eq!(file.new_mode, Some(Mode::FILE));
    assert_eq!(file.hunks[0].section, "fn main() {");
    assert_eq!((file.hunks[1].old_start, file.hunks[1].old_lines), (10, 1));
    assert_eq!(
        numbers(&file),
        [
            (C, Some(1), Some(1), "one"),
            (R, Some(2), None, "two"),
            (A, None, Some(2), "TWO"),
            (C, Some(3), Some(3), "three"),
            (C, Some(10), Some(10), "ten"),
            (A, None, Some(11), "eleven"),
        ]
    );
    assert_eq!((file.additions(), file.deletions()), (2, 1));
}

#[test]
fn rename_with_spaces_unicode_and_trailing_tabs() {
    let file = one("diff --git a/old name.txt b/new näme.txt
similarity index 83%
rename from old name.txt
rename to new näme.txt
index 9405325..497778c 100644
--- a/old name.txt\t
+++ b/new näme.txt\t
@@ -3,3 +3,4 @@ b
 c
 d
 e
+z
");
    assert_eq!(file.status, ChangeStatus::Renamed);
    assert_eq!(file.similarity, Some(83));
    assert_eq!(file.old_path.as_deref(), Some("old name.txt"));
    assert_eq!(file.new_path.as_deref(), Some("new näme.txt"));
    assert_eq!(numbers(&file).last().unwrap(), &(A, None, Some(6), "z"));
}

#[test]
fn pure_rename_has_paths_but_no_hunks() {
    let file = one("diff --git a/dir a/f b/dir b/f
similarity index 100%
rename from dir a/f
rename to dir b/f
");
    assert_eq!(file.status, ChangeStatus::Renamed);
    assert_eq!(file.old_path.as_deref(), Some("dir a/f"));
    assert_eq!(file.new_path.as_deref(), Some("dir b/f"));
    assert!(file.hunks.is_empty());
}

#[test]
fn copy() {
    let file = one("diff --git a/a.txt b/b.txt
similarity index 90%
copy from a.txt
copy to b.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/b.txt
@@ -1 +1 @@
-x
+y
");
    assert_eq!(file.status, ChangeStatus::Copied);
    assert_eq!(file.old_path.as_deref(), Some("a.txt"));
    assert_eq!(file.path(), "b.txt");
}

#[test]
fn binary_change() {
    let file = one("diff --git a/img.png b/img.png
index bdc955b..8835708 100644
Binary files a/img.png and b/img.png differ
");
    assert!(file.binary);
    assert!(file.hunks.is_empty());
    assert_eq!(file.path(), "img.png");
}

#[test]
fn new_empty_file_with_spaces_from_the_header_alone() {
    let file = one("diff --git a/an empty file b/an empty file
new file mode 100644
index 0000000..e69de29
");
    assert_eq!(file.status, ChangeStatus::Added);
    assert_eq!(file.old_path, None);
    assert_eq!(file.new_path.as_deref(), Some("an empty file"));
    assert_eq!(file.old_oid, None);
    assert_eq!(file.new_mode, Some(Mode::FILE));
    assert_eq!(file.old_mode, None);
}

#[test]
fn deleted_crlf_file_without_trailing_newline() {
    let file = one("diff --git a/crlf.txt b/crlf.txt
deleted file mode 100644
index 9d91271..0000000
--- a/crlf.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-x\r
-y
\\ No newline at end of file
");
    assert_eq!(file.status, ChangeStatus::Deleted);
    assert_eq!(file.new_path, None);
    assert_eq!(file.new_oid, None);
    let lines = &file.hunks[0].lines;
    assert_eq!(lines[0].text, "x\r");
    assert!(!lines[0].no_newline);
    assert!(lines[1].no_newline);
    assert_eq!((lines[1].old_line, lines[1].new_line), (Some(2), None));
}

#[test]
fn no_newline_on_both_sides_mid_hunk() {
    let file = one("diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
");
    let flags: Vec<(LineKind, bool)> = file.hunks[0]
        .lines
        .iter()
        .map(|l| (l.kind, l.no_newline))
        .collect();
    assert_eq!(flags, [(C, false), (R, true), (A, true)]);
}

#[test]
fn mode_change_only() {
    let file = one("diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
");
    assert_eq!(file.old_mode, Some(Mode::FILE));
    assert_eq!(file.new_mode, Some(Mode::EXECUTABLE));
    assert_eq!(file.status, ChangeStatus::Modified);
    assert!(file.hunks.is_empty());
}

#[test]
fn quoted_paths_with_tabs_quotes_and_octal() {
    let file = one(r#"diff --git "a/tab	x\"q" "b/n\303\244me\\b"
similarity index 100%
rename from "tab\tx\"q"
rename to "n\303\244me\\b"
"#);
    assert_eq!(file.old_path.as_deref(), Some("tab\tx\"q"));
    assert_eq!(file.new_path.as_deref(), Some("näme\\b"));
}

#[test]
fn quoted_header_paths_are_used_when_nothing_else_names_them() {
    let file = one(
        "diff --git \"a/sp ace\\tx\" \"b/sp ace\\tx\"\nnew file mode 100644\nindex 0000000..e69de29\n",
    );
    assert_eq!(file.new_path.as_deref(), Some("sp ace\tx"));
}

#[test]
fn submodule_pointer_change() {
    let file = one("diff --git a/vendor/lib b/vendor/lib
index 1111111..2222222 160000
--- a/vendor/lib
+++ b/vendor/lib
@@ -1 +1 @@
-Subproject commit 1111111111111111111111111111111111111111
+Subproject commit 2222222222222222222222222222222222222222
");
    assert_eq!(file.kind(), crate::FileKind::Submodule);
    assert_eq!(file.hunks[0].lines.len(), 2);
}

#[test]
fn content_that_looks_like_headers_stays_content() {
    let file = one("diff --git a/notes.md b/notes.md
index 1..2 100644
--- a/notes.md
+++ b/notes.md
@@ -1,3 +1,2 @@
--- a/heading
-diff --git a/x b/x
+++ b/added
 @@ -1 +1 @@
");
    assert_eq!(
        numbers(&file),
        [
            (R, Some(1), None, "-- a/heading"),
            (R, Some(2), None, "diff --git a/x b/x"),
            (A, None, Some(1), "++ b/added"),
            (C, Some(3), Some(2), "@@ -1 +1 @@"),
        ]
    );
}

#[test]
fn an_empty_context_line_counts_as_context() {
    let file = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n\n-a\n+b\n");
    assert_eq!(numbers(&file)[0], (C, Some(1), Some(1), ""));
}

#[test]
fn several_files_and_a_combined_diff_skipped() {
    let files = parse_patch(
        b"commit abc\n\ndiff --git a/one b/one\nnew file mode 100644\n--- /dev/null\n+++ b/one\n@@ -0,0 +1 @@\n+1\n\
diff --cc merged\nindex 1,2..3\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n -b\n++c\n\
diff --git a/two b/two\ndeleted file mode 100755\n--- a/two\n+++ /dev/null\n@@ -1 +0,0 @@\n-2\n",
    )
    .unwrap();
    let summary: Vec<(&str, ChangeStatus)> = files.iter().map(|f| (f.path(), f.status)).collect();
    assert_eq!(
        summary,
        [("one", ChangeStatus::Added), ("two", ChangeStatus::Deleted)]
    );
    assert_eq!(numbers(&files[0]), [(A, None, Some(1), "1")]);
    assert_eq!(files[1].old_mode, Some(Mode::EXECUTABLE));
}

#[test]
fn errors_on_cut_short_and_malformed_hunks() {
    let cut = parse_patch(b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n");
    assert_eq!(cut, Err(PatchError::Truncated { path: "f".into() }));
    let header = parse_patch(b"diff --git a/f b/f\n@@ -x +1 @@\n");
    assert!(matches!(
        header,
        Err(PatchError::HunkHeader { line: 2, .. })
    ));
    let extra = parse_patch(b"diff --git a/f b/f\n@@ -1 +1 @@\n+a\n+b\n");
    assert!(matches!(extra, Err(PatchError::HunkLine { line: 4, .. })));
}

#[test]
fn empty_input_is_no_files() {
    assert!(parse_patch(b"").unwrap().is_empty());
    assert!(parse_patch(b"\n").unwrap().is_empty());
}
