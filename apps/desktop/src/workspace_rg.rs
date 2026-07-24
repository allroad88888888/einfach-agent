use crate::workspace_common::{read_capped_drain, resolve_workspace_root};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
};

const DEFAULT_MAX_MATCHES: usize = 200;
const MAX_MATCHES: usize = 1_000;
const DEFAULT_CONTEXT_LINES: usize = 0;
const MAX_CONTEXT_LINES: usize = 5;
const MAX_RG_STDERR_CHARS: usize = 10_000;
const RG_MAX_FILESIZE: &str = "1M";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RgSearchResult {
    ok: bool,
    matches: Vec<RgSearchMatch>,
    truncated: bool,
    exit_code: i32,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RgSearchMatch {
    path: String,
    line_number: usize,
    column: usize,
    line: String,
    before: Vec<String>,
    after: Vec<String>,
}

#[derive(Default)]
struct ParsedRgOutput {
    matches: Vec<RgSearchMatch>,
    truncated: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn rg_search_workspace(
    query: String,
    path: Option<String>,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
    globs: Option<Vec<String>>,
    context_lines: Option<usize>,
    max_matches: Option<usize>,
    workspace_root: Option<String>,
) -> Result<RgSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rg_search_workspace_blocking(
            query,
            path,
            regex,
            case_sensitive,
            globs,
            context_lines,
            max_matches,
            workspace_root,
        )
    })
    .await
    .map_err(|err| format!("rg_search_workspace worker failed: {err}"))?
}

#[allow(clippy::too_many_arguments)]
fn rg_search_workspace_blocking(
    query: String,
    path: Option<String>,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
    globs: Option<Vec<String>>,
    context_lines: Option<usize>,
    max_matches: Option<usize>,
    workspace_root: Option<String>,
) -> Result<RgSearchResult, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(failed_result(
            "query must be a non-empty string".to_string(),
        ));
    }

    let root = match resolve_workspace_root(workspace_root.as_deref()) {
        Ok(root) => root,
        Err(err) => return Ok(failed_result(err)),
    };
    let target = match normalize_target_path(path, &root) {
        Ok(path) => path,
        Err(err) => return Ok(failed_result(err)),
    };
    let globs = match normalize_globs(globs) {
        Ok(globs) => globs,
        Err(err) => return Ok(failed_result(err)),
    };

    let context_lines = normalize_context_lines(context_lines);
    let max_matches = normalize_max_matches(max_matches);
    let regex = regex.unwrap_or(false);
    let case_sensitive = case_sensitive.unwrap_or(true);

    let mut child = match spawn_rg(
        &root,
        &target,
        &query,
        regex,
        case_sensitive,
        &globs,
        context_lines,
    ) {
        Ok(child) => child,
        Err(err) => return Ok(failed_result(err)),
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture rg stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture rg stderr".to_string())?;
    let stderr_handle = thread::spawn(move || read_capped_drain(stderr, MAX_RG_STDERR_CHARS));

    let parsed = parse_rg_stdout(stdout, &root, context_lines, max_matches, &mut child)?;
    let status = child
        .wait()
        .map_err(|err| format!("failed to wait for rg: {err}"))?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| "rg stderr reader thread panicked".to_string())?
        .map_err(|err| format!("failed to read rg stderr: {err}"))?;

    let exit_code = status.code().unwrap_or(1);
    let ok = parsed.truncated || exit_code == 0 || exit_code == 1;
    Ok(RgSearchResult {
        ok,
        matches: parsed.matches,
        truncated: parsed.truncated || stderr.truncated,
        exit_code,
        stderr: stderr.text,
    })
}

fn spawn_rg(
    root: &Path,
    target: &str,
    query: &str,
    regex: bool,
    case_sensitive: bool,
    globs: &[String],
    context_lines: usize,
) -> Result<Child, String> {
    let mut command = Command::new("rg");
    command
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args([
            "--json",
            "--color",
            "never",
            "--line-number",
            "--column",
            "--with-filename",
            "--max-filesize",
            RG_MAX_FILESIZE,
        ]);

    if !regex {
        command.arg("--fixed-strings");
    }
    if !case_sensitive {
        command.arg("--ignore-case");
    }
    if context_lines > 0 {
        command.arg("--context").arg(context_lines.to_string());
    }
    for glob in globs {
        command.arg("--glob").arg(glob);
    }
    command.arg("--regexp").arg(query).arg(target);

    command
        .spawn()
        .map_err(|err| format!("failed to spawn `rg`: {err}"))
}

fn parse_rg_stdout<R: std::io::Read>(
    stdout: R,
    root: &Path,
    context_lines: usize,
    max_matches: usize,
    child: &mut Child,
) -> Result<ParsedRgOutput, String> {
    let mut reader = BufReader::new(stdout);
    let mut output = ParsedRgOutput::default();
    let mut pending_before: Vec<String> = Vec::new();
    let mut after_remaining = 0usize;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|err| format!("failed to read rg stdout: {err}"))?;
        if bytes == 0 {
            break;
        }

        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("context") => {
                let context_line = extract_line(&value);
                if after_remaining > 0 {
                    if let Some(last) = output.matches.last_mut() {
                        last.after.push(context_line);
                    }
                    after_remaining -= 1;
                } else if context_lines > 0 {
                    pending_before.push(context_line);
                    if pending_before.len() > context_lines {
                        pending_before.remove(0);
                    }
                }
            }
            Some("match") => {
                if output.matches.len() >= max_matches {
                    output.truncated = true;
                    let _ = child.kill();
                    break;
                }

                output.matches.push(RgSearchMatch {
                    path: extract_path(&value, root),
                    line_number: extract_line_number(&value),
                    column: extract_column(&value),
                    line: extract_line(&value),
                    before: pending_before.clone(),
                    after: Vec::new(),
                });
                pending_before.clear();
                after_remaining = context_lines;
            }
            _ => {}
        }
    }

    Ok(output)
}

fn extract_data<'a>(value: &'a Value) -> Option<&'a Value> {
    value.get("data")
}

fn extract_path(value: &Value, root: &Path) -> String {
    let path = extract_data(value)
        .and_then(|data| data.get("path"))
        .and_then(|path| path.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    normalize_display_path(path, root)
}

fn extract_line_number(value: &Value) -> usize {
    extract_data(value)
        .and_then(|data| data.get("line_number"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0)
}

fn extract_column(value: &Value) -> usize {
    extract_data(value)
        .and_then(|data| data.get("submatches"))
        .and_then(Value::as_array)
        .and_then(|matches| matches.first())
        .and_then(|first| first.get("start"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .map(|zero_based| zero_based + 1)
        .unwrap_or(1)
}

fn extract_line(value: &Value) -> String {
    extract_data(value)
        .and_then(|data| data.get("lines"))
        .and_then(|lines| lines.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches(['\r', '\n'])
        .to_string()
}

fn normalize_target_path(path: Option<String>, root: &Path) -> Result<String, String> {
    let Some(path) = path else {
        return Ok(".".to_string());
    };
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(".".to_string());
    }
    if trimmed.contains('\0') {
        return Err("path cannot contain NUL bytes".to_string());
    }

    let input = PathBuf::from(trimmed);
    let joined = if input.is_absolute() {
        input
    } else {
        root.join(input)
    };
    let canonical = fs::canonicalize(&joined)
        .map_err(|err| format!("path `{trimmed}` is not accessible: {err}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("path `{trimmed}` escapes workspace root"));
    }
    if canonical == root {
        return Ok(".".to_string());
    }
    canonical
        .strip_prefix(root)
        .map(path_to_rg_path)
        .map_err(|err| format!("failed to make path relative to workspace root: {err}"))
}

fn normalize_globs(globs: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let Some(globs) = globs else {
        return Ok(Vec::new());
    };
    let mut normalized = Vec::new();
    for glob in globs {
        let trimmed = glob.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains('\0') {
            return Err("glob cannot contain NUL bytes".to_string());
        }
        let path_like = trimmed.strip_prefix('!').unwrap_or(trimmed);
        if path_like.starts_with('/') || path_like.starts_with('\\') {
            return Err(format!("glob `{trimmed}` must be relative"));
        }
        if has_parent_component(path_like) {
            return Err(format!("glob `{trimmed}` must not contain `..` components"));
        }
        normalized.push(trimmed.to_string());
    }
    Ok(normalized)
}

fn has_parent_component(value: &str) -> bool {
    Path::new(value)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn normalize_context_lines(context_lines: Option<usize>) -> usize {
    context_lines
        .unwrap_or(DEFAULT_CONTEXT_LINES)
        .min(MAX_CONTEXT_LINES)
}

fn normalize_max_matches(max_matches: Option<usize>) -> usize {
    match max_matches {
        Some(value) if value > 0 => value.min(MAX_MATCHES),
        _ => DEFAULT_MAX_MATCHES,
    }
}

fn normalize_display_path(path: &str, root: &Path) -> String {
    let value = Path::new(path);
    if value.is_absolute() {
        if let Ok(relative) = value.strip_prefix(root) {
            return path_to_rg_path(relative);
        }
    }
    path.replace('\\', "/")
}

fn path_to_rg_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn failed_result(stderr: String) -> RgSearchResult {
    RgSearchResult {
        ok: false,
        matches: Vec::new(),
        truncated: false,
        exit_code: 1,
        stderr,
    }
}
