# rg_search

Use ripgrep (`rg`) to search source code and text files inside the current workspace.

## Parameters

- `query` (required): search text or regex pattern.
- `path` (optional): workspace-relative file or directory. Defaults to the workspace root.
- `regex` (optional): `false` by default. When false, `query` is treated as a literal string.
- `caseSensitive` (optional): `true` by default, matching ripgrep's normal code-search behavior.
- `globs` (optional): include/exclude glob patterns, such as `*.ts`, `src/**`, or `!dist/**`.
- `contextLines` (optional): number of surrounding context lines, default `0`, max `5`.
- `maxMatches` (optional): maximum total matches returned, default `200`, max `1000`.

## Use

- Use this as the main code-search tool when locating symbols, imports, call sites, warnings, config keys, or TODOs.
- Use `read_file` after `rg_search` when a hit needs more surrounding context.
- Use `search_files` only for simpler plain-text fallback searches.
- Use `git_diff_review` after edits to inspect changed files and diffs.

## Constraints

- This tool is read-only.
- Paths are confined to the workspace root by the Tauri backend.
- It respects ripgrep defaults, including `.gitignore`, unless a glob explicitly narrows or excludes files.
- If ripgrep is not installed, the result is a structured error; do not try to emulate this with shell redirection.
