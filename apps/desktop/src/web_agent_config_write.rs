use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const TEMPORARY_ATTEMPTS: u8 = 5;

/**
 * 把字节原子落盘到配置文件：先写同目录临时文件、同步、收紧权限，再 rename 覆盖目标。
 * Unix 上目录固定为 `0700`、文件固定为 `0600`。
 */
pub fn write_restricted_atomically(path: &Path, contents: &[u8]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "模型配置文件路径无效".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "模型配置文件路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|_| "无法创建模型配置目录".to_string())?;
    restrict_directory(directory)?;

    for attempt in 0..TEMPORARY_ATTEMPTS {
        let temporary = temporary_path(directory, file_name, attempt);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建临时模型配置文件".to_string()),
        };
        let result = (|| {
            file.write_all(contents)
                .map_err(|_| "无法写入模型配置文件".to_string())?;
            file.sync_all()
                .map_err(|_| "无法同步模型配置文件".to_string())?;
            restrict_file(&temporary)?;
            fs::rename(&temporary, path).map_err(|_| "无法更新模型配置文件".to_string())?;
            sync_directory(directory)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        return result;
    }
    Err("无法创建临时模型配置文件".to_string())
}

fn temporary_path(directory: &Path, file_name: &str, attempt: u8) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    directory.join(format!(
        ".{file_name}-{}-{nanos}-{attempt}.tmp",
        std::process::id()
    ))
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法保护模型配置目录".to_string())
}

#[cfg(not(unix))]
fn restrict_directory(_: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "无法保护模型配置文件".to_string())
}

#[cfg(not(unix))]
fn restrict_file(_: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "无法同步模型配置目录".to_string())
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> Result<(), String> {
    Ok(())
}
