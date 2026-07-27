# read_file

读取一个文本文件。Confirm 模式限制在当前 workspace；Auto 模式也允许读取 workspace 外路径。

## 参数
- `path`（必填）：文件路径，必须是非空字符串。Auto 模式可使用绝对路径或包含 `..` 的路径。
- `maxBytes`（可选）：最多读取字节数，默认 `20000`，最大 `200000`。

## 返回
- `path`：workspace 内返回相对路径；workspace 外返回绝对路径。
- `content`：读取到的 UTF-8 文本内容。
- `truncated`：内容是否因为 `maxBytes` 被截断。
- `bytes`：实际返回内容的字节数。
- `contentHash`：仅在读取完整、未截断时返回的 `sha256:` 哈希。整体覆盖文件时，将它作为 `write_file.expectedContentHash` 传回可防止覆盖读取后发生的并发修改。

## 注意
- Confirm 模式会拒绝逃逸 workspace root 的路径；Auto 模式允许读取外部路径。二进制文件和非 UTF-8 文件仍会失败。
- 输出可能被截断；需要更多上下文时提高 `maxBytes` 或分段读取更具体的文件。
- `contentHash` 只对应完整文件；截断读取不会返回它。
