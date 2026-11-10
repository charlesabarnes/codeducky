//! Where the fallback GitHub token (a personal access token pasted in settings) is kept: the
//! macOS Keychain. Elsewhere, and in dev runs, it lives in memory for the session only. Never in
//! the preferences file, never logged.

use std::sync::{Arc, Mutex};

use ducky_github::Token;

const SERVICE: &str = "dev.codeducky.github-token";
#[cfg(target_os = "macos")]
const ACCOUNT: &str = "github.com";

#[derive(Clone)]
pub enum TokenStore {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Keychain {
        service: String,
    },
    Memory(Arc<Mutex<Option<String>>>),
}

impl TokenStore {
    /// The Keychain on macOS; memory elsewhere until a Secret Service store is wired.
    pub fn platform() -> Self {
        if cfg!(target_os = "macos") {
            Self::Keychain {
                service: SERVICE.into(),
            }
        } else {
            Self::memory()
        }
    }

    pub fn memory() -> Self {
        Self::Memory(Arc::default())
    }

    /// Whether a saved token outlives the app.
    pub fn persists(&self) -> bool {
        matches!(self, Self::Keychain { .. })
    }

    /// Blocking on macOS (a Keychain call): run it off the UI thread.
    pub fn load(&self) -> Result<Option<Token>, String> {
        match self {
            Self::Memory(slot) => Ok(lock(slot).clone().and_then(Token::new)),
            Self::Keychain { service } => keychain::load(service),
        }
    }

    pub fn save(&self, token: &str) -> Result<(), String> {
        let token = token.trim();
        if token.is_empty() {
            return Err("paste a token first".into());
        }
        match self {
            Self::Memory(slot) => {
                *lock(slot) = Some(token.to_owned());
                Ok(())
            }
            Self::Keychain { service } => keychain::save(service, token),
        }
    }

    pub fn clear(&self) -> Result<(), String> {
        match self {
            Self::Memory(slot) => {
                *lock(slot) = None;
                Ok(())
            }
            Self::Keychain { service } => keychain::clear(service),
        }
    }
}

fn lock(slot: &Mutex<Option<String>>) -> std::sync::MutexGuard<'_, Option<String>> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::ACCOUNT;
    use ducky_github::Token;
    use security_framework::passwords;

    const NOT_FOUND: i32 = -25300;

    pub fn load(service: &str) -> Result<Option<Token>, String> {
        match passwords::get_generic_password(service, ACCOUNT) {
            Ok(bytes) => Ok(String::from_utf8(bytes).ok().and_then(Token::new)),
            Err(error) if error.code() == NOT_FOUND => Ok(None),
            Err(error) => Err(format!("Keychain: {error}")),
        }
    }

    pub fn save(service: &str, token: &str) -> Result<(), String> {
        passwords::set_generic_password(service, ACCOUNT, token.as_bytes())
            .map_err(|error| format!("Keychain: {error}"))
    }

    pub fn clear(service: &str) -> Result<(), String> {
        match passwords::delete_generic_password(service, ACCOUNT) {
            Err(error) if error.code() != NOT_FOUND => Err(format!("Keychain: {error}")),
            _ => Ok(()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use ducky_github::Token;

    pub fn load(_: &str) -> Result<Option<Token>, String> {
        Ok(None)
    }

    pub fn save(_: &str, _: &str) -> Result<(), String> {
        Err("no keychain on this platform yet".into())
    }

    pub fn clear(_: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_keeps_a_token_for_the_session() {
        let store = TokenStore::memory();
        assert!(store.load().unwrap().is_none());
        assert!(store.save("  ").is_err());
        store.save("github_pat_x").unwrap();
        assert!(store.load().unwrap().is_some());
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
        assert!(!store.persists());
    }

    /// Writes a throwaway Keychain item and removes it. Opt in: it may prompt, and fails while
    /// the screen is locked. `cargo test -p codeducky keychain -- --ignored`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "touches the login Keychain"]
    fn keychain_round_trip_on_a_throwaway_service() {
        let store = TokenStore::Keychain {
            service: format!("dev.codeducky.test-{}", std::process::id()),
        };
        store.save("github_pat_test_only").unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(format!("{loaded:?}"), "Token(***)");
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
        store.clear().unwrap();
    }
}
