use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::AppState;
use base64::Engine;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

pub mod adf;

/// Build the base URL from a workspace host like "acme.atlassian.net".
fn base_url(site: &str) -> AppResult<String> {
    let trimmed = site.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::Invalid("jira site is empty".into()));
    }
    // Accept either "acme" or "acme.atlassian.net" or full URL.
    let host = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = if host.contains('.') {
        host.to_string()
    } else {
        format!("{host}.atlassian.net")
    };
    Ok(format!("https://{host}"))
}

fn auth_header(email: &str, token: &str) -> AppResult<HeaderValue> {
    let raw = format!("{email}:{token}");
    let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
    let mut v = HeaderValue::from_str(&format!("Basic {encoded}"))
        .map_err(|e| AppError::Invalid(format!("auth header: {e}")))?;
    v.set_sensitive(true);
    Ok(v)
}

struct JiraCtx {
    base: String,
    headers: HeaderMap,
}

fn build_ctx() -> AppResult<JiraCtx> {
    let s = secrets::load()?;
    let site = s
        .jira_site
        .as_deref()
        .ok_or_else(|| AppError::Invalid("jira site not configured".into()))?;
    let email = s
        .jira_email
        .as_deref()
        .ok_or_else(|| AppError::Invalid("jira email not configured".into()))?;
    let token = s
        .jira_token
        .as_deref()
        .ok_or_else(|| AppError::Invalid("jira token not configured".into()))?;
    let base = base_url(site)?;
    let mut headers = HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, auth_header(email, token)?);
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    Ok(JiraCtx { base, headers })
}

fn request(state: &AppState, method: Method, path: &str) -> AppResult<RequestBuilder> {
    let ctx = build_ctx()?;
    Ok(state
        .http
        .request(method, format!("{}{}", ctx.base, path))
        .headers(ctx.headers))
}

async fn decode<T: for<'de> Deserialize<'de>>(resp: reqwest::Response) -> AppResult<T> {
    let status = resp.status();
    if status.is_success() {
        resp.json::<T>().await.map_err(AppError::from)
    } else {
        let message = resp.text().await.unwrap_or_default();
        Err(AppError::Jira {
            status: status.as_u16(),
            message: truncate(&message, 400),
        })
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..n]) }
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct JiraUser {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(default, rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(default, rename = "emailAddress")]
    pub email: Option<String>,
    #[serde(default, rename = "avatarUrls")]
    pub avatar_urls: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JiraProject {
    pub id: String,
    pub key: String,
    pub name: String,
    #[serde(default, rename = "projectTypeKey")]
    pub project_type_key: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default, rename = "avatarUrls")]
    pub avatar_urls: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JiraIssueType {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "iconUrl")]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub subtask: bool,
    #[serde(default, rename = "hierarchyLevel")]
    pub hierarchy_level: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JiraPriority {
    pub id: String,
    pub name: String,
    #[serde(default, rename = "iconUrl")]
    pub icon_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JiraEpic {
    pub id: String,
    pub key: String,
    pub summary: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateIssueRequest {
    pub project_key: String,
    pub summary: String,
    /// Markdown description. We convert to ADF on the Rust side.
    pub description_markdown: String,
    pub issue_type_id: String,
    pub priority_id: Option<String>,
    pub labels: Option<Vec<String>>,
    pub epic_key: Option<String>,
    pub assignee_account_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateIssueResponse {
    pub id: String,
    pub key: String,
    #[serde(rename = "self")]
    pub self_url: String,
    /// Browser URL. Not returned by Jira; we compute it from the site.
    #[serde(default)]
    pub browse_url: Option<String>,
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn jira_verify(state: State<'_, AppState>) -> AppResult<JiraUser> {
    let resp = request(&state, Method::GET, "/rest/api/3/myself")?
        .send()
        .await?;
    decode(resp).await
}

#[tauri::command]
pub async fn jira_current_user(state: State<'_, AppState>) -> AppResult<JiraUser> {
    jira_verify(state).await
}

#[tauri::command]
pub async fn jira_list_projects(state: State<'_, AppState>) -> AppResult<Vec<JiraProject>> {
    #[derive(Deserialize)]
    struct Paged {
        values: Vec<JiraProject>,
    }
    let resp = request(
        &state,
        Method::GET,
        "/rest/api/3/project/search?maxResults=100&orderBy=+name",
    )?
    .send()
    .await?;
    let page: Paged = decode(resp).await?;
    Ok(page.values)
}

#[tauri::command]
pub async fn jira_list_issue_types(
    state: State<'_, AppState>,
    project_id_or_key: String,
) -> AppResult<Vec<JiraIssueType>> {
    let path = format!(
        "/rest/api/3/issue/createmeta/{}/issuetypes",
        urlencoding_encode(&project_id_or_key)
    );
    #[derive(Deserialize)]
    struct Paged {
        #[serde(rename = "issueTypes")]
        issue_types: Vec<JiraIssueType>,
    }
    let resp = request(&state, Method::GET, &path)?.send().await?;
    let page: Paged = decode(resp).await?;
    Ok(page.issue_types)
}

#[tauri::command]
pub async fn jira_list_priorities(state: State<'_, AppState>) -> AppResult<Vec<JiraPriority>> {
    let resp = request(&state, Method::GET, "/rest/api/3/priority")?
        .send()
        .await?;
    decode(resp).await
}

/// Search Jira users by query string. Used by the Draft screen's Assignee
/// selector — empty query returns the most recently active assignable users
/// (Atlassian's API behaviour for `/user/search?query=`).
///
/// We deliberately use `/user/search` (not `/user/assignable/search`) because
/// the latter requires an issue key or project context, which isn't reliable
/// when the project is in flux during drafting. The frontend filters out
/// inactive accounts and pre-pends the current user when settings.autoAssign
/// is on, so the picker behaviour stays sensible regardless.
#[tauri::command]
pub async fn jira_search_users(
    state: State<'_, AppState>,
    query: String,
) -> AppResult<Vec<JiraUser>> {
    let path = format!(
        "/rest/api/3/user/search?query={}&maxResults=20",
        urlencoding_encode(&query),
    );
    let resp = request(&state, Method::GET, &path)?.send().await?;
    decode(resp).await
}

/// Returns issues of type Epic for a given project. Uses JQL.
#[tauri::command]
pub async fn jira_list_epics(
    state: State<'_, AppState>,
    project_key: String,
) -> AppResult<Vec<JiraEpic>> {
    let jql = format!(
        "project = \"{}\" AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC",
        project_key.replace('"', "")
    );
    let body = json!({
        "jql": jql,
        "fields": ["summary"],
        "maxResults": 50,
    });
    let resp = request(&state, Method::POST, "/rest/api/3/search")?
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await?;
    #[derive(Deserialize)]
    struct SearchResp {
        issues: Vec<SearchIssue>,
    }
    #[derive(Deserialize)]
    struct SearchIssue {
        id: String,
        key: String,
        fields: Value,
    }
    let search: SearchResp = decode(resp).await?;
    Ok(search
        .issues
        .into_iter()
        .map(|i| JiraEpic {
            id: i.id,
            key: i.key,
            summary: i
                .fields
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn jira_create_issue(
    state: State<'_, AppState>,
    req: CreateIssueRequest,
) -> AppResult<CreateIssueResponse> {
    log::info!(
        "jira_create_issue: project={} type_id={} priority={:?} epic={:?} labels={} desc_len={}",
        req.project_key,
        req.issue_type_id,
        req.priority_id,
        req.epic_key,
        req.labels.as_ref().map(|l| l.len()).unwrap_or(0),
        req.description_markdown.len()
    );
    let s = secrets::load()?;
    let site = s
        .jira_site
        .as_deref()
        .ok_or_else(|| AppError::Invalid("jira site not configured".into()))?;
    let base = base_url(site)?;

    let description = adf::markdown_to_adf(&req.description_markdown);

    let mut fields = serde_json::Map::new();
    fields.insert("project".into(), json!({ "key": req.project_key }));
    fields.insert("summary".into(), json!(req.summary));
    fields.insert("description".into(), description);
    fields.insert("issuetype".into(), json!({ "id": req.issue_type_id }));
    if let Some(p) = req.priority_id {
        fields.insert("priority".into(), json!({ "id": p }));
    }
    if let Some(labels) = req.labels {
        fields.insert("labels".into(), json!(labels));
    }
    if let Some(a) = req.assignee_account_id {
        fields.insert("assignee".into(), json!({ "accountId": a }));
    }
    if let Some(epic_key) = req.epic_key {
        // Modern Jira Cloud: parent link works for team-managed + company-managed
        // projects on next-gen boards.
        fields.insert("parent".into(), json!({ "key": epic_key }));
    }

    let body = json!({ "fields": fields });
    let resp = request(&state, Method::POST, "/rest/api/3/issue")?
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await?;
    let mut created: CreateIssueResponse = decode(resp).await?;
    created.browse_url = Some(format!("{base}/browse/{}", created.key));
    log::info!("jira_create_issue ok: key={} url={:?}", created.key, created.browse_url);
    Ok(created)
}

/// Create a single sub-task linked to a parent issue.
///
/// Atlassian Cloud expects sub-tasks via the same `/rest/api/3/issue`
/// endpoint as regular issues, with two key differences:
///   - `fields.issuetype` must reference an issue type whose `subtask`
///     flag is `true` (the project's "Sub-task" / "Subtask" type).
///   - `fields.parent.key` (or `id`) references the parent issue's key.
///
/// We surface this as its own command (rather than batching) so the
/// frontend modal can drive step-by-step progress rendering — one POST
/// per visible "Creating subtask 3 of 5" tick. Sequential calls also
/// keep us comfortably under Atlassian's rate limits on small Cloud
/// instances; batching wouldn't buy us anything for the typical 3–8
/// subtasks per ticket.
///
/// Other fields (priority, labels, assignee) are intentionally NOT
/// inherited from the parent here — the caller can pass them in per
/// subtask if/when we add UI for it. For v1 we only set the bare minimum
/// (project, type, summary, parent).
#[derive(Debug, Deserialize)]
pub struct CreateSubtaskRequest {
    pub parent_key: String,
    pub project_key: String,
    pub subtask_issue_type_id: String,
    pub summary: String,
    /// Optional Markdown body. When present, gets converted to ADF the
    /// same way the main ticket's description does. When absent (or after
    /// trimming), the sub-task is created with no description — Jira
    /// renders an empty body cleanly, so this is a safe fallback when
    /// the upstream `ai_expand_subtasks` call failed or wasn't invoked.
    #[serde(default)]
    pub description_markdown: Option<String>,
}

#[tauri::command]
pub async fn jira_create_subtask(
    state: State<'_, AppState>,
    req: CreateSubtaskRequest,
) -> AppResult<CreateIssueResponse> {
    log::info!(
        "jira_create_subtask: parent={} project={} type_id={} summary_len={}",
        req.parent_key,
        req.project_key,
        req.subtask_issue_type_id,
        req.summary.len(),
    );
    let s = secrets::load()?;
    let site = s
        .jira_site
        .as_deref()
        .ok_or_else(|| AppError::Invalid("jira site not configured".into()))?;
    let base = base_url(site)?;

    // Trim and clamp the summary — Atlassian rejects > 254 chars.
    let summary = {
        let t = req.summary.trim();
        if t.chars().count() > 254 {
            t.chars().take(254).collect::<String>()
        } else {
            t.to_string()
        }
    };
    if summary.is_empty() {
        return Err(AppError::Invalid("subtask summary is empty".into()));
    }

    let mut fields = serde_json::Map::new();
    fields.insert("project".into(), json!({ "key": req.project_key }));
    fields.insert("summary".into(), json!(summary));
    fields.insert("issuetype".into(), json!({ "id": req.subtask_issue_type_id }));
    fields.insert("parent".into(), json!({ "key": req.parent_key }));

    if let Some(md) = req.description_markdown.as_ref() {
        let trimmed = md.trim();
        if !trimmed.is_empty() {
            fields.insert("description".into(), adf::markdown_to_adf(trimmed));
        }
    }

    let body = json!({ "fields": fields });
    let resp = request(&state, Method::POST, "/rest/api/3/issue")?
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await?;
    let mut created: CreateIssueResponse = decode(resp).await?;
    created.browse_url = Some(format!("{base}/browse/{}", created.key));
    log::info!(
        "jira_create_subtask ok: parent={} child={} url={:?}",
        req.parent_key,
        created.key,
        created.browse_url
    );
    Ok(created)
}

#[derive(Debug, Deserialize)]
pub struct AttachmentRequest {
    pub issue_key: String,
    pub file_path: String,
}

#[tauri::command]
pub async fn jira_upload_attachment(
    state: State<'_, AppState>,
    req: AttachmentRequest,
) -> AppResult<Value> {
    let bytes = tokio::fs::read(&req.file_path).await?;
    let filename = std::path::Path::new(&req.file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();
    let mime = mime_guess(&filename);

    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str(mime)
            .map_err(|e| AppError::Invalid(format!("mime: {e}")))?,
    );

    let path = format!("/rest/api/3/issue/{}/attachments", urlencoding_encode(&req.issue_key));
    let resp = request(&state, Method::POST, &path)?
        .header("X-Atlassian-Token", "no-check")
        .multipart(form)
        .send()
        .await?;
    decode(resp).await
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

fn urlencoding_encode(s: &str) -> String {
    // Minimal path-segment encoder; Jira project/issue keys are [A-Z0-9_]+,
    // but be safe for user-provided values.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn mime_guess(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    match std::path::Path::new(&lower).extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("txt") | Some("md") | Some("log") => "text/plain",
        Some("json") => "application/json",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}
