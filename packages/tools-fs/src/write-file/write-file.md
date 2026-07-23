# write_file

Write a small text file inside the current workspace.

## Parameters
- `path` (required): workspace-relative path, or an absolute path that still resolves inside the workspace root.
- `content` (required): text content. Empty string is valid.
- `mode` (optional): `create` (default), `overwrite`, or `append`.
- `expectedOldContent` (optional): when using `overwrite`, require the current file content to match this value before writing.
- `createDirs` (optional): create missing parent directories when `true`.
- `maxBytes` (optional): maximum accepted content size. Defaults to `204800`; values above `1048576` are clamped.

## Guidance
- Prefer `apply_patch` when editing existing source code.
- Use `write_file` for new files, small generated outputs, fixtures, notes, and other text artifacts.
- Use `mode: "create"` for new files so an existing file fails instead of being overwritten.
- Use `mode: "overwrite"` only when replacing a whole small file is intentional. Pass `expectedOldContent` when you know the previous content.
- Use `mode: "append"` only for appending text to a file.
- Do not use this for binary data, large files, or broad source edits.
