//! Airflow keys in the shared OS secret store (see crate::secrets).

pub use crate::secrets::{fernet_key, random_secret, MemoryStore, OsStore, SecretStore};

/// Key of an instance's credential (password or static API token).
pub fn instance_key(id: &str) -> String {
    format!("airflow:{id}")
}

/// Key of a local environment secret (admin password, JWT secret, Fernet key).
pub fn env_key(slug: &str, what: &str) -> String {
    format!("airflow-env:{slug}:{what}")
}

