# write_file

Write a small text file inside the current workspace.

## Parameters
- `path` (required): workspace-relative path, or an absolute path that still resolves inside the workspace root.
- `content` (required): text content. Empty string is valid.
- `mode` (optional): `create` (default), `overwrite`, or `append`.
- `expectedOldContent` (optional, `overwrite` only): require the current file to exactly equal this value. It must be the complete, untruncated content, including every final newline; it is not a search snippet.
- `expectedContentHash` (optional, `overwrite` only): require the current file hash to equal a `contentHash` returned by a non-truncated `read_file`. Prefer this over copying `expectedOldContent`.
- `createDirs` (optional): create missing parent directories when `true`.
- `maxBytes` (optional): maximum accepted content size. Defaults to `204800`; values above `1048576` are clamped.

## Guidance
- Prefer `apply_patch` when editing existing source code.
- Use `write_file` for new files, small generated outputs, fixtures, notes, and other text artifacts.
- A successful write returns a reversible `changeSet.id` for `revert_workspace_change`.
- Use `mode: "create"` for new files so an existing file fails instead of being overwritten.
- Use `mode: "overwrite"` only when replacing a whole small file is intentional. First call `read_file`; if it is not truncated, pass its `contentHash` as `expectedContentHash`.
- If `contentHash` is unavailable, pass the entire `read_file.content` as `expectedOldContent` without trimming or normalizing it. Never pass a prefix, excerpt, search match, or truncated read.
- After an optimistic-guard mismatch, re-read the file and reconsider the edit. Do not retry the same guard or silently omit it.
- Use `mode: "append"` only for appending text to a file.
- Do not use this for binary data, large files, or broad source edits.
