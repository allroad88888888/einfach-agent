//! 可恢复删除与路径搬运所需的文件树原语：复制、指纹、移动。

use sha2::{Digest, Sha256};
use std::{fs, path::Path};

pub(crate) fn copy_path(source: &Path, destination: &Path) -> Result<(), String> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err(format!(
            "destination already exists: `{}`",
            destination.display()
        ));
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|err| format!("failed to inspect `{}`: {err}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symbolic links are not supported by recoverable delete: `{}`",
            source.display()
        ));
    }
    if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create `{}`: {err}", parent.display()))?;
        }
        fs::copy(source, destination).map_err(|err| {
            format!(
                "failed to copy `{}` to `{}`: {err}",
                source.display(),
                destination.display()
            )
        })?;
        fs::set_permissions(destination, metadata.permissions())
            .map_err(|err| format!("failed to preserve permissions: {err}"))?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!(
            "unsupported file type for recoverable delete: `{}`",
            source.display()
        ));
    }
    fs::create_dir(destination)
        .map_err(|err| format!("failed to create `{}`: {err}", destination.display()))?;
    let copy_result = (|| {
        for child in fs::read_dir(source)
            .map_err(|err| format!("failed to read `{}`: {err}", source.display()))?
        {
            let child = child.map_err(|err| format!("failed to read directory entry: {err}"))?;
            copy_path(&child.path(), &destination.join(child.file_name()))?;
        }
        fs::set_permissions(destination, metadata.permissions())
            .map_err(|err| format!("failed to preserve permissions: {err}"))
    })();
    if copy_result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    copy_result
}

pub(crate) fn path_fingerprint(path: &Path) -> Result<String, String> {
    fn hash_path(path: &Path, relative: &Path, hasher: &mut Sha256) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|err| format!("failed to inspect `{}`: {err}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "symbolic links are not supported: `{}`",
                path.display()
            ));
        }
        hasher.update(relative.to_string_lossy().as_bytes());
        if metadata.is_file() {
            hasher.update(b"file\0");
            hasher.update(
                fs::read(path)
                    .map_err(|err| format!("failed to read `{}`: {err}", path.display()))?,
            );
        } else if metadata.is_dir() {
            hasher.update(b"dir\0");
            let mut children = fs::read_dir(path)
                .map_err(|err| format!("failed to read `{}`: {err}", path.display()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("failed to read directory entry: {err}"))?;
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                hash_path(&child.path(), &relative.join(child.file_name()), hasher)?;
            }
        } else {
            return Err(format!("unsupported file type: `{}`", path.display()));
        }
        Ok(())
    }
    let mut hasher = Sha256::new();
    hash_path(path, Path::new("."), &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn move_path(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create `{}`: {err}", parent.display()))?;
    }
    if fs::rename(source, destination).is_ok() {
        return Ok(());
    }
    copy_path(source, destination)?;
    let metadata = fs::symlink_metadata(source)
        .map_err(|err| format!("failed to inspect `{}`: {err}", source.display()))?;
    let removed = if metadata.is_dir() {
        fs::remove_dir_all(source)
    } else {
        fs::remove_file(source)
    };
    if let Err(error) = removed {
        if destination.is_dir() {
            let _ = fs::remove_dir_all(destination);
        } else {
            let _ = fs::remove_file(destination);
        }
        return Err(format!(
            "failed to remove copied source `{}`: {error}",
            source.display()
        ));
    }
    Ok(())
}
