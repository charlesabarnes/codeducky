use std::collections::HashSet;
use std::hash::{BuildHasher, Hasher, RandomState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use ducky_review::ids::{short_id, stable_hash};
use ducky_review::{Note, NoteId};

use crate::record::Record;

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn random_seed() -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    hasher.write_u128(nanos);
    hasher.finish()
}

/// A new short id that `taken` does not already hold.
pub fn fresh_id(taken: impl Fn(&str) -> bool) -> String {
    loop {
        let id = short_id(random_seed());
        if !taken(&id) {
            return id;
        }
    }
}

/// Gives notes without an id, or with an id an earlier note already has (a copied note), an id
/// derived from their content: the same on every read, so the note can be addressed before the
/// file is next written.
pub fn assign_missing_ids(records: &mut [Record<Note>]) {
    let mut seen: HashSet<NoteId> = HashSet::new();
    for record in records {
        let note = &mut record.value;
        if note.id.is_empty() || seen.contains(&note.id) {
            let line = note.anchor.line.to_string();
            let derived = (0u32..)
                .map(|salt| {
                    let parts = [
                        note.id.as_str(),
                        &note.path,
                        &line,
                        &note.body,
                        &salt.to_string(),
                    ];
                    NoteId::new(short_id(stable_hash(&parts)))
                })
                .find(|candidate| !seen.contains(candidate))
                .expect("an unused id");
            note.id = derived;
        }
        seen.insert(note.id.clone());
    }
}
