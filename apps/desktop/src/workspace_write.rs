use crate::workspace_change_journal::{
    discard_prepared_change, journal_dir, mark_change_applied, prepare_change_set, ChangeFileInput,
    WorkspaceChangeContext, WorkspaceChangeSummary,
};
use crate::workspace_common::resolve_workspace_root;
use serde::Serialize;
use std::{
    fs,
    io::{Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf, MAIN_SEPARATOR},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_MAX_BYTES: usize = 200 * 1024;
const MAX_BYTES: usize = 1024 * 1024;
const ARCHIVE_LOCK_WAIT: Duration = Duration::from_secs(10);
const ARCHIVE_LOCK_STALE: Duration = Duration::from_secs(30);
const ARCHIVE_LOCK_POLL: Duration = Duration::from_millis(20);
const INDEX_COMPACT_MIN_BYTES: u64 = 128 * 1024;
const INDEX_COMPACT_THROTTLE: Duration = Duration::from_secs(5 * 60);
const INDEX_COMPACT_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
pub struct WorkspaceWriteResult {
    ok: bool,
    path: String,
    bytes_written: usize,
    created: bool,
    overwritten: bool,
    appended: bool,
    error: Option<String>,
    change_set: Option<WorkspaceChangeSummary>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteMode {
    Create,
    Overwrite,
    Append,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn write_workspace_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    exclusive_path_lock: Option<bool>,
    workspace_root: Option<String>,
    change_context: Option<WorkspaceChangeContext>,
) -> Result<WorkspaceWriteResult, String> {
    let journal = change_context
        .map(|context| journal_dir(&app).map(|directory| (directory, context)))
        .transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        write_workspace_file_blocking_with_journal(
            path,
            content,
            mode,
            expected_old_content,
            create_dirs,
            max_bytes,
            exclusive_path_lock,
            workspace_root,
            journal,
        )
    })
    .await
    .map_err(|err| format!("workspace write worker failed: {err}"))?
}

#[cfg(test)]
fn write_workspace_file_blocking(
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    exclusive_path_lock: Option<bool>,
    workspace_root_arg: Option<String>,
) -> Result<WorkspaceWriteResult, String> {
    write_workspace_file_blocking_with_journal(
        path,
        content,
        mode,
        expected_old_content,
        create_dirs,
        max_bytes,
        exclusive_path_lock,
        workspace_root_arg,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_workspace_file_blocking_with_journal(
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    exclusive_path_lock: Option<bool>,
    workspace_root_arg: Option<String>,
    journal: Option<(PathBuf, WorkspaceChangeContext)>,
) -> Result<WorkspaceWriteResult, String> {
    let mode = match parse_mode(mode.as_deref()) {
        Ok(mode) => mode,
        Err(err) => return Ok(error_result(&path, err)),
    };
    if content.contains('\0') {
        return Ok(error_result(&path, "binary content is not supported"));
    }

    let max_bytes = normalize_max_bytes(max_bytes);
    let bytes = content.as_bytes().len();
    if bytes > max_bytes {
        return Ok(error_result(
            &path,
            format!("content is too large: {bytes} bytes exceeds limit {max_bytes}"),
        ));
    }

    let workspace_root = match resolve_workspace_root(workspace_root_arg.as_deref()) {
        Ok(root) => root,
        Err(err) => return Ok(error_result(&path, err)),
    };
    let target_path = match resolve_workspace_path(&workspace_root, &path) {
        Ok(path) => path,
        Err(err) => return Ok(error_result(&path, err)),
    };
    // P2：返回相对 workspace root 的路径（与 read/list/patch 一致），不把 /Users/.../repo 这类
    // 绝对路径泄漏给 model 与聊天记录。
    let display_path = relative_path(&workspace_root, &target_path);

    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            if create_dirs.unwrap_or(false) {
                if let Err(err) = fs::create_dir_all(parent) {
                    return Ok(error_result(
                        &display_path,
                        format!("failed to create parent directories: {err}"),
                    ));
                }
            } else {
                return Ok(error_result(
                    &display_path,
                    "parent directory does not exist; set createDirs=true to create it",
                ));
            }
        }
    }

    let _path_lock = if exclusive_path_lock.unwrap_or(false) {
        match ArchivePathLock::acquire(&target_path) {
            Ok(lock) => Some(lock),
            Err(err) => return Ok(error_result(&display_path, err)),
        }
    } else {
        None
    };

    if mode == WriteMode::Append && exclusive_path_lock.unwrap_or(false) {
        if let Err(err) = maybe_compact_subagent_index(&target_path) {
            return Ok(error_result(&display_path, err));
        }
    }

    let existed = target_path.exists();
    let prepared_change = if let Some((directory, context)) = journal.as_ref() {
        let before = match read_reversible_text(&target_path) {
            Ok(content) => content,
            Err(error) => return Ok(error_result(&display_path, error)),
        };
        let after = match mode {
            WriteMode::Create | WriteMode::Overwrite => content.clone(),
            WriteMode::Append => {
                let mut value = before.clone().unwrap_or_default();
                value.push_str(&content);
                value
            }
        };
        if after.len() > MAX_BYTES {
            return Ok(error_result(
                &display_path,
                format!("resulting file exceeds reversible {MAX_BYTES} byte limit"),
            ));
        }
        match prepare_change_set(
            directory,
            context.clone(),
            &workspace_root,
            vec![ChangeFileInput {
                path: display_path.clone(),
                before,
                after: Some(after),
            }],
        ) {
            Ok(summary) => Some((directory.clone(), summary)),
            Err(error) => return Ok(error_result(&display_path, error)),
        }
    } else {
        None
    };

    let write_result = match mode {
        WriteMode::Create => write_create(&target_path, content.as_bytes()),
        WriteMode::Overwrite => {
            if !existed {
                Err("cannot overwrite a file that does not exist".to_string())
            } else {
                verify_expected_content(&target_path, expected_old_content.as_deref())
                    .and_then(|_| fs::write(&target_path, content.as_bytes()).map_err(to_io_error))
            }
        }
        WriteMode::Append => write_append(&target_path, content.as_bytes()),
    };

    match write_result {
        Ok(()) => {
            if let Some((directory, summary)) = prepared_change.as_ref() {
                if let Err(error) = mark_change_applied(directory, &summary.id) {
                    log::warn!("failed to mark workspace change as applied: {error}");
                }
            }
            Ok(WorkspaceWriteResult {
                ok: true,
                path: display_path,
                bytes_written: bytes,
                created: !existed,
                overwritten: mode == WriteMode::Overwrite,
                appended: mode == WriteMode::Append,
                error: None,
                change_set: prepared_change.map(|(_, summary)| summary),
            })
        }
        Err(err) => {
            if let Some((directory, summary)) = prepared_change.as_ref() {
                discard_prepared_change(directory, &summary.id);
            }
            Ok(error_result(&display_path, err))
        }
    }
}

fn read_reversible_text(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to inspect file for rollback: {error}"))?;
    if !metadata.is_file() {
        return Err("rollback only supports regular files".to_string());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err(format!(
            "existing file exceeds reversible {MAX_BYTES} byte limit"
        ));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("failed to read file for rollback: {error}"))?;
    if bytes.contains(&0) {
        return Err("binary files are not reversible".to_string());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "non-UTF-8 files are not reversible".to_string())
}

struct ArchivePathLock {
    path: PathBuf,
    token: String,
    heartbeat_stop: std::sync::mpsc::Sender<()>,
    heartbeat: Option<std::thread::JoinHandle<()>>,
}

impl ArchivePathLock {
    fn acquire(target: &Path) -> Result<Self, String> {
        Self::acquire_with(target, ARCHIVE_LOCK_WAIT, ARCHIVE_LOCK_STALE)
    }

    fn acquire_with(target: &Path, wait: Duration, stale: Duration) -> Result<Self, String> {
        let lock_path = archive_lock_path(target)?;
        let started = SystemTime::now();
        let token = format!(
            "{}-{}",
            std::process::id(),
            started
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(mut file) => {
                    file.write_all(token.as_bytes()).map_err(|err| {
                        let _ = fs::remove_file(&lock_path);
                        format!("failed to initialize archive path lock: {err}")
                    })?;
                    let mut heartbeat_file = file.try_clone().map_err(|err| {
                        let _ = fs::remove_file(&lock_path);
                        format!("failed to initialize archive lock heartbeat: {err}")
                    })?;
                    let heartbeat_token = token.clone();
                    let (heartbeat_stop, heartbeat_receiver) = std::sync::mpsc::channel();
                    let heartbeat = thread::spawn(move || loop {
                        match heartbeat_receiver.recv_timeout(Duration::from_secs(5)) {
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                if heartbeat_file.seek(SeekFrom::Start(0)).is_err()
                                    || heartbeat_file
                                        .write_all(heartbeat_token.as_bytes())
                                        .is_err()
                                    || heartbeat_file.flush().is_err()
                                {
                                    break;
                                }
                            }
                            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    });
                    return Ok(Self {
                        path: lock_path,
                        token,
                        heartbeat_stop,
                        heartbeat: Some(heartbeat),
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    if archive_lock_is_stale(&lock_path, stale) {
                        let stale_path = lock_path.with_extension(format!("stale-{token}"));
                        if fs::rename(&lock_path, &stale_path).is_ok() {
                            let _ = fs::remove_file(stale_path);
                            continue;
                        }
                    }
                    if started.elapsed().unwrap_or_default() >= wait {
                        return Err(format!(
                            "timed out waiting for archive path lock `{}`",
                            lock_path.to_string_lossy()
                        ));
                    }
                    thread::sleep(ARCHIVE_LOCK_POLL);
                }
                Err(err) => return Err(format!("failed to acquire archive path lock: {err}")),
            }
        }
    }
}

impl Drop for ArchivePathLock {
    fn drop(&mut self) {
        let _ = self.heartbeat_stop.send(());
        if let Some(heartbeat) = self.heartbeat.take() {
            let _ = heartbeat.join();
        }
        if fs::read_to_string(&self.path).ok().as_deref() == Some(self.token.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn archive_lock_path(target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| "archive path lock requires a file target".to_string())?
        .to_string_lossy();
    Ok(target.with_file_name(format!("{name}.archive-write.lock")))
}

fn archive_lock_is_stale(path: &Path, stale: Duration) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= stale)
}

fn maybe_compact_subagent_index(path: &Path) -> Result<(), String> {
    let Some(name) = subagent_index_name(path) else {
        return Ok(());
    };
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(format!(
                "failed to inspect {name} index for compaction: {err}"
            ))
        }
    };
    if metadata.len() < INDEX_COMPACT_MIN_BYTES {
        return Ok(());
    }
    if metadata.len() > INDEX_COMPACT_MAX_BYTES {
        return Err(format!(
            "{name} index exceeds automatic compaction limit of {INDEX_COMPACT_MAX_BYTES} bytes"
        ));
    }

    let marker = path.with_file_name(format!(".{name}.compact-at"));
    if fs::metadata(&marker)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < INDEX_COMPACT_THROTTLE)
    {
        return Ok(());
    }

    let text = fs::read_to_string(path)
        .map_err(|err| format!("failed to read {name} index for compaction: {err}"))?;
    let compacted = compact_subagent_index(name, &text)?;
    atomic_replace(path, compacted.as_bytes(), "compact")?;
    fs::write(&marker, now_millis().to_string())
        .map_err(|err| format!("failed to update {name} compaction marker: {err}"))?;
    Ok(())
}

fn subagent_index_name(path: &Path) -> Option<&'static str> {
    let filename = path.file_name()?.to_str()?;
    let name = match filename {
        "runs.jsonl" => "runs",
        "skills.jsonl" => "skills",
        "agents.jsonl" => "agents",
        _ => return None,
    };
    let parent = path.parent()?;
    if parent.file_name()?.to_str()? != "index"
        || parent.parent()?.file_name()?.to_str()? != ".agent-archive"
    {
        return None;
    }
    Some(name)
}

fn compact_subagent_index(name: &str, text: &str) -> Result<String, String> {
    use std::collections::HashMap;
    let mut latest: HashMap<String, (usize, serde_json::Value)> = HashMap::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let record: serde_json::Value = serde_json::from_str(line)
            .map_err(|err| format!("{name} index line {}: invalid JSON ({err})", index + 1))?;
        let object = record
            .as_object()
            .ok_or_else(|| format!("{name} index line {}: record must be an object", index + 1))?;
        let field = |key: &str| {
            object
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let key = if name == "skills" {
            field("skillId")
                .ok_or_else(|| format!("skills index line {}: record requires skillId", index + 1))?
                .to_string()
        } else {
            let conversation = field("conversationId").ok_or_else(|| {
                format!(
                    "{name} index line {}: record requires conversationId and runId",
                    index + 1
                )
            })?;
            let run = field("runId").ok_or_else(|| {
                format!(
                    "{name} index line {}: record requires conversationId and runId",
                    index + 1
                )
            })?;
            if name == "runs" {
                format!("{conversation}\0{run}")
            } else {
                let agent_path = field("path").ok_or_else(|| {
                    format!("agents index line {}: record requires path", index + 1)
                })?;
                format!("{conversation}\0{run}\0{agent_path}")
            }
        };
        latest.insert(key, (index, record));
    }
    let mut records: Vec<_> = latest.into_values().collect();
    records.sort_by_key(|(index, _)| *index);
    let mut output = String::new();
    for (_, record) in records {
        output.push_str(
            &serde_json::to_string(&record)
                .map_err(|err| format!("failed to serialize compacted {name} index: {err}"))?,
        );
        output.push('\n');
    }
    Ok(output)
}

fn atomic_replace(path: &Path, content: &[u8], suffix: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!(
        "{suffix}-{}-{}.tmp",
        std::process::id(),
        now_millis()
    ));
    fs::write(&temporary, content)
        .map_err(|err| format!("failed to write temporary index: {err}"))?;
    let result = fs::rename(&temporary, path)
        .map_err(|err| format!("failed to replace compacted index: {err}"));
    let _ = fs::remove_file(temporary);
    result
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

// P2：把绝对路径转成相对 workspace root 的斜杠路径（与 workspace_read 同语义）——
// 结果 path 对外一律 workspace 相对，不泄漏本机绝对路径。root 外的意外路径回退为原样。
fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    if relative.as_os_str().is_empty() {
        return ".".to_string();
    }
    path_to_slash_string(relative)
}

fn path_to_slash_string(path: &Path) -> String {
    let text = path.to_string_lossy();
    if MAIN_SEPARATOR == '/' {
        text.into_owned()
    } else {
        text.replace(MAIN_SEPARATOR, "/")
    }
}

fn write_create(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(content))
        .map_err(to_io_error)
}

fn write_append(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(content))
        .map_err(to_io_error)
}

fn verify_expected_content(path: &Path, expected: Option<&str>) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };

    let current = fs::read_to_string(path)
        .map_err(|err| format!("failed to read existing file for expectedOldContent: {err}"))?;
    if current != expected {
        return Err("expectedOldContent does not match current file content".to_string());
    }
    Ok(())
}

fn parse_mode(mode: Option<&str>) -> Result<WriteMode, String> {
    match mode.unwrap_or("create") {
        "create" => Ok(WriteMode::Create),
        "overwrite" => Ok(WriteMode::Overwrite),
        "append" => Ok(WriteMode::Append),
        other => Err(format!(
            "invalid mode `{other}`; expected `create`, `overwrite`, or `append`"
        )),
    }
}

fn normalize_max_bytes(max_bytes: Option<usize>) -> usize {
    match max_bytes {
        Some(value) if value > 0 => value.min(MAX_BYTES),
        _ => DEFAULT_MAX_BYTES,
    }
}

fn resolve_workspace_path(workspace_root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("path (non-empty string) is required".to_string());
    }
    if trimmed.contains('\0') {
        return Err("path cannot contain NUL bytes".to_string());
    }

    let input_path = PathBuf::from(trimmed);
    let joined = if input_path.is_absolute() {
        input_path
    } else {
        workspace_root.join(input_path)
    };
    let normalized = normalize_path(&joined)?;
    if !is_within_workspace(workspace_root, &normalized) {
        return Err("path must stay within the workspace root".to_string());
    }

    resolve_existing_ancestor(workspace_root, &normalized)
}

fn normalize_path(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("path must not contain `..` components".to_string());
            }
            Component::Normal(part) => normalized.push(part),
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized)
}

fn resolve_existing_ancestor(workspace_root: &Path, target: &Path) -> Result<PathBuf, String> {
    if target.exists() {
        let canonical = fs::canonicalize(target).map_err(|err| {
            format!(
                "failed to resolve target path `{}`: {err}",
                target.to_string_lossy()
            )
        })?;
        if !is_within_workspace(workspace_root, &canonical) {
            return Err("path must stay within the workspace root".to_string());
        }
        return Ok(canonical);
    }

    let mut missing = Vec::new();
    let mut cursor = target;
    while !cursor.exists() {
        let Some(name) = cursor.file_name() else {
            return Err(format!(
                "no existing ancestor found for `{}`",
                target.to_string_lossy()
            ));
        };
        missing.push(name.to_owned());
        cursor = cursor.parent().ok_or_else(|| {
            format!(
                "no existing ancestor found for `{}`",
                target.to_string_lossy()
            )
        })?;
    }

    let mut resolved = fs::canonicalize(cursor).map_err(|err| {
        format!(
            "failed to resolve ancestor `{}`: {err}",
            cursor.to_string_lossy()
        )
    })?;
    if !is_within_workspace(workspace_root, &resolved) {
        return Err("path must stay within the workspace root".to_string());
    }

    for part in missing.iter().rev() {
        resolved.push(part);
    }
    if !is_within_workspace(workspace_root, &resolved) {
        return Err("path must stay within the workspace root".to_string());
    }
    Ok(resolved)
}

fn is_within_workspace(workspace_root: &Path, target: &Path) -> bool {
    target == workspace_root || target.starts_with(workspace_root)
}

fn error_result(path: &str, error: impl Into<String>) -> WorkspaceWriteResult {
    WorkspaceWriteResult {
        ok: false,
        path: path.to_string(),
        bytes_written: 0,
        created: false,
        overwritten: false,
        appended: false,
        error: Some(error.into()),
        change_set: None,
    }
}

fn to_io_error(err: std::io::Error) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    // 真写磁盘的集成测试：create 模式真在磁盘落文件（含 create_dirs 建父目录），
    // 且 confine 拒 ../ 与 workspace 外绝对路径，越界时磁盘上不留任何文件。
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    // (base, workspace)：base 唯一且 canonicalize；workspace = base/ws 也 canonicalize。
    fn unique_workspace() -> (PathBuf, PathBuf) {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut base = std::env::temp_dir();
        base.push(format!("ws_write_it_{}_{}", std::process::id(), seq));
        fs::create_dir_all(&base).expect("create base");
        let base = fs::canonicalize(&base).expect("canonicalize base");
        let ws = base.join("ws");
        fs::create_dir_all(&ws).expect("create ws");
        let ws = fs::canonicalize(&ws).expect("canonicalize ws");
        (base, ws)
    }

    fn root_arg(ws: &Path) -> Option<String> {
        Some(ws.to_string_lossy().into_owned())
    }

    #[test]
    fn create_writes_file_to_disk() {
        // create 模式：磁盘上真出现文件且内容正确，path 为 workspace 相对，created=true。
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking(
            "out/hello.txt".to_string(),
            "written content".to_string(),
            Some("create".to_string()),
            None,
            Some(true), // create_dirs：out/ 不存在，需自动建
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker 层不应报错");
        assert!(result.ok, "create 应成功，错误: {:?}", result.error);
        assert!(result.created, "应标记为新建");
        assert_eq!(result.path, "out/hello.txt", "path 应为 workspace 相对路径");

        let on_disk = fs::read_to_string(ws.join("out/hello.txt")).expect("文件应真出现在磁盘");
        assert_eq!(on_disk, "written content", "磁盘内容应与写入一致");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_parent_escape() {
        // ../ 越界写：结构化失败(ok=false，error 含 ..)，磁盘上不留文件。
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking(
            "../evil.txt".to_string(),
            "nope".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker 层不应报错");
        assert!(!result.ok, "../ 越界写必须失败");
        let err = result.error.unwrap_or_default();
        assert!(err.contains(".."), "应因 .. 被拒，实际: {err}");
        assert!(!base.join("evil.txt").exists(), "越界文件不应被创建");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_absolute_outside_path() {
        // workspace 外绝对路径写：ok=false，磁盘上不留文件。
        let (base, ws) = unique_workspace();
        let outside = base.join("evil.txt");
        let result = write_workspace_file_blocking(
            outside.to_string_lossy().into_owned(),
            "nope".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker 层不应报错");
        assert!(!result.ok, "workspace 外绝对路径写必须失败");
        let err = result.error.unwrap_or_default();
        assert!(
            err.contains("within the workspace root"),
            "应因越界被拒，实际: {err}"
        );
        assert!(!outside.exists(), "越界文件不应被创建");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn successful_write_returns_persisted_change_set() {
        let (base, ws) = unique_workspace();
        let journal = base.join("journal");
        let result = write_workspace_file_blocking_with_journal(
            "new.txt".to_string(),
            "content".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
            Some((
                journal.clone(),
                WorkspaceChangeContext {
                    change_id: "write-change".to_string(),
                    session_id: "session".to_string(),
                    run_id: "run".to_string(),
                    tool_call_id: "call".to_string(),
                },
            )),
        )
        .expect("write journaled file");

        assert_eq!(
            result.change_set.as_ref().map(|change| change.id.as_str()),
            Some("write-change")
        );
        assert!(journal.join("write-change.json").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn archive_path_lock_serializes_owners() {
        let (base, ws) = unique_workspace();
        let target = ws.join("shared.jsonl");
        fs::write(&target, "").expect("create target");
        let first = ArchivePathLock::acquire(&target).expect("acquire first lock");
        let target_for_thread = target.clone();
        let (sender, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let lock = ArchivePathLock::acquire_with(
                &target_for_thread,
                Duration::from_secs(1),
                Duration::from_secs(30),
            )
            .expect("acquire second lock");
            sender.send(()).expect("report acquired");
            lock
        });

        assert!(receiver.recv_timeout(Duration::from_millis(60)).is_err());
        drop(first);
        receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("second owner should acquire after release");
        drop(thread.join().expect("join lock owner"));
        assert!(!archive_lock_path(&target).expect("lock path").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stale_archive_lock_recovery_does_not_remove_replacement() {
        let (base, ws) = unique_workspace();
        let target = ws.join("shared.jsonl");
        fs::write(&target, "").expect("create target");
        let first = ArchivePathLock::acquire(&target).expect("acquire first lock");
        let replacement =
            ArchivePathLock::acquire_with(&target, Duration::from_millis(100), Duration::ZERO)
                .expect("recover stale lock");
        drop(first);
        assert!(archive_lock_path(&target).expect("lock path").exists());
        drop(replacement);
        assert!(!archive_lock_path(&target).expect("lock path").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn automatic_index_compaction_keeps_latest_records_only() {
        let (base, ws) = unique_workspace();
        let index_root = ws.join(".agent-archive/index");
        fs::create_dir_all(&index_root).expect("create index root");
        let target = index_root.join("runs.jsonl");
        let filler = "x".repeat(700);
        let mut text = String::new();
        for status in 0..220 {
            text.push_str(
                &serde_json::json!({
                    "conversationId": "conversation",
                    "runId": "run",
                    "status": status,
                    "summary": filler,
                })
                .to_string(),
            );
            text.push('\n');
        }
        assert!(text.len() as u64 > INDEX_COMPACT_MIN_BYTES);
        fs::write(&target, text).expect("write oversized index");

        maybe_compact_subagent_index(&target).expect("compact index");
        let records: Vec<serde_json::Value> = fs::read_to_string(&target)
            .expect("read compacted index")
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid record"))
            .collect();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["status"], 219);
        assert!(index_root.join(".runs.compact-at").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn index_compaction_uses_the_documented_keys() {
        let agents = [
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-01", "status": "running"}),
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-02", "status": "running"}),
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-01", "status": "completed"}),
        ]
        .into_iter()
        .map(|record| record.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let compacted_agents = compact_subagent_index("agents", &agents).expect("agents compact");
        let agent_records: Vec<serde_json::Value> = compacted_agents
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid agent record"))
            .collect();
        assert_eq!(agent_records.len(), 2);
        assert_eq!(agent_records[1]["path"], "root-01");
        assert_eq!(agent_records[1]["status"], "completed");

        let skills = [
            serde_json::json!({"skillId": "s1", "summary": "old"}),
            serde_json::json!({"skillId": "s2", "summary": "other"}),
            serde_json::json!({"skillId": "s1", "summary": "new"}),
        ]
        .into_iter()
        .map(|record| record.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let compacted_skills = compact_subagent_index("skills", &skills).expect("skills compact");
        let skill_records: Vec<serde_json::Value> = compacted_skills
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid skill record"))
            .collect();
        assert_eq!(skill_records.len(), 2);
        assert_eq!(skill_records[1]["skillId"], "s1");
        assert_eq!(skill_records[1]["summary"], "new");
    }

    #[test]
    fn compaction_failure_preserves_index_and_events_are_never_compacted() {
        let (base, ws) = unique_workspace();
        let index_root = ws.join(".agent-archive/index");
        fs::create_dir_all(&index_root).expect("create index root");
        let index = index_root.join("skills.jsonl");
        let malformed = format!("{{bad}}\n{}", " ".repeat(INDEX_COMPACT_MIN_BYTES as usize));
        fs::write(&index, &malformed).expect("write malformed index");
        let error = maybe_compact_subagent_index(&index).expect_err("malformed index must fail");
        assert!(error.contains("invalid JSON"));
        assert_eq!(
            fs::read_to_string(&index).expect("read preserved index"),
            malformed
        );

        let events = ws.join(".agent-archive/conversations/c/runs/r/events.jsonl");
        fs::create_dir_all(events.parent().expect("events parent")).expect("create events root");
        let event_text = format!("event\n{}", "x".repeat(INDEX_COMPACT_MIN_BYTES as usize));
        fs::write(&events, &event_text).expect("write events");
        maybe_compact_subagent_index(&events).expect("events bypass compaction");
        assert_eq!(fs::read_to_string(events).expect("read events"), event_text);
        let _ = fs::remove_dir_all(&base);
    }
}
