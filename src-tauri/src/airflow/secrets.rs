//! Secret storage for the Airflow plugin: the OS store (macOS Keychain, Windows Credential
//! Manager) through `keyring`. Secrets never go to JSON files, logs or the frontend.

use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "dev.rits.ide";

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// The operating system credential store.
pub struct OsStore;

impl SecretStore for OsStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let e = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Não foi possível ler o cofre de senhas do sistema: {e}")),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let e = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        e.set_password(value).map_err(|e| format!("Não foi possível gravar no cofre de senhas do sistema: {e}"))
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        let e = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
        Ok(())
    }
}

/// Key of an instance's credential (password or static API token).
pub fn instance_key(id: &str) -> String {
    format!("airflow:{id}")
}

/// Key of a local environment secret (admin password, JWT secret, Fernet key).
pub fn env_key(slug: &str, what: &str) -> String {
    format!("airflow-env:{slug}:{what}")
}

/// URL-safe random string from the OS RNG.
pub fn random_secret(bytes: usize) -> Result<String, String> {
    use base64::Engine;
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

/// Fernet keys are 32 random bytes, URL-safe base64 *with* padding.
pub fn fernet_key() -> Result<String, String> {
    use base64::Engine;
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE.encode(buf))
}
