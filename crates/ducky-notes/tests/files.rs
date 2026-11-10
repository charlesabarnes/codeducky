use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use ducky_host::{ExecOutput, ExecRequest, Host, HostError, LocalHost};
use ducky_notes::{NotesError, NotesRepo, ReviewNotes};
use ducky_review::checklist::ChecklistDraft;
use ducky_review::{
    Anchor, Author, ChecklistItemId, FileChange, NewNote, NoteEdit, NoteId, NoteStatus, NoteUpdate,
    ReviewTarget, Severity, Side, Timestamp,
};
use serde_json::{Value, json};
use tempfile::TempDir;

fn clock() -> Timestamp {
    Timestamp::utc(2026, 11, 10, 14, 5)
}

fn git(cwd: &str, args: &[&str]) {
    let mut argv = vec!["git"];
    argv.extend(args);
    let output = LocalHost.exec(ExecRequest::new(argv).cwd(cwd)).unwrap();
    assert!(
        output.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

struct Repo {
    _dir: TempDir,
    path: String,
}

fn repo() -> Repo {
    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    git(&path, &["init", "-q", "-b", "main"]);
    Repo { _dir: dir, path }
}

fn store(repo: &Repo) -> NotesRepo {
    NotesRepo::open(&LocalHost, &repo.path)
        .unwrap()
        .with_clock(clock)
}

fn review(repo: &Repo) -> ReviewNotes {
    store(repo)
        .review(ReviewTarget::branch("feature/login"))
        .unwrap()
}

fn new_note(line: u32, body: &str) -> NewNote {
    let mut anchor = Anchor::at_line(Side::New, line, None);
    anchor.code = vec![format!("line {line}")];
    NewNote::new("src/cart.ts", anchor, body)
}

fn read_json(path: &str) -> Value {
    serde_json::from_slice(&LocalHost.read_file(path).unwrap()).unwrap()
}

fn write_json(path: &str, value: &Value) {
    LocalHost
        .write_file(
            path,
            serde_json::to_string_pretty(value).unwrap().as_bytes(),
        )
        .unwrap();
}

#[test]
fn finds_the_folder_in_the_git_common_dir_shared_by_worktrees() {
    let repo = repo();
    git(
        &repo.path,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
    );
    let root = store(&repo).root().to_owned();
    assert_eq!(root, format!("{}/.git/codeducky", repo.path));

    let outside = tempfile::tempdir().unwrap();
    let worktree = outside.path().join("wt");
    let worktree = worktree.to_str().unwrap();
    git(
        &repo.path,
        &["worktree", "add", "-q", "-b", "side", worktree],
    );
    assert_eq!(store_at(worktree).root(), root);
}

fn store_at(path: &str) -> NotesRepo {
    NotesRepo::open(&LocalHost, path).unwrap()
}

#[test]
fn reports_a_folder_that_is_not_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let error = NotesRepo::open(&LocalHost, dir.path().to_str().unwrap()).unwrap_err();
    assert!(matches!(error, NotesError::Git { .. }), "{error}");
}

#[test]
fn writes_a_pretty_stable_notes_file_and_the_readme_on_first_write() {
    let repo = repo();
    let review = review(&repo);
    assert!(review.notes(&LocalHost).unwrap().is_empty());
    let readme = store(&repo).readme_path();
    assert!(
        LocalHost.read_file(&readme).is_err(),
        "reading writes nothing"
    );

    let note = review
        .add_note(&LocalHost, new_note(42, "`total` ignores the discount."))
        .unwrap();
    assert_eq!(note.id.as_str().len(), 6);
    assert_eq!((note.created_at, note.updated_at), (clock(), clock()));
    assert!(
        review
            .notes_path()
            .ends_with(".git/codeducky/branches/feature/login/notes.json")
    );

    let text = String::from_utf8(LocalHost.read_file(&review.notes_path()).unwrap()).unwrap();
    let order = [
        "\"about\"",
        "\"version\": 1",
        "\"target\"",
        "\"notes\"",
        "\"id\"",
        "\"status\": \"open\"",
        "\"severity\"",
        "\"path\"",
        "\"anchor\"",
        "\"body\"",
        "\"author\"",
        "\"created_at\": \"2026-11-10T14:05:00Z\"",
        "\"updated_at\"",
    ];
    let positions: Vec<usize> = order
        .iter()
        .map(|key| text.find(key).unwrap_or_else(|| panic!("{key}")))
        .collect();
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{text}");
    assert!(text.ends_with("}\n"));

    let again = review.add_note(&LocalHost, new_note(7, "Second")).unwrap();
    assert_ne!(again.id, note.id);
    let rendered = String::from_utf8(LocalHost.read_file(&review.notes_path()).unwrap()).unwrap();
    assert!(rendered.starts_with(&text[..text.find("\"notes\"").unwrap()]));

    let readme_text = String::from_utf8(LocalHost.read_file(&readme).unwrap()).unwrap();
    assert!(readme_text.contains("## Resolve a note"));
}

#[test]
fn edits_resolves_reopens_and_deletes_notes() {
    let repo = repo();
    let review = review(&repo);
    let note = review
        .add_note(&LocalHost, new_note(3, "Rename x"))
        .unwrap();
    let id = note.id.clone();

    let edited = review
        .edit_note(
            &LocalHost,
            &id,
            NoteEdit {
                severity: Some(Severity::Blocker),
                ..NoteEdit::default()
            },
        )
        .unwrap();
    assert_eq!(
        (edited.body.as_str(), edited.severity),
        ("Rename x", Severity::Blocker)
    );

    let resolved = review
        .resolve_note(
            &LocalHost,
            &id,
            Author::agent("claude-code"),
            Some("Done in a1b2c3".into()),
        )
        .unwrap();
    assert_eq!(resolved.status, NoteStatus::Resolved);
    let on_disk = review.note(&LocalHost, &id).unwrap();
    assert_eq!(on_disk.resolution.unwrap().text, "Done in a1b2c3");

    assert!(review.reopen_note(&LocalHost, &id).unwrap().is_open());
    review.delete_note(&LocalHost, &id).unwrap();
    assert!(matches!(
        review.note(&LocalHost, &id),
        Err(NotesError::NoteNotFound(_))
    ));
    assert!(matches!(
        review.delete_note(&LocalHost, &id),
        Err(NotesError::NoteNotFound(_))
    ));
}

#[test]
fn reads_a_hand_written_file_and_keeps_what_it_does_not_know() {
    let repo = repo();
    let review = review(&repo);
    write_json(
        &review.notes_path(),
        &json!({
            "version": 1,
            "agent_session": "run-17",
            "notes": [
                {"id": "first1", "path": "a.ts", "anchor": {"line": 2}, "body": "Mine", "author": {"kind": "human"},
                 "created_at": "2026-11-10T10:00:00Z", "updated_at": "2026-11-10T10:00:00Z", "ticket": "ENG-12"},
                {"path": "b.ts", "anchor": {"line": 9, "end_line": 11}, "body": "Agent wrote this", "severity": "nit"},
                {"id": "first1", "path": "c.ts", "anchor": {"line": 1}, "body": "Copied a note to add one"}
            ]
        }),
    );

    let notes = review.notes(&LocalHost).unwrap();
    assert_eq!(notes.len(), 3);
    let hand_written = &notes[1];
    assert_eq!(hand_written.author, Author::Agent { name: None });
    assert_eq!(hand_written.status, NoteStatus::Open);
    assert_eq!(hand_written.anchor.last_line(), 11);
    assert!(!hand_written.id.is_empty());
    assert!(!notes[2].id.is_empty() && notes[2].id != notes[0].id);
    let ids: Vec<NoteId> = notes.iter().map(|note| note.id.clone()).collect();
    let reread: Vec<NoteId> = review
        .notes(&LocalHost)
        .unwrap()
        .into_iter()
        .map(|note| note.id)
        .collect();
    assert_eq!(
        ids, reread,
        "derived ids are stable before the file is written"
    );

    review
        .resolve_note(&LocalHost, &ids[1], Author::Human, None)
        .unwrap();

    let file = read_json(&review.notes_path());
    assert_eq!(file["agent_session"], "run-17");
    assert_eq!(
        file["target"],
        json!({"kind": "branch", "branch": "feature/login"})
    );
    assert_eq!(file["notes"][0]["ticket"], "ENG-12");
    assert_eq!(file["notes"][1]["id"], json!(ids[1].as_str()));
    assert_eq!(file["notes"][1]["status"], "resolved");
    assert_eq!(file["notes"][1]["created_at"], "2026-11-10T14:05:00Z");
    assert_eq!(file["notes"][2]["id"], json!(ids[2].as_str()));
    assert_eq!(file["notes"][0]["updated_at"], "2026-11-10T10:00:00Z");
}

#[test]
fn reports_a_malformed_file_and_never_overwrites_it() {
    let repo = repo();
    let review = review(&repo);
    let path = review.notes_path();
    let broken =
        b"{\n  \"version\": 1,\n  \"notes\": [\n    {\"id\": \"a\", \"path\": \"x\",}\n  ]\n}\n";
    LocalHost.write_file(&path, broken).unwrap();

    let error = review.notes(&LocalHost).unwrap_err();
    let message = error.to_string();
    assert!(matches!(error, NotesError::Malformed { .. }));
    assert!(
        message.contains("notes.json") && message.contains("line 4"),
        "{message}"
    );
    assert!(review.add_note(&LocalHost, new_note(1, "x")).is_err());
    assert_eq!(LocalHost.read_file(&path).unwrap(), broken);

    write_json(
        &path,
        &json!({"notes": [
            {"id": "ok1", "path": "a", "anchor": {"line": 1}},
            {"id": "bad2", "path": "a", "anchor": {"line": 1}, "severity": "critical"}
        ]}),
    );
    let message = review.notes(&LocalHost).unwrap_err().to_string();
    assert!(
        message.contains("note 2 (id bad2)") && message.contains("critical"),
        "{message}"
    );

    write_json(
        &path,
        &json!({"notes": [{"id": "x", "anchor": {"line": 1}}]}),
    );
    assert!(
        review
            .notes(&LocalHost)
            .unwrap_err()
            .to_string()
            .contains("missing field `path`")
    );

    write_json(&path, &json!({"version": 2, "notes": []}));
    assert!(matches!(
        review.notes(&LocalHost),
        Err(NotesError::NewerVersion { found: 2, .. })
    ));
    assert!(review.add_note(&LocalHost, new_note(1, "x")).is_err());
    assert_eq!(read_json(&path)["version"], 2);
}

#[test]
fn refuses_a_file_that_belongs_to_another_review() {
    let repo = repo();
    let review = review(&repo);
    write_json(
        &review.notes_path(),
        &json!({"target": {"kind": "pull_request", "number": 3}, "notes": []}),
    );
    assert!(matches!(
        review.notes(&LocalHost),
        Err(NotesError::WrongTarget { .. })
    ));
}

/// A host on which an agent edits one file right after the app's first read of it, as if it
/// saved between the app's read and write.
struct AgentEditsMidway {
    path: String,
    edit: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    reads: AtomicUsize,
    writes: AtomicUsize,
}

impl AgentEditsMidway {
    fn new(path: String, edit: impl FnOnce() + Send + 'static) -> Self {
        Self {
            path,
            edit: Mutex::new(Some(Box::new(edit))),
            reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
        }
    }
}

impl Host for AgentEditsMidway {
    fn name(&self) -> &str {
        "racing"
    }

    fn exec(&self, request: ExecRequest) -> Result<ExecOutput, HostError> {
        LocalHost.exec(request)
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError> {
        let bytes = LocalHost.read_file(path);
        if path == self.path {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if let Some(edit) = self.edit.lock().unwrap().take() {
                edit();
            }
        }
        bytes
    }

    fn write_file(&self, path: &str, data: &[u8]) -> Result<(), HostError> {
        if path == self.path {
            self.writes.fetch_add(1, Ordering::SeqCst);
        }
        LocalHost.write_file(path, data)
    }
}

#[test]
fn an_agent_edit_landing_between_read_and_write_is_merged_not_lost() {
    let repo = repo();
    let review = review(&repo);
    let first = review
        .add_note(&LocalHost, new_note(1, "Fix this"))
        .unwrap();
    let path = review.notes_path();

    let agent_path = path.clone();
    let host = AgentEditsMidway::new(path.clone(), move || {
        let mut file = read_json(&agent_path);
        file["notes"][0]["status"] = json!("resolved");
        file["notes"][0]["resolution"] = json!({"by": {"kind": "agent", "name": "codex"}, "text": "Fixed", "at": "2026-11-10T15:00:00Z"});
        file["notes"][0]["updated_at"] = json!("2026-11-10T15:00:00Z");
        write_json(&agent_path, &file);
    });
    let second = review.add_note(&host, new_note(2, "And this")).unwrap();

    let notes = review.notes(&LocalHost).unwrap();
    assert_eq!(notes.len(), 2);
    assert_eq!(notes[0].id, first.id);
    assert_eq!(notes[0].status, NoteStatus::Resolved);
    assert_eq!(notes[1].id, second.id);
    assert!(
        host.reads.load(Ordering::SeqCst) >= 3,
        "re-read after the conflict"
    );
    assert_eq!(host.writes.load(Ordering::SeqCst), 1);
}

/// Every read sees a different file, as if something rewrote it constantly.
struct AlwaysChanging(AtomicUsize);

impl Host for AlwaysChanging {
    fn name(&self) -> &str {
        "busy"
    }

    fn exec(&self, request: ExecRequest) -> Result<ExecOutput, HostError> {
        LocalHost.exec(request)
    }

    fn read_file(&self, _: &str) -> Result<Vec<u8>, HostError> {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        Ok(format!("{{\"version\": 1, \"notes\": [], \"n\": {n}}}").into_bytes())
    }

    fn write_file(&self, path: &str, _: &[u8]) -> Result<(), HostError> {
        panic!("wrote {path}");
    }
}

#[test]
fn gives_up_rather_than_overwrite_a_file_that_keeps_changing() {
    let review = NotesRepo::at("/nowhere/codeducky")
        .review(ReviewTarget::pull_request(1))
        .unwrap();
    let error = review
        .add_note(&AlwaysChanging(AtomicUsize::new(0)), new_note(1, "x"))
        .unwrap_err();
    assert!(matches!(error, NotesError::Contended { .. }));
}

#[test]
fn edits_apply_to_the_fresh_file_so_an_agents_earlier_edit_survives() {
    let repo = repo();
    let review = review(&repo);
    let note = review
        .add_note(&LocalHost, new_note(1, "Original"))
        .unwrap();

    let mut file = read_json(&review.notes_path());
    file["notes"][0]["body"] = json!("Clarified by the agent");
    write_json(&review.notes_path(), &file);

    let edited = review
        .edit_note(
            &LocalHost,
            &note.id,
            NoteEdit {
                severity: Some(Severity::Nit),
                ..NoteEdit::default()
            },
        )
        .unwrap();
    assert_eq!(
        (edited.body.as_str(), edited.severity),
        ("Clarified by the agent", Severity::Nit)
    );
}

#[test]
fn saving_a_stale_set_merges_per_note_with_what_the_agent_wrote() {
    let repo = repo();
    let review = review(&repo);
    let a = review.add_note(&LocalHost, new_note(1, "a")).unwrap();
    let b = review.add_note(&LocalHost, new_note(2, "b")).unwrap();
    let base = review.notes(&LocalHost).unwrap();

    let mut file = read_json(&review.notes_path());
    file["notes"][0]["status"] = json!("resolved");
    file["notes"][0]["updated_at"] = json!("2026-11-10T16:00:00Z");
    let added = json!({"id": "agent1", "path": "z.ts", "anchor": {"line": 4}, "body": "Found while fixing"});
    file["notes"].as_array_mut().unwrap().push(added);
    write_json(&review.notes_path(), &file);

    let mut ours = base.clone();
    ours[1].body = "b, edited in the app".into();
    ours[1].updated_at = Timestamp::utc(2026, 11, 10, 15, 0);

    let merged = review.save_notes(&LocalHost, &base, &ours).unwrap();
    let summary: Vec<_> = merged
        .iter()
        .map(|n| (n.id.as_str(), n.status, n.body.as_str()))
        .collect();
    assert_eq!(
        summary,
        [
            (a.id.as_str(), NoteStatus::Resolved, "a"),
            (b.id.as_str(), NoteStatus::Open, "b, edited in the app"),
            ("agent1", NoteStatus::Open, "Found while fixing"),
        ]
    );
    assert_eq!(review.notes(&LocalHost).unwrap(), merged);
}

#[test]
fn reanchoring_moves_notes_without_counting_as_an_edit() {
    let repo = repo();
    let review = review(&repo);
    let note = review.add_note(&LocalHost, new_note(3, "x")).unwrap();
    let mut moved = note.anchor.clone();
    moved.line = 5;
    let updates = [
        NoteUpdate {
            id: note.id.clone(),
            anchor: moved,
            anchor_lost: false,
        },
        NoteUpdate {
            id: NoteId::from("gone99"),
            anchor: Anchor::default(),
            anchor_lost: true,
        },
    ];
    review.apply_reanchoring(&LocalHost, &updates).unwrap();
    let stored = review.note(&LocalHost, &note.id).unwrap();
    assert_eq!(stored.anchor.line, 5);
    assert_eq!(stored.updated_at, note.updated_at);
}

#[test]
fn keeps_viewed_marks_last_look_and_checklist_ticks_in_the_state_file() {
    let repo = repo();
    let review = review(&repo);
    let change = FileChange::new("src/cart.ts", Some("b1"), Some("n1"));
    review.mark_viewed(&LocalHost, &change, true, None).unwrap();
    review
        .record_review_head(&LocalHost, "src/cart.ts", "h1")
        .unwrap();
    review
        .set_checked(&LocalHost, &ChecklistItemId::from("i1"), true)
        .unwrap();

    let state = review.state(&LocalHost).unwrap();
    assert!(state.is_viewed(&change));
    assert_eq!(state.started_at, Some(clock()));
    assert_eq!(state.last_review.as_ref().unwrap().head, "h1");
    assert!(state.is_checked(&ChecklistItemId::from("i1")));
    assert_eq!(
        state.last_looks()["src/cart.ts"].head.as_deref(),
        Some("h1")
    );

    let file = read_json(&review.state_path());
    assert_eq!(file["files"]["src/cart.ts"]["content_hash"], "b1:n1");
    assert_eq!(file["checked"], json!(["i1"]));

    review
        .record_reviewed_files(&LocalHost, "h2", std::slice::from_ref(&change))
        .unwrap();
    assert_eq!(
        review.state(&LocalHost).unwrap().last_review.unwrap().head,
        "h2"
    );
}

#[test]
fn keeps_the_repos_checklists() {
    let repo = repo();
    let store = store(&repo);
    let added = store
        .add_checklists(
            &LocalHost,
            vec![ChecklistDraft {
                title: "Before push".into(),
                items: vec!["Tests pass".into(), "No logs".into()],
                required: true,
            }],
        )
        .unwrap();
    let mut checklist = added[0].clone();
    assert_eq!(store.checklists(&LocalHost).unwrap(), added);
    assert_ne!(checklist.items[0].id, checklist.items[1].id);

    checklist.title = "Before merge".into();
    store.save_checklist(&LocalHost, checklist.clone()).unwrap();
    assert_eq!(
        store.checklists(&LocalHost).unwrap()[0].title,
        "Before merge"
    );
    store.delete_checklist(&LocalHost, &checklist.id).unwrap();
    assert!(store.checklists(&LocalHost).unwrap().is_empty());
    assert!(store.delete_checklist(&LocalHost, &checklist.id).is_err());
}

#[test]
fn keeps_pull_request_reviews_apart_from_branches() {
    let repo = repo();
    let pull = store(&repo).review(ReviewTarget::pull_request(12)).unwrap();
    pull.add_note(&LocalHost, new_note(1, "On the PR")).unwrap();
    assert!(pull.notes_path().ends_with("codeducky/pulls/12/notes.json"));
    assert!(review(&repo).notes(&LocalHost).unwrap().is_empty());
}
