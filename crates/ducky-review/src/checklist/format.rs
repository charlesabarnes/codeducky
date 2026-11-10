use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use super::model::ChecklistDraft;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChecklistFormatError {
    #[error("not JSON: {0}")]
    Json(String),
    #[error("not a Code Ducky checklist file")]
    NotChecklists,
    #[error("no checklist items found; use \"- [ ] item\" lines")]
    NoItems,
}

#[derive(Serialize)]
struct ChecklistFile<'a> {
    version: u32,
    checklists: &'a [ChecklistDraft],
}

pub fn checklists_to_json(checklists: &[ChecklistDraft]) -> String {
    let file = ChecklistFile {
        version: 1,
        checklists,
    };
    let json = serde_json::to_string_pretty(&file).expect("drafts serialize");
    format!("{json}\n")
}

pub fn checklists_to_markdown(checklists: &[ChecklistDraft]) -> String {
    let sections: Vec<String> = checklists
        .iter()
        .map(|checklist| {
            let mut lines = vec![format!("# {}", checklist.title), String::new()];
            lines.extend(checklist.items.iter().map(|item| format!("- [ ] {item}")));
            lines.join("\n")
        })
        .collect();
    format!("{}\n", sections.join("\n\n"))
}

fn draft(value: &Value) -> Option<ChecklistDraft> {
    let title = value.get("title")?.as_str()?.trim();
    let items = value
        .get("items")?
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()?;
    Some(ChecklistDraft {
        title: if title.is_empty() { "Untitled" } else { title }.to_owned(),
        items: items
            .into_iter()
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_owned)
            .collect(),
        required: value.get("required") == Some(&Value::Bool(true)),
    })
}

/// Reads `{"version": 1, "checklists": [...]}` or a bare array of checklists.
pub fn parse_checklist_json(text: &str) -> Result<Vec<ChecklistDraft>, ChecklistFormatError> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|error| ChecklistFormatError::Json(error.to_string()))?;
    let list = match &parsed {
        Value::Array(list) => list,
        Value::Object(file) => file
            .get("checklists")
            .and_then(Value::as_array)
            .ok_or(ChecklistFormatError::NotChecklists)?,
        _ => return Err(ChecklistFormatError::NotChecklists),
    };
    list.iter()
        .map(draft)
        .collect::<Option<Vec<_>>>()
        .ok_or(ChecklistFormatError::NotChecklists)
}

static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#{1,6}\s+(.+?)\s*#*\s*$").expect("static pattern"));
static ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$").expect("static pattern")
});

/// Reads `# Title` headings with `- [ ] item` lines; items before any heading go under `fallback_title`.
pub fn parse_checklist_markdown(
    text: &str,
    fallback_title: &str,
) -> Result<Vec<ChecklistDraft>, ChecklistFormatError> {
    let mut checklists: Vec<ChecklistDraft> = Vec::new();
    for line in text.lines() {
        if let Some(heading) = HEADING.captures(line) {
            checklists.push(ChecklistDraft {
                title: heading[1].to_owned(),
                ..ChecklistDraft::default()
            });
            continue;
        }
        let Some(item) = ITEM.captures(line) else {
            continue;
        };
        if checklists.is_empty() {
            checklists.push(ChecklistDraft {
                title: fallback_title.to_owned(),
                ..ChecklistDraft::default()
            });
        }
        if let Some(current) = checklists.last_mut() {
            current.items.push(item[1].to_owned());
        }
    }
    checklists.retain(|checklist| !checklist.items.is_empty());
    if checklists.is_empty() {
        return Err(ChecklistFormatError::NoItems);
    }
    Ok(checklists)
}

/// Picks the format by the file name's extension; Markdown uses the name as a fallback title.
pub fn parse_checklist_file(
    name: &str,
    text: &str,
) -> Result<Vec<ChecklistDraft>, ChecklistFormatError> {
    if name.to_lowercase().ends_with(".json") {
        return parse_checklist_json(text);
    }
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    parse_checklist_markdown(text, stem)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(title: &str, items: &[&str]) -> ChecklistDraft {
        ChecklistDraft {
            title: title.into(),
            items: items.iter().map(|item| (*item).to_owned()).collect(),
            required: false,
        }
    }

    fn lists() -> Vec<ChecklistDraft> {
        vec![
            draft("Before push", &["Tests pass", "No console.log"]),
            draft("API", &["Errors are typed"]),
        ]
    }

    #[test]
    fn round_trips_json() {
        assert_eq!(
            parse_checklist_json(&checklists_to_json(&lists())),
            Ok(lists())
        );
        let required = vec![ChecklistDraft {
            required: true,
            ..draft("Gate", &["Signed off"])
        }];
        assert_eq!(
            parse_checklist_json(&checklists_to_json(&required)),
            Ok(required)
        );
    }

    #[test]
    fn writes_and_reads_markdown_task_lists() {
        let markdown = checklists_to_markdown(&lists());
        assert_eq!(
            markdown,
            "# Before push\n\n- [ ] Tests pass\n- [ ] No console.log\n\n# API\n\n- [ ] Errors are typed\n"
        );
        assert_eq!(parse_checklist_markdown(&markdown, "x"), Ok(lists()));
    }

    #[test]
    fn uses_the_file_name_when_markdown_has_no_heading_and_accepts_checked_or_plain_bullets() {
        assert_eq!(
            parse_checklist_file("release.md", "- [x] Tag\n* Changelog\n\nprose\n"),
            Ok(vec![draft("release", &["Tag", "Changelog"])])
        );
    }

    #[test]
    fn accepts_a_bare_json_array() {
        assert_eq!(
            parse_checklist_file("a.json", r#"[{"title": " T ", "items": [" a ", ""]}]"#),
            Ok(vec![draft("T", &["a"])])
        );
    }

    #[test]
    fn rejects_files_without_checklists() {
        assert_eq!(
            parse_checklist_json(r#"{"foo":1}"#),
            Err(ChecklistFormatError::NotChecklists)
        );
        assert_eq!(
            parse_checklist_markdown("# Empty\n", "x"),
            Err(ChecklistFormatError::NoItems)
        );
    }
}
