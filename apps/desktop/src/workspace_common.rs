// workspace_common.rs —— workspace 文件工具的共享底座（P1 安全 + P2 流式读）。
// -----------------------------------------------------------------------------
// 抽出两块跨模块共享的逻辑，避免 read/write/patch/git 各写各的、逻辑漂移：
//   · resolve_workspace_root —— 可信 workspace root 解析（不再裸用 process cwd）。
//   · read_capped_stop / read_capped_drain —— 带上限的增量读（防大输出全缓冲进内存）。

use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
};

/// 带上限的读结果：已读文本 + 是否被上限截断。
pub struct CappedRead {
    pub text: String,
    pub truncated: bool,
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
