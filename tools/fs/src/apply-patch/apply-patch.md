# apply_patch

Apply structured text edits inside the current workspace, as one transaction.

## When to use this instead of write_file
- **Editing part of a file** — `replace` changes a region without resending the whole file.
- **Several files that must change together** — either every operation applies or none does, so a rejected operation cannot leave the workspace half-migrated.

For writing a single whole file, use `write_file`: it is one call, and it supports modes (`create`/`upsert`/`overwrite`/`append`), binary content, and append that `apply_patch` does not.

Input:

```json
{
  "operations": [
    { "type": "add_file", "path": "relative/path.txt", "content": "new file text", "executable": false },
    { "type": "replace", "path": "relative/path.txt", "oldText": "before", "newText": "after", "expectedReplacements": 1 },
    { "type": "delete_file", "path": "relative/path.txt", "expectedContentHash": "sha256:..." },
    { "type": "overwrite_file", "path": "relative/path.txt", "content": "full new text", "expectedContentHash": "sha256:..." }
  ],
  "dryRun": false
}
```

Rules:

- `operations` is required and must be an array.
- Paths must stay inside the workspace root.
- Files are UTF-8 text only and are limited to 1 MB. For binary content, use `write_file` with `encoding: "base64"`.
- `replace.oldText` must match, and `expectedReplacements` defaults to exactly one replacement.
- The patch is atomic at validation time: if any operation is rejected, no operation is written.
- `dryRun: true` validates and reports `wouldChange` without writing files.

## Optimistic guards
`overwrite_file` requires proof that you read the file first — pass either:
- `expectedContentHash`: the `contentHash` from a non-truncated `read_file`. **Prefer this** — it does not resend the file.
- `oldContent`: the complete, untruncated previous text.

Pass one or the other, never both. `delete_file` accepts the same two guards, optionally. These are the same guard names and semantics as `write_file`.

After a guard mismatch, re-read the file and reconsider the edit. The mismatch means someone else changed it.

## Returns
- `changedFiles`: paths that changed.
- `changes`: per file, `created` / `deleted` and a `changeSummary` with `linesAdded`, `linesRemoved`, and a `diff` of the changed region — the same shape `write_file` returns. Read it to confirm the edit instead of re-reading every touched file.
- `changeSet.id`: pass to `revert_workspace_change` to roll the whole transaction back.

## Other options
- `executable` on `add_file` / `overwrite_file` sets or clears the executable bit, so a generated script is runnable without a follow-up shell call. No effect on Windows.
