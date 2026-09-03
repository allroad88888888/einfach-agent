# 020 workspace content hash owner 实施报告

## 结论

DONE_WITH_CONCERNS。workspace 乐观并发协议的 `sha256:<64 lowercase hex>` 已收敛到唯一字节级 owner，read、write 与 patch 均直接消费该 owner；指定测试、整个 workspace 测试域和 host-node build 均通过。

唯一 concern 是任务卡验收标准 1 的字面 `rg` 命令会合法命中范围外的不同 SHA-256 协议，因此无法在本任务 files 边界内达到“只有一行”；这不影响 content hash owner 的实际唯一性。

## 实现

- 新增 `packages/host-node/src/workspace/common/contentHash.ts`：
  - `contentSha256(bytes: Uint8Array): string` 是乐观并发 content hash 的唯一 SHA-256 实现。
  - `hasValidContentHashFormat(value)` 与 `CONTENT_HASH_FORMAT_ERROR` 与 hash 格式同属该协议模块。
- 删除 `workspace/change/contentHash.ts` 及其测试，不保留 string 版的算法 owner 或兼容转发层。
- 从 `workspace/read/content.ts` 移除第二份 SHA-256 实现，该文件恢复为仅负责二进制拒读与 UTF-8 解码。
- `read/bytesRead.ts` 与 `read/linesRead.ts` 直接导入 `../common/contentHash`，对文件原始字节计算 hash。
- `write/guard.ts` 与 `patch/guard.ts` 直接导入共享 owner，并在调用点用 `Buffer.from(current, 'utf8')` 将字符串显式编码为字节。
- 读路径和 patch guard 测试不再从旧 read/change owner 取 hash；公共协议测试独立锁定空串、ASCII、多字节 UTF-8 以及严格格式。

## 行为与兼容性

- 输出仍为 `sha256:` 加 64 位小写 hex。
- 空文件、ASCII 和多字节 UTF-8 的固定向量与收敛前一致。
- read 仍哈希文件原始字节；严格 UTF-8 解码成功时，mutation guard 对文本的 UTF-8 重编码与 read 原始字节相同。
- 不合法 expected hash 的错误常量和严格格式判定保持不变；write 仍产生 `WriteRejection`，patch 仍抛原有 `Error` 文案。
- 全 workspace 测试域通过，覆盖 read handler、write pipeline、patch staging/guard 等上层消费者。

## 验证证据

1. 任务卡指定命令：
   - `pnpm exec vitest run packages/host-node/src/workspace/common/contentHash.test.ts packages/host-node/src/workspace/read/content.test.ts packages/host-node/src/workspace/read/bytesRead.test.ts packages/host-node/src/workspace/read/linesRead.test.ts packages/host-node/src/workspace/write/guard.test.ts packages/host-node/src/workspace/patch/guard.test.ts`
   - 结果：6 files passed，79 tests passed。
2. 整个 workspace 域：
   - `pnpm exec vitest run packages/host-node/src/workspace`
   - 结果：99 files passed，1040 tests passed。
3. 构建：
   - 首次 host-node build 的 tsup 成功，但 tsc 因本地 `@einfach-agent/persistence-sqlite` 旧 dist 未暴露源码中已有的 `createSqliteRecoveryReader` 而失败，与本任务无关。
   - 只重建该 workspace 依赖产物后，`pnpm --filter @einfach-agent/host-node build` 完整通过（tsup + tsc + d.ts specifier fix）。
4. 静态核查：
   - `contentSha256` 只有 `workspace/common/contentHash.ts` 一个定义。
   - 无任何对已删除 `change/contentHash` 的引用，也无从 `read/content` 导入 `contentSha256` 的残留。
   - `git diff --check` 无输出。
   - 所有新增/修改文件均 `<=300` 行；`read/linesRead.test.ts` 为 300 行，其余均低于 300 行。

## 范围外 concern

字面执行任务卡的：

```text
rg -n "createHash\('sha256'\)" packages/host-node/src/workspace
```

除新 owner 外仍会命中：

- `workspace/change/fileSnapshot.ts`：回滚 journal 的无前缀文件快照 hash。
- `workspace/change/pathOpsFingerprint.ts`：copy/move 的路径内容+结构指纹。
- `workspace/read/runIndexRead.ts`：截断为 16 hex 的 run-index cursor snapshot。
- `workspace/patch/stageRules.test.ts`：测试 oracle，非产品 owner。

前三者的输入、格式与信任边界都不是 `sha256:<64 lowercase hex>` 乐观并发协议，不应为让宽泛 `rg` 命令只返回一行而强行并入 content hash owner。这四个文件也不在 020 files 边界内，本任务未修改。建议编排者将该验收改为检查 `contentSha256` 定义数、旧 owner 路径与 read/write/patch 导入图。

## 边界与工作区

- 未修改任务 files 之外的产品源码。
- 未 stage，未 commit，未还原任何并行任务改动。
