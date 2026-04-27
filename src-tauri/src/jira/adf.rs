//! Minimal Markdown → ADF (Atlassian Document Format v1) converter for Jira v3.
//!
//! Scope: headings (# to ######), paragraphs, bullet/numbered lists, fenced
//! code blocks, inline code, bold/italic, links, and thematic breaks. That
//! covers everything our AI drafter emits. Anything more exotic falls through
//! as plain paragraphs.
//!
//! Thematic break note: a line of three or more `-`, `*`, or `_` characters
//! (with optional surrounding whitespace) is the CommonMark spec for an `<hr>`.
//! Without explicit handling here, those lines end up rendered as literal
//! `---` text in the Jira ticket because nothing in the paragraph branch
//! interprets them. ADF spells the same construct as `{ "type": "rule" }`.

use serde_json::{Value, json};

pub fn markdown_to_adf(md: &str) -> Value {
    let content = parse_blocks(md);
    json!({
        "type": "doc",
        "version": 1,
        "content": content,
    })
}

fn parse_blocks(md: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut lines = md.lines().peekable();
    while let Some(&line) = lines.peek() {
        let trimmed = line.trim_start();

        // Fenced code block
        if trimmed.starts_with("```") {
            lines.next();
            let mut code = String::new();
            while let Some(&l) = lines.peek() {
                if l.trim_start().starts_with("```") {
                    lines.next();
                    break;
                }
                code.push_str(l);
                code.push('\n');
                lines.next();
            }
            out.push(json!({
                "type": "codeBlock",
                "attrs": {},
                "content": [{ "type": "text", "text": code.trim_end().to_string() }],
            }));
            continue;
        }

        // Thematic break (`---`, `***`, `___`). Must be checked BEFORE the
        // paragraph fallback below or the line would otherwise survive as
        // literal text in the ticket. We accept 3+ identical marker chars
        // and any surrounding whitespace per CommonMark.
        if is_thematic_break(line) {
            out.push(json!({ "type": "rule" }));
            lines.next();
            continue;
        }

        // Heading
        if let Some(heading) = parse_heading(line) {
            out.push(heading);
            lines.next();
            continue;
        }

        // List (bullet / numbered)
        if is_bullet(trimmed) || is_numbered(trimmed) {
            let is_num = is_numbered(trimmed);
            let mut items = Vec::new();
            while let Some(&l) = lines.peek() {
                let lt = l.trim_start();
                let indent_matches = if is_num { is_numbered(lt) } else { is_bullet(lt) };
                if !indent_matches {
                    break;
                }
                let text = strip_list_marker(lt);
                items.push(json!({
                    "type": "listItem",
                    "content": [{
                        "type": "paragraph",
                        "content": parse_inline(text),
                    }],
                }));
                lines.next();
            }
            out.push(json!({
                "type": if is_num { "orderedList" } else { "bulletList" },
                "content": items,
            }));
            continue;
        }

        // Blank line
        if line.trim().is_empty() {
            lines.next();
            continue;
        }

        // Paragraph — consume consecutive non-blank, non-special lines
        let mut para = String::new();
        while let Some(&l) = lines.peek() {
            let lt = l.trim_start();
            if l.trim().is_empty()
                || lt.starts_with("```")
                || parse_heading(l).is_some()
                || is_bullet(lt)
                || is_numbered(lt)
                || is_thematic_break(l)
            {
                break;
            }
            if !para.is_empty() {
                para.push('\n');
            }
            para.push_str(l);
            lines.next();
        }
        if !para.is_empty() {
            out.push(json!({
                "type": "paragraph",
                "content": parse_inline(&para),
            }));
        }
    }

    if out.is_empty() {
        out.push(json!({ "type": "paragraph", "content": [] }));
    }
    out
}

fn parse_heading(line: &str) -> Option<Value> {
    let t = line.trim_start();
    let mut level = 0;
    let chars = t.chars().collect::<Vec<_>>();
    while level < chars.len() && chars[level] == '#' {
        level += 1;
    }
    if level == 0 || level > 6 {
        return None;
    }
    if chars.get(level) != Some(&' ') {
        return None;
    }
    let text: String = chars[level + 1..].iter().collect();
    Some(json!({
        "type": "heading",
        "attrs": { "level": level },
        "content": parse_inline(text.trim()),
    }))
}

/// CommonMark thematic break: a line that, after trimming surrounding
/// whitespace, contains 3+ of the SAME marker char (`-`, `*`, or `_`),
/// optionally interspersed with spaces/tabs. Examples: `---`, `***`,
/// `___`, `- - -`, `***   `. Anything else is not a break.
fn is_thematic_break(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.len() < 3 {
        return false;
    }
    let bytes = trimmed.as_bytes();
    let marker = bytes[0];
    if marker != b'-' && marker != b'*' && marker != b'_' {
        return false;
    }
    let mut count = 0usize;
    for &b in bytes {
        if b == marker {
            count += 1;
        } else if b != b' ' && b != b'\t' {
            return false;
        }
    }
    count >= 3
}

fn is_bullet(s: &str) -> bool {
    s.starts_with("- ") || s.starts_with("* ") || s.starts_with("+ ")
}

fn is_numbered(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    i > 0 && i < bytes.len() && (bytes[i] == b'.' || bytes[i] == b')') && bytes.get(i + 1) == Some(&b' ')
}

fn strip_list_marker(s: &str) -> &str {
    if is_bullet(s) {
        &s[2..]
    } else {
        let mut i = 0;
        let bytes = s.as_bytes();
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        // Skip "." or ")" then space
        i += 2;
        if i > s.len() { s } else { &s[i..] }
    }
}

/// Inline parser handling **bold**, *italic*, `code`, and [text](url).
/// Emits ADF text nodes with marks. Unescape-backslash is not implemented;
/// our AI output doesn't rely on it.
fn parse_inline(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    macro_rules! flush_text {
        () => {
            if !buf.is_empty() {
                out.push(json!({ "type": "text", "text": buf.clone() }));
                buf.clear();
            }
        };
    }

    while i < chars.len() {
        // Link [text](url)
        if chars[i] == '[' {
            if let Some((label, href, consumed)) = try_link(&chars, i) {
                flush_text!();
                out.push(json!({
                    "type": "text",
                    "text": label,
                    "marks": [{ "type": "link", "attrs": { "href": href } }],
                }));
                i += consumed;
                continue;
            }
        }
        // Inline code `...`
        if chars[i] == '`' {
            if let Some((code, consumed)) = delimited(&chars, i, '`', '`') {
                flush_text!();
                out.push(json!({
                    "type": "text",
                    "text": code,
                    "marks": [{ "type": "code" }],
                }));
                i += consumed;
                continue;
            }
        }
        // Bold **...**
        if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' {
            if let Some((inner, consumed)) = double_delim(&chars, i, '*') {
                flush_text!();
                for node in parse_inline(&inner) {
                    out.push(add_mark(node, "strong"));
                }
                i += consumed;
                continue;
            }
        }
        // Italic *...* or _..._
        if (chars[i] == '*' || chars[i] == '_')
            && (i == 0 || !chars[i - 1].is_alphanumeric())
        {
            let d = chars[i];
            if let Some((inner, consumed)) = delimited(&chars, i, d, d) {
                if !inner.is_empty() {
                    flush_text!();
                    for node in parse_inline(&inner) {
                        out.push(add_mark(node, "em"));
                    }
                    i += consumed;
                    continue;
                }
            }
        }
        buf.push(chars[i]);
        i += 1;
    }
    flush_text!();
    if out.is_empty() {
        out.push(json!({ "type": "text", "text": "" }));
    }
    out
}

fn try_link(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    if chars[start] != '[' {
        return None;
    }
    let mut i = start + 1;
    let mut label = String::new();
    while i < chars.len() && chars[i] != ']' {
        label.push(chars[i]);
        i += 1;
    }
    if i >= chars.len() || chars.get(i + 1) != Some(&'(') {
        return None;
    }
    i += 2;
    let mut href = String::new();
    while i < chars.len() && chars[i] != ')' {
        href.push(chars[i]);
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    Some((label, href, i - start + 1))
}

fn delimited(chars: &[char], start: usize, open: char, close: char) -> Option<(String, usize)> {
    if chars[start] != open {
        return None;
    }
    let mut i = start + 1;
    let mut out = String::new();
    while i < chars.len() {
        if chars[i] == close {
            return Some((out, i - start + 1));
        }
        if chars[i] == '\n' {
            return None;
        }
        out.push(chars[i]);
        i += 1;
    }
    None
}

fn double_delim(chars: &[char], start: usize, d: char) -> Option<(String, usize)> {
    if start + 1 >= chars.len() || chars[start] != d || chars[start + 1] != d {
        return None;
    }
    let mut i = start + 2;
    let mut out = String::new();
    while i + 1 < chars.len() {
        if chars[i] == d && chars[i + 1] == d {
            return Some((out, i - start + 2));
        }
        if chars[i] == '\n' {
            return None;
        }
        out.push(chars[i]);
        i += 1;
    }
    None
}

fn add_mark(mut node: Value, mark: &str) -> Value {
    let marks = node
        .get_mut("marks")
        .and_then(|m| m.as_array_mut())
        .cloned()
        .unwrap_or_default();
    let mut new_marks = marks;
    new_marks.push(json!({ "type": mark }));
    node["marks"] = Value::Array(new_marks);
    node
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_types(md: &str) -> Vec<String> {
        let doc = markdown_to_adf(md);
        doc["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["type"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn thematic_break_dashes_becomes_rule() {
        let types = block_types("Before\n\n---\n\nAfter");
        assert_eq!(types, vec!["paragraph", "rule", "paragraph"]);
    }

    #[test]
    fn thematic_break_asterisks_and_underscores() {
        assert_eq!(block_types("a\n\n***\n\nb"), vec!["paragraph", "rule", "paragraph"]);
        assert_eq!(block_types("a\n\n___\n\nb"), vec!["paragraph", "rule", "paragraph"]);
    }

    #[test]
    fn thematic_break_with_spaces_between_markers() {
        // CommonMark accepts `- - -` (with spaces) as a thematic break.
        assert_eq!(block_types("a\n\n- - -\n\nb"), vec!["paragraph", "rule", "paragraph"]);
    }

    #[test]
    fn three_dashes_directly_after_paragraph_is_not_setext_underline() {
        // `---` immediately after a paragraph line in CommonMark is a setext
        // heading underline. We don't support setext headings; we treat it
        // as a rule. Make the contract explicit.
        let types = block_types("paragraph line\n---\nnext paragraph");
        // Either ["heading", "paragraph"] (setext) or ["paragraph", "rule", "paragraph"].
        // We document the actual current behaviour:
        assert!(types.contains(&"rule".to_string()), "got: {types:?}");
    }

    #[test]
    fn two_dashes_is_not_a_break() {
        // `--` is just stray text, not a rule.
        let types = block_types("--");
        assert_eq!(types, vec!["paragraph"]);
    }

    #[test]
    fn mixed_markers_dont_count() {
        // `-*-` mixes markers — not a thematic break.
        let types = block_types("text\n\n-*-\n\nmore");
        assert_eq!(types, vec!["paragraph", "paragraph", "paragraph"]);
    }
}
