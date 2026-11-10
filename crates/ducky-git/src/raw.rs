//! `git diff --raw -z` and `--numstat -z` records.

use std::collections::HashMap;

use crate::model::{ChangeStatus, FileChange, LineStats, Mode};
use crate::repo::is_null_oid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawError(pub String);

fn take<'a>(fields: &mut impl Iterator<Item = &'a [u8]>, what: &str) -> Result<String, RawError> {
    fields
        .next()
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .ok_or_else(|| RawError(format!("missing {what}")))
}

/// `:old_mode new_mode old_oid new_oid STATUS[score]\0path\0[new_path\0]`, repeated.
pub fn parse_raw(out: &[u8]) -> Result<Vec<FileChange>, RawError> {
    let mut changes = Vec::new();
    let mut fields = out.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(header) = fields.next() {
        let header = String::from_utf8_lossy(header);
        let header = header
            .strip_prefix(':')
            .ok_or_else(|| RawError(format!("not a raw record: {header:?}")))?;
        let parts: Vec<&str> = header.split(' ').collect();
        let [old_mode, new_mode, old_oid, new_oid, status] = parts[..] else {
            return Err(RawError(format!("raw header {header:?}")));
        };
        let (letter, score) = status.split_at(1);
        let status = match letter {
            "A" => ChangeStatus::Added,
            "M" => ChangeStatus::Modified,
            "D" => ChangeStatus::Deleted,
            "R" => ChangeStatus::Renamed,
            "C" => ChangeStatus::Copied,
            "T" => ChangeStatus::TypeChanged,
            "U" => ChangeStatus::Unmerged,
            other => return Err(RawError(format!("status {other:?}"))),
        };
        let first = take(&mut fields, "path")?;
        let (path, old_path) = match status {
            ChangeStatus::Renamed | ChangeStatus::Copied => {
                (take(&mut fields, "new path")?, Some(first))
            }
            _ => (first, None),
        };
        let oid = |oid: &str| Some(oid.to_owned()).filter(|o| !is_null_oid(o));
        changes.push(FileChange {
            path,
            old_path,
            status,
            similarity: score.parse().ok(),
            old_mode: Mode::parse(old_mode),
            new_mode: Mode::parse(new_mode),
            old_oid: oid(old_oid),
            new_oid: oid(new_oid),
            stats: None,
            untracked: false,
        });
    }
    Ok(changes)
}

/// `added\tdeleted\tpath\0`, or `added\tdeleted\t\0old\0new\0` for renames and copies;
/// `-\t-` for binary. Keyed by the new path.
pub fn parse_numstat(out: &[u8]) -> Result<HashMap<String, LineStats>, RawError> {
    let mut stats = HashMap::new();
    let mut fields = out.split(|b| *b == 0);
    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let record = String::from_utf8_lossy(record);
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(RawError(format!("numstat record {record:?}")));
        };
        let path = if path.is_empty() {
            take(&mut fields, "old path")?;
            take(&mut fields, "new path")?
        } else {
            path.to_owned()
        };
        let line_stats = match (added.parse(), deleted.parse()) {
            (Ok(additions), Ok(deletions)) => LineStats::Text {
                additions,
                deletions,
            },
            _ => LineStats::Binary,
        };
        stats.insert(path, line_stats);
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    const Z: &str = "0000000000000000000000000000000000000000";

    #[test]
    fn parses_every_status() {
        let raw = format!(
            ":100644 100644 {a} {Z} M\0bin\0\
:100644 000000 {a} {Z} D\0crlf.txt\0\
:100644 100755 {a} {Z} M\0keep\0\
:100644 100644 {a} {b} R083\0old name.txt\0new näme.txt\0\
:000000 100644 {Z} {b} A\0s.txt\0\
:100644 120000 {a} {b} T\0link\0\
:160000 160000 {a} {b} M\0sub\0\
:000000 000000 {Z} {Z} U\0conflict\0",
            a = "a".repeat(40),
            b = "b".repeat(40),
        );
        let changes = parse_raw(raw.as_bytes()).unwrap();
        assert_eq!(changes.len(), 8);
        assert_eq!(changes[0].new_oid, None);
        assert_eq!(changes[1].status, ChangeStatus::Deleted);
        assert_eq!(changes[1].new_mode, None);
        assert!(changes[2].mode_changed());
        assert!(changes[2].new_mode.unwrap().is_executable());
        let rename = &changes[3];
        assert_eq!(rename.status, ChangeStatus::Renamed);
        assert_eq!(rename.old_path.as_deref(), Some("old name.txt"));
        assert_eq!(rename.path, "new näme.txt");
        assert_eq!(rename.similarity, Some(83));
        assert_eq!(changes[4].old_mode, None);
        assert_eq!(changes[5].status, ChangeStatus::TypeChanged);
        assert_eq!(changes[5].kind(), crate::FileKind::Symlink);
        assert_eq!(changes[6].kind(), crate::FileKind::Submodule);
        assert_eq!(changes[7].status, ChangeStatus::Unmerged);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_raw(b"nope\0").is_err());
        assert!(parse_raw(b":100644 100644 a b X\0p\0").is_err());
        assert!(parse_raw(b":100644 100644 a b R100\0only-one\0").is_err());
        assert!(parse_raw(b"").unwrap().is_empty());
    }

    #[test]
    fn parses_numstat_with_renames_binary_and_tabs() {
        let out = b"-\t-\tbin\x000\t2\tcrlf.txt\x001\t0\t\x00old name.txt\x00new n\xc3\xa4me.txt\x003\t1\ttab\there\x00";
        let stats = parse_numstat(out).unwrap();
        assert_eq!(stats["bin"], LineStats::Binary);
        assert_eq!(
            stats["crlf.txt"],
            LineStats::Text {
                additions: 0,
                deletions: 2
            }
        );
        assert_eq!(
            stats["new näme.txt"],
            LineStats::Text {
                additions: 1,
                deletions: 0
            }
        );
        assert!(stats.contains_key("tab\there"));
        assert!(!stats.contains_key("old name.txt"));
    }
}
