# 020 独立审查

结论：**APPROVED**。唯一 content hash owner、三条消费路径、编码/格式/错误契约、旧 owner 删除及行数要求均通过；仅有两处不影响行为的陈旧说明。

## 质量发现

### Critical

- 无。

### Important

- 无。

### Minor

1. `packages/host-node/src/workspace/write/guard.test.ts:82-83` 的注释仍称同一固定向量也位于 `read/content.test.ts`；本次已将这些向量迁至 `common/contentHash.test.ts`，该位置说明已过时。测试本身仍直接使用 FIPS `abc` 固定值，真实性不受影响。
2. 实施报告 `020-report.md:7`、`:45-60` 把任务卡验收命令描述成宽泛的 `createHash('sha256')` 搜索并据此留下 concern；当前任务卡 `020-workspace-content-hash-owner.md:52,59` 已明确检查 `function contentSha256` 的定义数，并裁决其它 fingerprint 属不同协议。实际执行精确命令只命中新 owner 一处，因此该 concern 已不成立，但不影响产品实现。

## 逐条验收

### 1. `contentSha256(bytes)` 唯一 owner

通过。

- `packages/host-node/src/workspace/common/contentHash.ts:14-15` 是 `contentSha256(bytes: Uint8Array): string` 的实现，输出为 `sha256:` 加 SHA-256 小写 hex。
- 精确执行任务卡命令 `rg -n "function contentSha256" packages/host-node/src/workspace`，只返回 `workspace/common/contentHash.ts:14`。
- 遵照任务卡 `:59` 的裁决，没有把 journal、path、run-index 等不同输入、格式与信任边界的 SHA-256 fingerprint 视为本协议副本，也没有要求它们合并。

### 2. read/write/patch 直接消费且旧模块删除

通过。

- 字节读取在 `read/bytesRead.ts:51` 直接导入 owner，并在 `:192` 对读取到的整文件原始 `Buffer` 求 hash。
- 行读取在 `read/linesRead.ts:45` 直接导入 owner，并在 `:149` 对完整原始 `Buffer` 求 hash。
- 写守卫在 `write/guard.ts:25-29` 直接从 `../common/contentHash` 导入协议 API，并在 `:60` 调用。
- patch 守卫在 `patch/guard.ts:13-17` 直接从 `../common/contentHash` 导入协议 API，并在 `:40` 调用。
- `workspace/change/contentHash.ts` 与对应测试在基线 diff 中均为删除状态，当前文件已不存在；`read/content.ts` 的本地 SHA-256 实现已删除，当前只保留读取内容的二进制拒绝与 UTF-8 解码职责。
- 精确符号检索未发现任务范围内从旧 change owner 或 `read/content` 转发/导入 `contentSha256` 的兼容层。

### 3. UTF-8、输出格式与错误语义

通过。

- 公共 owner 接受字节而非字符串（`common/contentHash.ts:14`），read 两路径直接传原始字节，避免解码后再编码造成协议分叉。
- write 与 patch 的字符串调用点分别在 `write/guard.ts:60`、`patch/guard.ts:40` 使用 `Buffer.from(current, 'utf8')` 显式编码。基线旧实现是 `createHash(...).update(content, 'utf8')`；范围内 diff 证明迁移后编码语义等价。
- `common/contentHash.ts:3-6` 保留原错误常量文本和严格正则 `^sha256:[0-9a-f]{64}$`，只接受带前缀的 64 位小写 hex。
- write 的格式失败仍经 `rejectWrite(CONTENT_HASH_FORMAT_ERROR)`（`write/guard.ts:58-64`），hash 不匹配仍产生原 `WriteRejection` 文案；patch 仍分别抛原格式错误与原不匹配错误（`patch/guard.ts:36-43`）。diff 除 import 来源和显式编码外未改这些分支、顺序或文案。

### 4. 测试真实性与覆盖

通过。

- `common/contentHash.test.ts:7-13` 用硬编码摘要覆盖空串、ASCII `abc` 和多字节 UTF-8 `你好`；期望值不是由被测实现生成。
- `common/contentHash.test.ts:15-22` 同时验证合法值，以及缺前缀、大写、尾随换行、长度不足和非 hex 字符等严格格式反例。
- `write/guard.test.ts:81-107` 以独立固定的 FIPS `abc` 向量验证通过、不匹配文案和格式错误；即使公共实现漂移也不会由自生成 oracle 掩盖。
- `patch/guard.test.ts:26-58` 覆盖多字节 UTF-8、空文件、不匹配和严格格式错误；其 helper 使用公共 owner，验证的是 guard 接线，而算法正确性由公共固定向量独立锁定。
- `read/bytesRead.test.ts:47,64,133,148-149` 与 `read/linesRead.test.ts:203,215-216` 覆盖读取结果、空文件、整文件 hash 与截断内容 hash 的区别；由公共固定向量测试兜底算法正确性，未形成只靠两份实现“对拍”的副本。
- 按 reviewer 指令未重跑实施报告声称已运行的命令。报告 `020-report.md:30-38` 记录指定 6 文件/79 测试通过、整个 workspace 99 文件/1040 测试通过，以及依赖产物重建后 host-node build 完整通过。

### 5. 文件职责与 `wc -l <= 300`

通过。现存任务文件的物理行数如下：

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `common/contentHash.ts` | 16 | 定义 workspace content hash 协议 |
| `common/contentHash.test.ts` | 24 | 验证 content hash 协议 |
| `read/content.ts` | 64 | 将读取字节收窄为合法文本 |
| `read/content.test.ts` | 56 | 验证读取字节到合法文本的收窄 |
| `read/bytesRead.ts` | 220 | 实现按字节读取 workspace 文件 |
| `read/bytesRead.test.ts` | 246 | 验证按字节读取 |
| `read/linesRead.ts` | 201 | 实现按行读取 workspace 文件 |
| `read/linesRead.test.ts` | 300 | 验证按行读取 |
| `write/guard.ts` | 102 | 校验 workspace 写入乐观锁 |
| `write/guard.test.ts` | 107 | 验证写入乐观锁 |
| `patch/guard.ts` | 46 | 校验 workspace patch 乐观锁 |
| `patch/guard.test.ts` | 60 | 验证 patch 乐观锁 |

全部不超过 300 行；两个已删除旧 owner 文件不再计现存行数。职责均可用一句不含“和/以及”的话描述，未见大杂烩或为凑行数的假拆分。`read/linesRead.test.ts` 恰为上限 300 行，本次只改一条 import，未突破硬限制。

## 范围与提交隔离

- 相对基线 `c804cd4`，任务卡范围内为 2 个新增文件、2 个删除文件、9 个修改文件；`write/guard.test.ts` 列在任务卡内但内容未变。
- 已跟踪 diff 仅包含 owner 迁移、直接接线、显式 UTF-8 编码、测试 import/oracle 迁移及相应职责注释收敛；新增实现和测试也都在任务卡 files 内。
- 对任务文件执行的 `git diff --check c804cd4 -- ...` 无输出。按要求未检查或评价已提交 017/019 与并行 018 的改动，未修改产品代码、任务文档，也未提交。
