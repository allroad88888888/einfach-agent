//! 直接落盘的文件系统原语：新建、追加与可执行位。

use std::{fs, io::Write, path::Path};

pub(super) fn write_create(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(content))
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::AlreadyExists {
                "file already exists; use mode \"overwrite\" only when replacing it is intentional"
                    .to_string()
            } else {
                to_io_error(err)
            }
        })
}

pub(super) fn write_append(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(content))
        .map_err(to_io_error)
}

/// Apply an explicit executable request after the content is in place. A no-op on
/// platforms without a POSIX mode.
#[cfg(unix)]
pub(super) fn apply_executable_bit(path: &Path, executable: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata =
        fs::metadata(path).map_err(|err| format!("failed to inspect file mode: {err}"))?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    // Mirror the read bits: a file readable by group/other becomes executable by them too.
    let updated = if executable {
        mode | ((mode & 0o444) >> 2)
    } else {
        mode & !0o111
    };
    if updated == mode {
        return Ok(());
    }
    permissions.set_mode(updated);
    fs::set_permissions(path, permissions)
        .map_err(|err| format!("failed to update file mode: {err}"))
}

#[cfg(not(unix))]
pub(super) fn apply_executable_bit(_path: &Path, _executable: bool) -> Result<(), String> {
    Ok(())
}

fn to_io_error(err: std::io::Error) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use crate::workspace_write::pipeline::{
        write_workspace_file_blocking, write_workspace_file_blocking_with_options,
    };
    use crate::workspace_write::test_support::{root_arg, unique_workspace};
    use std::fs;

    #[test]
    fn create_existing_file_returns_actionable_error() {
        let (base, ws) = unique_workspace();
        fs::write(ws.join("existing.txt"), "old").expect("seed existing file");

        let result = write_workspace_file_blocking(
            "existing.txt".to_string(),
            "new".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker layer should return a structured rejection");

        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some(
                "file already exists; use mode \"overwrite\" only when replacing it is intentional"
            )
        );
        assert_eq!(
            fs::read_to_string(ws.join("existing.txt")).expect("existing file remains readable"),
            "old"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn overwrite_preserves_the_executable_bit() {
        // 原子写是 temp+rename，rename 会带走 temp 的 umask 权限；不显式回填就会把
        // 脚本的可执行位悄悄抹掉。
        use std::os::unix::fs::PermissionsExt;
        let (base, ws) = unique_workspace();
        let target = ws.join("run.sh");
        fs::write(&target, "#!/bin/sh\necho old\n").expect("seed script");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).expect("chmod");

        let result = write_workspace_file_blocking(
            "run.sh".to_string(),
            "#!/bin/sh\necho new\n".to_string(),
            Some("overwrite".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("overwrite script");
        assert!(result.ok, "错误: {:?}", result.error);

        let mode = fs::metadata(&target).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o755, "覆盖后应保留可执行位");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn atomic_write_leaves_no_temporary_files_behind() {
        let (base, ws) = unique_workspace();
        let target = ws.join("data.txt");
        fs::write(&target, "old\n").expect("seed");

        write_workspace_file_blocking(
            "data.txt".to_string(),
            "new\n".to_string(),
            Some("overwrite".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("overwrite")
        .ok
        .then_some(())
        .expect("overwrite should succeed");

        let leftovers: Vec<_> = fs::read_dir(&ws)
            .expect("read workspace")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件: {leftovers:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn executable_flag_sets_and_clears_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let (base, ws) = unique_workspace();

        let created = write_workspace_file_blocking_with_options(
            "bin/run.sh".to_string(),
            "#!/bin/sh\n".to_string(),
            Some("create".to_string()),
            root_arg(&ws),
            None,
            Some(true),
            None,
        )
        .expect("create executable");
        assert!(created.ok, "错误: {:?}", created.error);
        let mode = fs::metadata(ws.join("bin/run.sh"))
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o100, 0o100, "owner 执行位应被置上");

        let cleared = write_workspace_file_blocking_with_options(
            "bin/run.sh".to_string(),
            "#!/bin/sh\necho hi\n".to_string(),
            Some("overwrite".to_string()),
            root_arg(&ws),
            None,
            Some(false),
            None,
        )
        .expect("clear executable");
        assert!(cleared.ok);
        let mode = fs::metadata(ws.join("bin/run.sh"))
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0, "显式 false 应清掉执行位");
        let _ = fs::remove_dir_all(&base);
    }
}
