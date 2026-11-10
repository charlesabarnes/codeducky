use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use crate::client::Client;
use crate::error::Result;
use crate::remote::RepoRef;

const DEFAULT_CAPACITY: usize = 300;

#[derive(Debug, Default)]
struct Entries {
    blobs: HashMap<String, Arc<Vec<u8>>>,
    order: VecDeque<String>,
}

/// Blobs by id, kept in memory. A blob id names its content, so entries never go stale; the
/// oldest are dropped past the capacity.
#[derive(Debug)]
pub struct BlobCache {
    capacity: usize,
    entries: Mutex<Entries>,
}

impl Default for BlobCache {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl BlobCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: Mutex::default(),
        }
    }

    pub fn get(&self, oid: &str) -> Option<Arc<Vec<u8>>> {
        self.entries.lock().ok()?.blobs.get(oid).cloned()
    }

    fn insert(&self, oid: &str, bytes: Arc<Vec<u8>>) {
        let Ok(mut guard) = self.entries.lock() else {
            return;
        };
        let Entries { blobs: map, order } = &mut *guard;
        if map.insert(oid.to_owned(), bytes).is_none() {
            order.push_back(oid.to_owned());
        }
        while order.len() > self.capacity {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            }
        }
    }

    /// From memory, else from GitHub.
    pub fn load(&self, client: &Client, repo: &RepoRef, oid: &str) -> Result<Arc<Vec<u8>>> {
        if let Some(bytes) = self.get(oid) {
            return Ok(bytes);
        }
        let bytes = Arc::new(client.blob(repo, oid)?);
        self.insert(oid, bytes.clone());
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_the_oldest_past_capacity() {
        let cache = BlobCache::new(2);
        for oid in ["a", "b", "c"] {
            cache.insert(oid, Arc::new(oid.as_bytes().to_vec()));
        }
        assert!(cache.get("a").is_none());
        assert_eq!(cache.get("c").unwrap().as_slice(), b"c");
    }
}
