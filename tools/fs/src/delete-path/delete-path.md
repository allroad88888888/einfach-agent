# delete_path

Recoverably delete one file or directory inside the current workspace.

## Parameters
- `path` (required): one explicit workspace path. Globs are not expanded.
- `recursive` (optional): must be `true` when deleting a directory.

## Guidance
- Prefer this tool over shell `rm` for workspace files. A successful result includes a reversible `changeSet.id`.
- Use `revert_workspace_change` with that id to restore the deleted path.
- The workspace root, Git metadata, symbolic links, and oversized trees are refused.
- If the original path is recreated later, rollback reports a conflict and does not overwrite it.
- Shell `rm` is permanently destructive and cannot be rolled back. In Auto mode, only critical broad deletes such as `rm -rf *` require explicit confirmation.
