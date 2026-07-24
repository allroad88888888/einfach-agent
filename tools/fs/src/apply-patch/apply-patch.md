# apply_patch

Apply structured text edits inside the current workspace. Use this tool for file changes instead of shell redirection or ad hoc scripts.

Input:

```json
{
  "operations": [
    { "type": "add_file", "path": "relative/path.txt", "content": "new file text" },
    { "type": "replace", "path": "relative/path.txt", "oldText": "before", "newText": "after", "expectedReplacements": 1 },
    { "type": "delete_file", "path": "relative/path.txt", "oldContent": "optional exact old file text" },
    { "type": "overwrite_file", "path": "relative/path.txt", "content": "full new text", "oldContent": "required when the file exists" }
  ],
  "dryRun": false
}
```

Rules:

- `operations` is required and must be an array.
- Paths must stay inside the workspace root.
- Files are UTF-8 text only and are limited to 1 MB.
- `replace.oldText` must match, and `expectedReplacements` defaults to exactly one replacement.
- The patch is atomic at validation time: if any operation is rejected, no operation is written.
- `dryRun: true` validates and reports `wouldChange` without writing files.
- A successful write returns a reversible `changeSet.id` for `revert_workspace_change`.
