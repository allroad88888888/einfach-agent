# list_files

列出目录文件项。Confirm 模式限制在当前 workspace；Auto 模式也允许列出 workspace 外目录。

## 参数
- `path`（可选）：目录路径，默认 `.`。Auto 模式可使用绝对路径或包含 `..` 的路径。
- `recursive`（可选）：是否递归列出子目录，默认 `false`。
- `maxEntries`（可选）：最多返回条目数，默认 `200`，最大 `2000`。
- `includeHidden`（可选）：是否包含以 `.` 开头的隐藏项，默认 `false`。

## 返回
- `entries`：文件项数组，每项包含 `path`、`type`，文件项可带 `size`。
- `truncated`：是否因为 `maxEntries` 被截断。

## 注意
- Confirm 模式会拒绝逃逸 workspace root 的路径；Auto 模式允许外部路径，外部条目以绝对路径返回。
- `type` 可能是 `file`、`directory`、`symlink` 或 `other`。
