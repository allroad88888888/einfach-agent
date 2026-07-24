# list_files

列出 workspace 内目录的文件项。

## 参数
- `path`（可选）：workspace 内目录路径，默认 `.`。
- `recursive`（可选）：是否递归列出子目录，默认 `false`。
- `maxEntries`（可选）：最多返回条目数，默认 `200`，最大 `2000`。
- `includeHidden`（可选）：是否包含以 `.` 开头的隐藏项，默认 `false`。

## 返回
- `entries`：文件项数组，每项包含 `path`、`type`，文件项可带 `size`。
- `truncated`：是否因为 `maxEntries` 被截断。

## 注意
- 路径限制在 workspace root 内，逃逸路径会失败。
- `type` 可能是 `file`、`directory`、`symlink` 或 `other`。
