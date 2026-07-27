# git_diff_review

Read-only Git workspace review tool for checking local changes before a final answer or commit.

## Parameters
- `paths` (optional): list of workspace-relative paths to diff. Omit to review all changed tracked files.
- `staged` (optional): when `true`, read the staged diff (`git diff --cached`). Defaults to `false`.
- `base` (optional): compare against a commit or ref such as `HEAD~1` or `origin/main`. With `staged: true`, compare that base to the index.
- `maxDiffChars` (optional): maximum returned diff characters. Defaults to `20000`, maximum `100000`.
- `includeStat` (optional): include `git diff --stat`. Defaults to `true`.

## Use
- This tool is read-only. It must not modify files, stage changes, commit, reset, or clean the worktree.
- Use it near the end of a task to review `git status --short`, changed files, diff stats, and focused file diffs.
- Use `paths` for large worktrees or when only specific files need review.
- The returned diff may be truncated; request narrower `paths` when more detail is needed.
