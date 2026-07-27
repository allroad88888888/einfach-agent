# read_file

读取一个文本文件。Confirm 模式限制在当前 workspace；Auto 模式也允许读取 workspace 外路径。

## 参数
- `path`（必填）：文件路径，必须是非空字符串。Auto 模式可使用绝对路径或包含 `..` 的路径。
- `maxBytes`（可选）：最多读取字节数，默认 `20000`，最大 `200000`。
- `offset`（可选）：从指定 UTF-8 字节偏移开始读取，默认 `0`。连续读取时应原样使用上次返回的 `nextOffset`。
- `startLine`（可选）：从第几行开始读，1-based。**拿到行号时用它**——`rg_search` 的 `lineNumber`、编译错误、栈回溯、diff 给出的都是行号，直接传进来即可，不必整段读回来自己数行。
- `lineCount`（可选）：从 `startLine` 起读多少行，默认读到文件末尾。

`offset` 与 `startLine` 是两种定位方式，不能同时使用（`offset` 为 0 不算冲突）。行定位的续读用 `nextLine`，字节定位的续读用 `nextOffset`。

## 返回
- `path`：workspace 内返回相对路径；workspace 外返回绝对路径。
- `content`：读取到的 UTF-8 文本内容。
- `truncated`：内容是否因为 `maxBytes` 被截断。
- `bytes`：实际返回内容的字节数。
- `offset` / `totalBytes`：本段起始偏移与读取时的文件总字节数。
- `nextOffset`：仍有内容时返回；将它作为下一次 `offset` 可无损继续读取。
- `startLine` / `endLine` / `totalLines`：仅行定位读取时返回，分别是本段首行、末行（含）与文件总行数。
- `nextLine`：行定位读取且后面仍有内容时返回；作为下一次 `startLine` 即可继续。
- `contentHash`：**整个文件**的 `sha256:` 哈希，在起始段读取（`offset` 为 0 或省略）时返回，即使本次内容被 `maxBytes` 截断也照样给出。整体覆盖该文件时把它作为 `write_file.expectedContentHash` 或 `apply_patch` 的 `expectedContentHash` 传回，可防止覆盖掉读取之后发生的并发修改。

## 注意
- Confirm 模式会拒绝逃逸 workspace root 的路径；Auto 模式允许读取外部路径。二进制文件和非 UTF-8 文件仍会失败。
- 输出可能被截断；需要更多内容时提高 `maxBytes`，或用返回的 `nextOffset` 分段继续。
- `contentHash` 始终描述整个文件，不描述本段内容，因此只在起始段返回；续读段（`offset > 0`）不再重复给出。要拿它就用首段那次读取的返回值。
- 文件超过 8 MB 时不返回 `contentHash`：那已超出 `write_file` 能整体覆盖的上限，哈希拿到也用不上。
- 行定位需要先看过目标行之前的全部字节，因此同样限制在 8 MB 内；更大的文件请改用 `offset` / `nextOffset` 分段。
- 行定位保留每行原本的行尾（CRLF 文件读出来仍是 CRLF），返回内容与磁盘逐字节一致，可直接用作 `apply_patch` 的 `oldText`。
- `maxBytes` 在行定位下按整行截断，不会返回半行。
