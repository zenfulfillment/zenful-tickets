//! Per-format text extraction.
//!
//! Each `extract_*` function takes a path and returns plain text suitable for
//! embedding into an AI prompt. The output is intentionally markdown-flavoured
//! (fenced code blocks, pipe tables) so the model sees structure rather than a
//! raw paragraph soup.
//!
//! Size + token budgets are enforced *here*, not by the caller — if a 50 MB
//! xlsx with millions of cells is dropped on us we truncate at a safe ceiling
//! and append a `[truncated]` marker so the model knows the data is partial.
//! Caller checks the byte size before extraction kicks off; this layer is
//! solely responsible for gracefully degrading huge content into prompt-sized
//! output.

use crate::error::{AppError, AppResult};
use std::io::Read;
use std::path::Path;

/// Hard ceiling on extracted character count per file. Keeps the prompt
/// budget predictable across providers — Claude/Gemini have generous context,
/// Codex JSON mode less so. ~30k chars ≈ 7-8k tokens.
pub const MAX_EXTRACTED_CHARS: usize = 30_000;

/// Per-extractor truncation suffix. Visible to the model so it can reason
/// about partial data ("the spreadsheet has more rows than shown").
const TRUNCATION_MARKER: &str = "\n\n[… truncated — file too large to include in full]";

/// What kind of attachment we're holding. Drives both the routing decision
/// (text-extract vs pass-as-image) and the per-provider request shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Image,
    Pdf,
    Spreadsheet, // xlsx, xls, ods
    Document,    // docx
    Csv,
    Text,
    Unsupported,
}

impl AttachmentKind {
    /// Inferred from the lowercased file extension. We deliberately don't sniff
    /// magic bytes here — extension is what the user expects, and the
    /// downstream extractors validate the actual format.
    pub fn from_extension(ext: &str) -> Self {
        match ext.to_lowercase().as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" => AttachmentKind::Image,
            "pdf" => AttachmentKind::Pdf,
            "xlsx" | "xls" | "ods" => AttachmentKind::Spreadsheet,
            "docx" => AttachmentKind::Document,
            "csv" | "tsv" => AttachmentKind::Csv,
            "txt" | "md" | "log" | "json" | "yaml" | "yml" | "toml" => AttachmentKind::Text,
            _ => AttachmentKind::Unsupported,
        }
    }

    pub fn mime_hint(&self, ext: &str) -> &'static str {
        match self {
            AttachmentKind::Image => match ext.to_lowercase().as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => "image/png",
            },
            AttachmentKind::Pdf => "application/pdf",
            AttachmentKind::Spreadsheet => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            AttachmentKind::Document => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            AttachmentKind::Csv => "text/csv",
            AttachmentKind::Text => "text/plain",
            AttachmentKind::Unsupported => "application/octet-stream",
        }
    }
}

/// Public extraction entry point. Returns `Ok(None)` for kinds that have no
/// extractable text (images — those are passed via vision, not embedded).
pub fn extract(path: &Path, kind: AttachmentKind) -> AppResult<Option<String>> {
    match kind {
        AttachmentKind::Image => Ok(None),
        AttachmentKind::Pdf => extract_pdf(path).map(Some),
        AttachmentKind::Spreadsheet => extract_spreadsheet(path).map(Some),
        AttachmentKind::Document => extract_docx(path).map(Some),
        AttachmentKind::Csv => extract_csv(path).map(Some),
        AttachmentKind::Text => extract_text(path).map(Some),
        AttachmentKind::Unsupported => Err(AppError::Invalid(
            "unsupported file format — try png, jpg, pdf, xlsx, docx, csv, or txt".into(),
        )),
    }
}

// ─── Implementations ────────────────────────────────────────────

fn extract_pdf(path: &Path) -> AppResult<String> {
    let bytes = std::fs::read(path)?;
    // pdf_extract::extract_text_from_mem is sync and uses lopdf. Errors are
    // mapped through AppError::Invalid because they're per-file diagnostic, not
    // I/O failures of the storage layer.
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| AppError::Invalid(format!("pdf parse: {e}")))?;
    Ok(truncate(text.trim().to_string()))
}

fn extract_spreadsheet(path: &Path) -> AppResult<String> {
    use calamine::{open_workbook_auto, Reader};

    let mut workbook = open_workbook_auto(path)
        .map_err(|e| AppError::Invalid(format!("spreadsheet open: {e}")))?;

    let sheet_names = workbook.sheet_names().to_vec();
    let mut out = String::new();

    for sheet_name in sheet_names {
        let range = match workbook.worksheet_range(&sheet_name) {
            Ok(r) => r,
            Err(_) => continue,
        };

        if range.is_empty() {
            continue;
        }

        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("### Sheet: {sheet_name}\n\n"));

        // Render as a markdown table — first row treated as header. If the
        // sheet is small enough, render every row; otherwise truncate at
        // 200 rows (the per-file char cap will catch absurdly wide sheets).
        let max_rows = 200;
        let mut rows = range.rows().take(max_rows + 1).peekable();

        if let Some(header) = rows.next() {
            out.push_str("| ");
            for cell in header {
                out.push_str(&cell_to_str(cell));
                out.push_str(" | ");
            }
            out.push_str("\n| ");
            for _ in 0..header.len() {
                out.push_str("--- | ");
            }
            out.push('\n');

            let mut row_count = 0usize;
            for row in rows {
                if row_count >= max_rows {
                    break;
                }
                out.push_str("| ");
                for cell in row {
                    out.push_str(&cell_to_str(cell));
                    out.push_str(" | ");
                }
                out.push('\n');
                row_count += 1;
            }

            let total_rows = range.rows().count().saturating_sub(1);
            if total_rows > row_count {
                out.push_str(&format!(
                    "\n[showing {row_count} of {total_rows} rows]\n"
                ));
            }
        }

        // Bail out of further sheets once we're already over budget — saves
        // wasted parse time on books with hundreds of sheets.
        if out.len() >= MAX_EXTRACTED_CHARS {
            break;
        }
    }

    Ok(truncate(out))
}

fn cell_to_str(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.replace('|', "\\|").replace('\n', " "),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => format!("{i}"),
        Data::Bool(b) => format!("{b}"),
        Data::DateTime(dt) => format!("{}", dt.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERR({e:?})"),
    }
}

fn extract_docx(path: &Path) -> AppResult<String> {
    // DOCX is a zip archive containing `word/document.xml`. We parse only the
    // text runs (`<w:t>` elements) — formatting, images, footnotes, and
    // comments are deliberately dropped. This keeps the dep tree small and
    // covers ~95 % of "user pastes a Word doc with prose" scenarios.
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let file = std::fs::File::open(path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::Invalid(format!("docx open: {e}")))?;

    let mut document_xml = String::new();
    {
        let mut entry = archive
            .by_name("word/document.xml")
            .map_err(|e| AppError::Invalid(format!("docx missing document.xml: {e}")))?;
        entry.read_to_string(&mut document_xml)?;
    }

    let mut reader = Reader::from_str(&document_xml);
    reader.config_mut().trim_text(false);

    let mut out = String::new();
    let mut in_text = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) if e.name().as_ref() == b"w:t" => {
                in_text = true;
            }
            Ok(Event::End(ref e)) if e.name().as_ref() == b"w:t" => {
                in_text = false;
            }
            // Each `<w:p>` is a paragraph — emit a newline at its close.
            Ok(Event::End(ref e)) if e.name().as_ref() == b"w:p" => {
                out.push('\n');
            }
            // `<w:tab/>` and `<w:br/>` are inline whitespace markers.
            Ok(Event::Empty(ref e)) if e.name().as_ref() == b"w:tab" => out.push('\t'),
            Ok(Event::Empty(ref e)) if e.name().as_ref() == b"w:br" => out.push('\n'),
            Ok(Event::Text(t)) if in_text => {
                let s = t.unescape().unwrap_or_default();
                out.push_str(&s);
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(AppError::Invalid(format!("docx parse: {e}"))),
            _ => {}
        }
        buf.clear();

        if out.len() >= MAX_EXTRACTED_CHARS {
            break;
        }
    }

    // Collapse runs of >2 newlines (DOCX likes blank paragraphs) to keep the
    // prompt tidy.
    let collapsed = collapse_blanks(&out);
    Ok(truncate(collapsed.trim().to_string()))
}

fn collapse_blanks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_run = 0usize;
    for line in s.lines() {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                out.push('\n');
            }
        } else {
            blank_run = 0;
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn extract_csv(path: &Path) -> AppResult<String> {
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .has_headers(false)
        .from_path(path)
        .map_err(|e| AppError::Invalid(format!("csv open: {e}")))?;

    let mut out = String::from("```csv\n");
    let mut row_count = 0usize;
    let max_rows = 500;

    for record in rdr.records() {
        if row_count >= max_rows {
            out.push_str(&format!("[… {} more rows]\n", "many"));
            break;
        }
        match record {
            Ok(r) => {
                let row = r
                    .iter()
                    .map(|f| {
                        if f.contains(',') || f.contains('"') || f.contains('\n') {
                            format!("\"{}\"", f.replace('"', "\"\""))
                        } else {
                            f.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                out.push_str(&row);
                out.push('\n');
                row_count += 1;
            }
            Err(_) => continue,
        }
        if out.len() >= MAX_EXTRACTED_CHARS {
            break;
        }
    }

    out.push_str("```\n");
    Ok(truncate(out))
}

fn extract_text(path: &Path) -> AppResult<String> {
    let raw = std::fs::read_to_string(path)?;
    Ok(truncate(raw))
}

fn truncate(mut s: String) -> String {
    if s.len() <= MAX_EXTRACTED_CHARS {
        return s;
    }
    // Truncate at a UTF-8 char boundary.
    let mut cut = MAX_EXTRACTED_CHARS;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s.push_str(TRUNCATION_MARKER);
    s
}
