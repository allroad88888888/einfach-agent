# read_file

读取 workspace 内的一个文本文件。

## 参数
- `path`（必填）：workspace 内文件路径，必须是非空字符串。
- `maxBytes`（可选）：最多读取字节数，默认 `20000`，最大 `200000`。

## 返回
- `path`：workspace 相对路径。
- `content`：读取到的 UTF-8 文本内容。
- `truncated`：内容是否因为 `maxBytes` 被截断。
- `bytes`：实际返回内容的字节数。

## 注意
- 路径限制在 workspace root 内，逃逸路径、二进制文件和非 UTF-8 文件会失败。
- 输出可能被截断；需要更多上下文时提高 `maxBytes` 或分段读取更具体的文件。
