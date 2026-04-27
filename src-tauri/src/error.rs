use serde::ser::SerializeMap;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("keychain error: {0}")]
    Keyring(String),
    #[error("http error: {0}")]
    Http(String),
    #[error("jira error ({status}): {message}")]
    Jira { status: u16, message: String },
    #[error("ai error: {0}")]
    Ai(String),
    #[error("voice error: {0}")]
    Voice(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("{0}")]
    Other(String),
}

// Errors are serialized as a tagged JSON object so the frontend can branch on
// `kind` and render OS-specific guidance instead of a generic "something went
// wrong". The plain text from `Display` is also included as `message` for
// callers that just want a string.
//
// Shape:
//   { kind: "keyring",  message, os }                  // os = "macos" | "windows" | "linux" | …
//   { kind: "http",     message }
//   { kind: "jira",     message, status }
//   { kind: "ai",       message }
//   { kind: "voice",    message }
//   { kind: "io",       message }
//   { kind: "invalid",  message }
//   { kind: "other",    message }
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(None)?;
        match self {
            AppError::Keyring(msg) => {
                m.serialize_entry("kind", "keyring")?;
                m.serialize_entry("message", msg)?;
                m.serialize_entry("os", std::env::consts::OS)?;
            }
            AppError::Http(msg) => {
                m.serialize_entry("kind", "http")?;
                m.serialize_entry("message", msg)?;
            }
            AppError::Jira { status, message } => {
                m.serialize_entry("kind", "jira")?;
                m.serialize_entry("status", status)?;
                m.serialize_entry("message", message)?;
            }
            AppError::Ai(msg) => {
                m.serialize_entry("kind", "ai")?;
                m.serialize_entry("message", msg)?;
            }
            AppError::Voice(msg) => {
                m.serialize_entry("kind", "voice")?;
                m.serialize_entry("message", msg)?;
            }
            AppError::Io(msg) => {
                m.serialize_entry("kind", "io")?;
                m.serialize_entry("message", msg)?;
            }
            AppError::Invalid(msg) => {
                m.serialize_entry("kind", "invalid")?;
                m.serialize_entry("message", msg)?;
            }
            AppError::Other(msg) => {
                m.serialize_entry("kind", "other")?;
                m.serialize_entry("message", msg)?;
            }
        }
        m.end()
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self { AppError::Keyring(e.to_string()) }
}
impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self { AppError::Http(e.to_string()) }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self { AppError::Io(e.to_string()) }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self { AppError::Other(format!("json: {e}")) }
}
impl From<url::ParseError> for AppError {
    fn from(e: url::ParseError) -> Self { AppError::Invalid(format!("url: {e}")) }
}

pub type AppResult<T> = std::result::Result<T, AppError>;
