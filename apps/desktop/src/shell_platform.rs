//! 目标平台校验、宿主 shell 选择与 cwd 解析。

use super::types::ShellSpec;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub(super) fn parse_platform(platform: &str) -> Result<&'static str, String> {
    match platform {
        "macos" => Ok("macos"),
        "linux" => Ok("linux"),
        "windows" => Ok("windows"),
        _ => Err(format!(
            "unsupported platform `{platform}`; expected `macos`, `linux`, or `windows`"
        )),
    }
}

pub(super) fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unsupported"
    }
}

pub(super) fn resolve_shell(platform: &str) -> Result<ShellSpec, String> {
    match platform {
        "macos" => Ok(ShellSpec {
            program: "/bin/zsh",
            args: &["-lc"],
            display: "/bin/zsh -lc".to_string(),
        }),
        "linux" => {
            if Path::new("/bin/bash").exists() {
                Ok(ShellSpec {
                    program: "/bin/bash",
                    args: &["-lc"],
                    display: "/bin/bash -lc".to_string(),
                })
            } else if Path::new("/bin/sh").exists() {
                Ok(ShellSpec {
                    program: "/bin/sh",
                    args: &["-lc"],
                    display: "/bin/sh -lc".to_string(),
                })
            } else {
                Err("no supported Linux shell found: expected `/bin/bash` or `/bin/sh`".to_string())
            }
        }
        "windows" => Ok(ShellSpec {
            program: "powershell.exe",
            args: &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
            display: "powershell.exe -NoLogo -NoProfile -NonInteractive -Command".to_string(),
        }),
        _ => Err(format!("unsupported platform `{platform}`")),
    }
}

pub(super) fn resolve_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
    let cwd_path = match cwd {
        Some(path) if path.trim().is_empty() => {
            return Err("cwd cannot be empty".to_string());
        }
        Some(path) => PathBuf::from(path),
        None => {
            env::current_dir().map_err(|err| format!("failed to read current directory: {err}"))?
        }
    };

    let metadata = fs::metadata(&cwd_path).map_err(|err| {
        format!(
            "cwd `{}` is not accessible: {err}",
            cwd_path.to_string_lossy()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "cwd `{}` is not a directory",
            cwd_path.to_string_lossy()
        ));
    }

    fs::canonicalize(&cwd_path).map_err(|err| {
        format!(
            "failed to resolve cwd `{}`: {err}",
            cwd_path.to_string_lossy()
        )
    })
}
