use std::fmt;

use serde::{Deserialize, Serialize};

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn is_empty(&self) -> bool {
                self.0.is_empty()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }
    };
}

string_id!(
    /// A note's short, stable id, e.g. `k3x9qa`.
    NoteId
);
string_id!(ChecklistId);
string_id!(ChecklistItemId);
string_id!(
    /// A git blob object id.
    Oid
);

/// Lower-case letters and digits without the look-alikes 0, 1, i, l and o.
const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
pub const SHORT_ID_LEN: usize = 6;

/// A short id from 64 bits of seed: random bits for a new id, or a hash for a stable derived one.
pub fn short_id(mut seed: u64) -> String {
    let base = ALPHABET.len() as u64;
    (0..SHORT_ID_LEN)
        .map(|_| {
            let digit = ALPHABET[(seed % base) as usize] as char;
            seed /= base;
            digit
        })
        .collect()
}

/// FNV-1a, for ids that must come out the same on every read of the same text.
pub fn stable_hash(parts: &[&str]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in part.bytes().chain([0xff]) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_ids_are_six_unambiguous_characters() {
        for seed in [0, 1, u64::MAX, 0xdead_beef] {
            let id = short_id(seed);
            assert_eq!(id.len(), SHORT_ID_LEN);
            assert!(id.bytes().all(|b| ALPHABET.contains(&b)));
        }
        assert_ne!(short_id(1), short_id(2));
    }

    #[test]
    fn stable_hash_separates_parts() {
        assert_eq!(stable_hash(&["a", "b"]), stable_hash(&["a", "b"]));
        assert_ne!(stable_hash(&["ab", ""]), stable_hash(&["a", "b"]));
    }
}
