# rg_search

Use ripgrep (`rg`) to search source code and text files. Confirm mode is confined to the current workspace; Auto mode may also search external paths.

## Parameters

- `query` (required): search text or regex pattern.
- `path` (optional): file or directory. Defaults to the workspace root. Auto mode accepts absolute paths and paths containing `..`.
- `regex` (optional): `false` by default. When false, `query` is treated as a literal string.
- `caseSensitive` (optional): `true` by default, matching ripgrep's normal code-search behavior.
- `globs` (optional): include/exclude glob patterns, such as `*.ts`, `src/**`, or `!dist/**`.
- `contextLines` (optional): number of surrounding context lines, default `0`, max `5`.
- `maxMatches` (optional): maximum total matches returned, default `200`, max `1000`.

## Use

- Use this as the main code-search tool when locating symbols, imports, call sites, warnings, config keys, or TODOs.
- Use `read_file` after `rg_search` when a hit needs more surrounding context: pass the hit's `lineNumber` straight to `read_file.startLine` (with `lineCount`) instead of reading the file from the top and counting lines.
- Use `search_files` only for simpler plain-text fallback searches.
- Use `git_diff_review` after edits to inspect changed files and diffs.

## Constraints

- This tool is read-only.
- Confirm mode rejects paths outside the workspace root. Auto mode allows external paths and returns external matches with absolute paths.
- It respects ripgrep defaults, including `.gitignore`, unless a glob explicitly narrows or excludes files.
- If ripgrep is not installed, the result is a structured error; do not try to emulate this with shell redirection.
