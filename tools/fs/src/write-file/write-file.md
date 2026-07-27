# write_file

Write a file inside the current workspace.

## Parameters
- `path` (required): workspace-relative path, or an absolute path that still resolves inside the workspace root.
- `content` (required): the content to write. Empty string is valid.
- `mode` (optional): `create` (default), `upsert`, `overwrite`, or `append`.
- `encoding` (optional): `utf8` (default) or `base64`. Use `base64` for binary files.
- `executable` (optional): set (`true`) or clear (`false`) the executable bit after writing. Omit to keep the existing mode. No effect on Windows.
- `dryRun` (optional): validate everything, including optimistic guards, and report what would change without touching disk.
- `expectedOldContent` (optional): require the current file to exactly equal this value. It must be the complete, untruncated content, including every final newline; it is not a search snippet.
- `expectedContentHash` (optional): require the current file hash to equal a `contentHash` returned by `read_file`. Prefer this over copying `expectedOldContent`.
- `createDirs` (optional): create missing parent directories. Defaults to `true`; pass `false` to require an existing parent.

Content is limited to 8 MB.

## Choosing a mode
- `create` — a genuinely new file. Fails if the path already exists, so it cannot clobber anything.
- `upsert` — write the file whether or not it exists. Use this when you have not read the path and do not want to spend a round trip finding out.
- `overwrite` — replace a file you know exists. Fails if it does not, which catches a wrong path instead of silently creating one.
- `append` — add content to the end of a file.

## Returns
- `created` / `overwritten` / `appended`: which of them actually happened. Under `upsert` these tell you which branch was taken.
- `changeSummary`: `linesAdded`, `linesRemoved`, `beforeLines`, `afterLines`, and a `diff` of the changed region. Read it to confirm the edit landed as intended — do not re-read the file just to check.
  - `diffTruncated` means the diff was cut to a line budget; the counts are still exact.
  - `approximate` means the changed region was too large to diff minimally, so the counts are an upper bound.
  - Absent for binary content and when the previous content could not be read as text.
- `reversible`: whether this write can be rolled back. When it is `false`, `reversibleReason` says why, and there is no `changeSet.id`.
- `changeSet.id`: pass to `revert_workspace_change` to roll the write back.
- Under `dryRun`, nothing is written: `bytesWritten` is `0`, `dryRun` is `true`, and `wouldChange` reports whether the file would actually differ.

## Reversibility
Most writes are reversible. These succeed but cannot be rolled back, and say so via `reversible: false`:
- binary content (`encoding: "base64"` that does not decode to text) — the rollback journal stores text,
- a resulting file larger than 1 MB,
- a target whose previous content could not be read as UTF-8 text.

This is a deliberate trade: the write is allowed and the limitation is reported, rather than the write being refused.

## Choosing between write_file and apply_patch
The line is the transaction boundary, not the file type:
- **One whole file** → `write_file`. Only it has modes, `append`, and binary content.
- **Part of a file** → `apply_patch` with `replace`, so you do not resend the whole file.
- **Several files that must land together** → `apply_patch`, which applies all operations or none.

Both accept the same `expectedContentHash` guard with the same meaning.

## Guidance
- Before an `overwrite` or a guarded `upsert`/`append`, call `read_file` and pass its `contentHash` as `expectedContentHash`. `contentHash` covers the whole file and is returned even when the read itself was truncated, so a large file is still protected — you do not need to page through it first.
- Only if `contentHash` is absent (files over 8 MB), pass the entire `read_file.content` as `expectedOldContent` without trimming or normalizing it. Never pass a prefix, excerpt, search match, or truncated read.
- After a guard mismatch, re-read the file and reconsider the edit. Do not retry the same guard or silently drop it — the mismatch means someone else changed the file.
- Guard an `append` when you may retry it. Without a guard, a retried append cannot tell "my write was lost" from "my write landed", so it can only duplicate content.
- A guard requires the file to exist; on a missing file the call is rejected rather than creating one, because the guard states an assumption about previous content.
- Overwrites are atomic (written to a temp file, then renamed) and preserve the existing file's permission bits, so an interrupted write cannot leave a truncated file.
