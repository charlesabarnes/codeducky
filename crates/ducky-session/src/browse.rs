//! A folder listing on any machine, for picking a checkout where there is no native dialog.

use ducky_host::{ExecRequest, Host};

use crate::error::{Result, SessionError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    pub name: String,
    /// It holds a `.git`: a checkout to open.
    pub is_repo: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    /// Absolute, as the machine resolved it (`~` expanded, links followed).
    pub path: String,
    pub is_repo: bool,
    /// Subfolders, visible ones first, each group by name.
    pub folders: Vec<Folder>,
}

impl Listing {
    pub fn parent(&self) -> Option<String> {
        let trimmed = self.path.trim_end_matches('/');
        let (parent, _) = trimmed.rsplit_once('/')?;
        Some(if parent.is_empty() {
            "/".into()
        } else {
            parent.into()
        })
    }

    pub fn child(&self, name: &str) -> String {
        format!("{}/{name}", self.path.trim_end_matches('/'))
    }
}

/// `$1` is the folder; a leading `~` means the home folder there.
const SCRIPT: &str = r#"p=$1
case $p in "~") p=$HOME ;; "~/"*) p=$HOME/${p#"~/"} ;; esac
cd -- "$p" || exit 3
pwd -P
if [ -e .git ]; then echo R; else echo -; fi
for e in * .[!.]* ..?*; do
  [ -d "$e" ] || continue
  if [ -e "$e/.git" ]; then echo "R $e"; else echo "D $e"; fi
done"#;

/// Lists `path`'s subfolders on the machine `host` reaches. Blocks.
pub fn list_folders(host: &dyn Host, path: &str) -> Result<Listing> {
    let path = if path.trim().is_empty() {
        "~"
    } else {
        path.trim()
    };
    let request = ExecRequest::new(["sh", "-c", SCRIPT, "sh", path])
        .timeout(std::time::Duration::from_secs(20));
    let output = host.exec(request)?;
    if !output.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.trim().lines().last().unwrap_or("cannot open it");
        return Err(SessionError::Host(ducky_host::HostError::Other(format!(
            "{path}: {reason}"
        ))));
    }
    parse(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        SessionError::Host(ducky_host::HostError::Other(format!(
            "{path}: unexpected listing"
        )))
    })
}

/// `~/x` as an absolute path on that machine; other paths unchanged. Blocks.
pub fn resolve_home(host: &dyn Host, path: &str) -> Result<String> {
    if path == "~" || path.starts_with("~/") {
        Ok(list_folders(host, path)?.path)
    } else {
        Ok(path.to_owned())
    }
}

fn parse(text: &str) -> Option<Listing> {
    let mut lines = text.lines();
    let path = lines.next()?.to_owned();
    let is_repo = lines.next()? == "R";
    let mut folders: Vec<Folder> = lines
        .filter_map(|line| {
            let (mark, name) = line.split_once(' ')?;
            Some(Folder {
                name: name.to_owned(),
                is_repo: mark == "R",
            })
        })
        .collect();
    folders.sort_by(|a, b| {
        (a.name.starts_with('.'), a.name.to_lowercase())
            .cmp(&(b.name.starts_with('.'), b.name.to_lowercase()))
    });
    Some(Listing {
        path,
        is_repo,
        folders,
    })
}

#[cfg(test)]
mod tests {
    use ducky_host::LocalHost;

    use super::*;

    #[test]
    fn lists_subfolders_and_marks_checkouts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("shop/.git")).unwrap();
        std::fs::create_dir_all(root.join("Notes")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::create_dir_all(root.join("with space")).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();

        let listing = list_folders(&LocalHost, root.to_str().unwrap()).unwrap();
        assert_eq!(listing.path, root.to_str().unwrap());
        assert!(!listing.is_repo);
        let names: Vec<(&str, bool)> = listing
            .folders
            .iter()
            .map(|f| (f.name.as_str(), f.is_repo))
            .collect();
        assert_eq!(
            names,
            [
                ("Notes", false),
                ("shop", true),
                ("with space", false),
                (".hidden", false)
            ]
        );
        assert_eq!(listing.child("shop"), format!("{}/shop", root.display()));
        assert_eq!(
            listing.parent().as_deref(),
            root.parent().and_then(|p| p.to_str())
        );
        let shop = list_folders(&LocalHost, &listing.child("shop")).unwrap();
        assert!(shop.is_repo);
        assert!(list_folders(&LocalHost, &listing.child("missing")).is_err());
    }

    #[test]
    fn home_is_the_default() {
        let home = list_folders(&LocalHost, "").unwrap();
        let expected = std::fs::canonicalize(std::env::var("HOME").unwrap()).unwrap();
        assert_eq!(home.path, expected.to_str().unwrap());
        assert_eq!(
            Listing {
                path: "/a".into(),
                is_repo: false,
                folders: vec![]
            }
            .parent()
            .as_deref(),
            Some("/")
        );
    }
}
