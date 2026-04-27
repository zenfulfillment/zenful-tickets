use crate::error::{AppError, AppResult};
use keyring::Entry;
use serde::{Deserialize, Serialize};

// Single macOS Keychain item to minimise auth prompts. All secrets live inside
// this JSON blob. Reading/writing the one entry triggers at most one OS prompt
// per session; the user's "Always Allow" choice silences subsequent access.
const SERVICE: &str = "com.zenfulfillment.zenfultickets";
const ACCOUNT: &str = "secrets";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Secrets {
    #[serde(default)]
    pub jira_site: Option<String>, // e.g. "acme.atlassian.net"
    #[serde(default)]
    pub jira_email: Option<String>,
    #[serde(default)]
    pub jira_token: Option<String>,
    #[serde(default)]
    pub gemini_key: Option<String>,
    #[serde(default)]
    pub anthropic_key: Option<String>,
    #[serde(default)]
    pub openai_key: Option<String>,
    #[serde(default)]
    pub openrouter_key: Option<String>,
}

fn entry() -> AppResult<Entry> {
    Entry::new(SERVICE, ACCOUNT).map_err(AppError::from)
}

pub fn load() -> AppResult<Secrets> {
    match entry()?.get_password() {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        Err(keyring::Error::NoEntry) => Ok(Secrets::default()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

pub fn save(secrets: &Secrets) -> AppResult<()> {
    let raw = serde_json::to_string(secrets)?;
    entry()?.set_password(&raw).map_err(AppError::from)
}

pub fn clear() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

/// Merge patch into stored secrets and persist. Fields set to `None` in the
/// patch are left unchanged; pass `""` (empty string) to clear an individual field.
pub fn update(patch: Secrets) -> AppResult<Secrets> {
    let mut current = load()?;
    macro_rules! apply {
        ($($f:ident),*) => {
            $(
                if let Some(v) = patch.$f {
                    current.$f = if v.is_empty() { None } else { Some(v) };
                }
            )*
        };
    }
    apply!(jira_site, jira_email, jira_token, gemini_key, anthropic_key, openai_key, openrouter_key);
    save(&current)?;
    Ok(current)
}

/// View exposed to the UI — never ship raw secret values down to the webview.
/// We return "presence" flags plus any non-sensitive identifiers (site, email).
#[derive(Debug, Serialize)]
pub struct SecretsStatus {
    pub jira_site: Option<String>,
    pub jira_email: Option<String>,
    pub has_jira_token: bool,
    pub has_gemini_key: bool,
    pub has_anthropic_key: bool,
    pub has_openai_key: bool,
    pub has_openrouter_key: bool,
}

impl From<&Secrets> for SecretsStatus {
    fn from(s: &Secrets) -> Self {
        SecretsStatus {
            jira_site: s.jira_site.clone(),
            jira_email: s.jira_email.clone(),
            has_jira_token: s.jira_token.as_deref().is_some_and(|t| !t.is_empty()),
            has_gemini_key: s.gemini_key.as_deref().is_some_and(|t| !t.is_empty()),
            has_anthropic_key: s.anthropic_key.as_deref().is_some_and(|t| !t.is_empty()),
            has_openai_key: s.openai_key.as_deref().is_some_and(|t| !t.is_empty()),
            has_openrouter_key: s.openrouter_key.as_deref().is_some_and(|t| !t.is_empty()),
        }
    }
}
