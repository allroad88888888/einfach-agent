# search_files

在文本文件中搜索字符串。Confirm 模式限制在当前 workspace；Auto 模式也允许搜索 workspace 外路径。

## 参数
- `query`（必填）：要查找的非空字符串。
- `path`（可选）：搜索起点，默认 `.`；可以是文件或目录。
- `glob`（可选）：ripgrep glob 文件过滤，例如 `*.ts`、`src/**` 或 `!*.test.ts`。
- `maxMatches`（可选）：最多返回匹配数，默认 `100`，最大 `1000`。

## 返回
- `matches`：匹配数组，每项包含 `path`、`line`、`lineNumber`。
- `truncated`：是否因为匹配上限或文件读取上限被截断。

## 注意
- 需要某个匹配周围的上下文时，把它的 `lineNumber` 直接传给 `read_file.startLine`（配合 `lineCount`），不要从头读整个文件再数行。
- Confirm 模式会拒绝逃逸 workspace root 的路径；Auto 模式可使用绝对路径或包含 `..` 的路径，外部匹配以绝对路径返回。
- 搜索使用普通字符串匹配，不支持正则；优先使用 ripgrep，系统没有 ripgrep 时自动退回内置搜索。
- 二进制或非 UTF-8 文件会被跳过。
