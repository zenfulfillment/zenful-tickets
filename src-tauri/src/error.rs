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

// Serialize errors as plain strings so the frontend sees a readable message.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
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
