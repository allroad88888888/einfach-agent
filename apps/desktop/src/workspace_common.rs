// workspace_common.rs —— workspace 文件工具的共享底座（P1 安全 + P2 流式读）。
// -----------------------------------------------------------------------------
// 抽出跨模块共享的逻辑，避免 read/write/patch/git 各写各的、逻辑漂移：
//   · resolve_workspace_root —— 可信 workspace root 解析（不再裸用 process cwd）。
//   · read_capped_stop / read_capped_drain —— 带上限的增量读（防大输出全缓冲进内存）。
//   · atomic_write —— 崩溃安全的整文件替换（write/patch 共用同一实现）。

use serde::Serialize;
use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

/// 带上限的读结果：已读文本 + 是否被上限截断。
pub struct CappedRead {
    pub text: String,
    pub truncated: bool,
}

/// 崩溃安全地整体替换一个文件：写同目录临时文件 → fsync → 继承原文件权限位 → rename 覆盖。
///
/// 任何时刻崩溃都只会留下「旧文件」或「新文件」，不会留下写了一半的目标。直接 `fs::write`
/// 是先截断再写，中途断电就是内容丢失 + 原文件不可恢复。
///
/// rename 保留的是临时文件的权限（受 umask 影响），因此必须显式回填原文件权限——
/// 否则一次覆盖就会把脚本的可执行位悄悄抹掉。
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "target path has no parent directory".to_string())?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace-write".to_string());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // 前导点让临时文件在 watcher / 文件列表里保持隐藏，减少对开发工具链的干扰。
    let temporary = parent.join(format!(".{name}.{}-{stamp}.tmp", std::process::id()));

    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&temporary)
            .map_err(|err| format!("failed to create temporary file: {err}"))?;
        file.write_all(content)
            .map_err(|err| format!("failed to write temporary file: {err}"))?;
        file.sync_all()
            .map_err(|err| format!("failed to flush temporary file: {err}"))?;
        drop(file);
        if let Ok(metadata) = fs::metadata(path) {
            let _ = fs::set_permissions(&temporary, metadata.permissions());
        }
        fs::rename(&temporary, path).map_err(|err| format!("failed to replace target file: {err}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// 解析可信的 workspace root（P1 安全修复：桌面 app 的 process cwd 不可控——
/// 可能是 `/`、app bundle、Tauri 工程目录——绝不能拿它当路径限制的可信根）。
///
/// 解析顺序：
///   1. 前端显式传入的 `workspace_root` 有值 → `fs::canonicalize` 它；
///   2. 无 → 在 `env::current_dir()` 下跑 `git rev-parse --show-toplevel` 派生 git 仓库根，canonicalize；
///   3. 都得不到 → 返回 Err（拒绝服务，绝不回退到裸 cwd）。
///
/// 另外拒绝文件系统根（`/`、盘符根等无父目录的路径）——否则整块磁盘都成了「workspace」，
/// confine 形同虚设。
pub fn resolve_workspace_root(explicit: Option<&str>) -> Result<PathBuf, String> {
    let root = match explicit {
        Some(value) if !value.trim().is_empty() => {
            let trimmed = value.trim();
            fs::canonicalize(trimmed)
                .map_err(|err| format!("failed to resolve workspace root `{trimmed}`: {err}"))?
        }
        _ => derive_git_root()?,
    };
    reject_filesystem_root(&root)?;
    Ok(root)
}

fn derive_git_root() -> Result<PathBuf, String> {
    let cwd =
        env::current_dir().map_err(|err| format!("failed to read current directory: {err}"))?;
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output()
        .map_err(|err| format!("failed to run git to derive workspace root: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "cannot derive workspace root: not inside a git repository (pass workspace_root explicitly): {}",
            stderr.trim()
        ));
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("git rev-parse returned an empty workspace root".to_string());
    }
    fs::canonicalize(&root)
        .map_err(|err| format!("failed to resolve workspace root `{root}`: {err}"))
}

fn reject_filesystem_root(root: &Path) -> Result<(), String> {
    // 无父目录 == 文件系统根（unix 的 `/`、windows 的 `C:\`）。拒绝把整块磁盘当 workspace。
    if root.parent().is_none() {
        return Err(format!(
            "refusing to use filesystem root `{}` as workspace root",
            root.to_string_lossy()
        ));
    }
    Ok(())
}

/// 增量读 reader 到 char 上限即停（P2：不把整个流全缓冲进内存）。
/// 达到上限后**不再继续读**——调用方据 `truncated` 杀掉子进程/关闭管道。
/// 与 `read_capped_drain` 的区别：那个会读到 EOF（只是不再追加），本函数遇上限直接 break。
pub fn read_capped_stop<R: Read>(reader: &mut R, max_chars: usize) -> io::Result<CappedRead> {
    let mut output = String::new();
    let mut chars_written = 0usize;
    let mut buffer = [0u8; 8192];

    loop {
        if chars_written >= max_chars {
            return Ok(CappedRead {
                text: output,
                truncated: true,
            });
        }

        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        let chunk = String::from_utf8_lossy(&buffer[..bytes_read]);
        let chunk_chars = chunk.chars().count();
        let remaining = max_chars - chars_written;
        if chunk_chars <= remaining {
            output.push_str(&chunk);
            chars_written += chunk_chars;
        } else {
            output.extend(chunk.chars().take(remaining));
            return Ok(CappedRead {
                text: output,
                truncated: true,
            });
        }
    }

    Ok(CappedRead {
        text: output,
        truncated: false,
    })
}

/// 增量读 reader 到 EOF，但只保留前 max_chars 个字符（多出的部分丢弃、置 truncated）。
/// 会一直读到流关闭——用于必须排空的管道（如子进程 stderr），避免管道撑满造成写端死锁。
pub fn read_capped_drain<R: Read>(mut reader: R, max_chars: usize) -> io::Result<CappedRead> {
    let mut output = String::new();
    let mut chars_written = 0usize;
    let mut truncated = false;
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        let chunk = String::from_utf8_lossy(&buffer[..bytes_read]);
        let chunk_chars = chunk.chars().count();

        if chars_written < max_chars {
            let remaining = max_chars - chars_written;
            if chunk_chars <= remaining {
                output.push_str(&chunk);
                chars_written += chunk_chars;
            } else {
                output.extend(chunk.chars().take(remaining));
                chars_written = max_chars;
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }

    Ok(CappedRead {
        text: output,
        truncated,
    })
}

/// Unified diff lines returned to the model. Enough to confirm an edit landed,
/// small enough to stay out of the way in a tool result.
const DIFF_MAX_LINES: usize = 60;
/// LCS table budget (before_lines * after_lines). Beyond this the changed region
/// is reported as a whole-block replacement instead of a minimal diff.
const DIFF_LCS_BUDGET: usize = 800 * 800;

/// What a write actually changed, so a caller never has to re-read a file just to
/// confirm an edit landed. Shared by write_file and apply_patch so both report the
/// same shape.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSummary {
    pub lines_added: usize,
    pub lines_removed: usize,
    pub before_lines: usize,
    pub after_lines: usize,
    /// Unified diff of the changed region, truncated to `DIFF_MAX_LINES`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    pub diff_truncated: bool,
    /// True when the changed region was too large for a minimal diff and the
    /// counts describe a whole-block replacement instead.
    pub approximate: bool,
}

/// Line-level change summary. The unchanged head and tail are stripped first, and
/// the remaining region is diffed with an LCS only when the table fits in
/// `DIFF_LCS_BUDGET`; past that the region is reported as a block replacement and
/// flagged `approximate`.
pub fn compute_change_summary(before: Option<&str>, after: &str) -> FileChangeSummary {
    let before_lines: Vec<&str> = before.map(|value| value.lines().collect()).unwrap_or_default();
    let after_lines: Vec<&str> = after.lines().collect();

    let mut head = 0;
    while head < before_lines.len()
        && head < after_lines.len()
        && before_lines[head] == after_lines[head]
    {
        head += 1;
    }
    let mut tail = 0;
    while tail < before_lines.len() - head
        && tail < after_lines.len() - head
        && before_lines[before_lines.len() - 1 - tail] == after_lines[after_lines.len() - 1 - tail]
    {
        tail += 1;
    }

    let before_mid = &before_lines[head..before_lines.len() - tail];
    let after_mid = &after_lines[head..after_lines.len() - tail];

    if before_mid.is_empty() && after_mid.is_empty() {
        return FileChangeSummary {
            lines_added: 0,
            lines_removed: 0,
            before_lines: before_lines.len(),
            after_lines: after_lines.len(),
            diff: None,
            diff_truncated: false,
            approximate: false,
        };
    }

    let affordable = before_mid
        .len()
        .checked_mul(after_mid.len())
        .is_some_and(|size| size <= DIFF_LCS_BUDGET);
    let edits = if affordable {
        diff_lines(before_mid, after_mid)
    } else {
        before_mid
            .iter()
            .map(|line| (DiffTag::Remove, *line))
            .chain(after_mid.iter().map(|line| (DiffTag::Add, *line)))
            .collect()
    };

    let lines_removed = edits
        .iter()
        .filter(|(tag, _)| *tag == DiffTag::Remove)
        .count();
    let lines_added = edits.iter().filter(|(tag, _)| *tag == DiffTag::Add).count();

    let mut rendered = vec![format!(
        "@@ -{},{} +{},{} @@",
        head + 1,
        before_mid.len(),
        head + 1,
        after_mid.len()
    )];
    let diff_truncated = edits.len() > DIFF_MAX_LINES;
    for (tag, line) in edits.iter().take(DIFF_MAX_LINES) {
        rendered.push(format!("{}{line}", tag.marker()));
    }
    if diff_truncated {
        rendered.push(format!("... {} more diff lines", edits.len() - DIFF_MAX_LINES));
    }

    FileChangeSummary {
        lines_added,
        lines_removed,
        before_lines: before_lines.len(),
        after_lines: after_lines.len(),
        diff: Some(rendered.join("\n")),
        diff_truncated,
        approximate: !affordable,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DiffTag {
    Keep,
    Add,
    Remove,
}

impl DiffTag {
    fn marker(self) -> char {
        match self {
            DiffTag::Keep => ' ',
            DiffTag::Add => '+',
            DiffTag::Remove => '-',
        }
    }
}

/// Classic LCS diff over the already-trimmed changed region. Callers guarantee
/// `before.len() * after.len() <= DIFF_LCS_BUDGET`.
fn diff_lines<'a>(before: &[&'a str], after: &[&'a str]) -> Vec<(DiffTag, &'a str)> {
    let rows = before.len() + 1;
    let columns = after.len() + 1;
    let mut table = vec![0u32; rows * columns];
    for row in (0..before.len()).rev() {
        for column in (0..after.len()).rev() {
            table[row * columns + column] = if before[row] == after[column] {
                table[(row + 1) * columns + column + 1] + 1
            } else {
                table[(row + 1) * columns + column].max(table[row * columns + column + 1])
            };
        }
    }

    let mut edits = Vec::new();
    let (mut row, mut column) = (0usize, 0usize);
    while row < before.len() && column < after.len() {
        if before[row] == after[column] {
            edits.push((DiffTag::Keep, before[row]));
            row += 1;
            column += 1;
        } else if table[(row + 1) * columns + column] >= table[row * columns + column + 1] {
            edits.push((DiffTag::Remove, before[row]));
            row += 1;
        } else {
            edits.push((DiffTag::Add, after[column]));
            column += 1;
        }
    }
    edits.extend(before[row..].iter().map(|line| (DiffTag::Remove, *line)));
    edits.extend(after[column..].iter().map(|line| (DiffTag::Add, *line)));
    edits
}

// 跨语言对拍：喂 packages/host-node/fixtures/change-summary.json。本文件此前没有 mod tests，
// 所以这一组同时也是 compute_change_summary 在 Rust 侧的第一份测试。
#[cfg(test)]
#[path = "workspace_common_summary_parity_tests.rs"]
mod summary_parity_tests;
