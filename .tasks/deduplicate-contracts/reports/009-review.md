# 009 独立审查

## 回执

**APPROVED**

范围内实现满足任务契约：operation union 与 change context 形状由 core 单点持有，四处 handler 共用同一 decoder，write / patch 只共用 content-hash 原语而未合并业务流程。未发现 Critical、Important 或 Minor 问题。

## Findings

### Critical

无。

### Important

无。

### Minor

无。

## 逐项验收

### 1. host type alias 的公开边界与发布依赖

- `WorkspaceChangeContextArgs` 和 `WorkspacePatchOperationArgs` 均从 `@einfach-agent/core/tools` 做 type-only import 并保留 host 原公开名字（`packages/host-node/src/commandPayloads.ts:10-32`）；workspace change 内部类型也直接从同一边界转出（`packages/host-node/src/workspace/change/types.ts:25-27`）。
- `@einfach-agent/core/tools` 是 core manifest 明确声明的 `./tools` export（`packages/agent-core/package.json:20-36`），且该 barrel 明确转出两个类型（`packages/agent-core/src/tools/index.ts:99-107`）；不是未承诺的深路径。
- host-node 已把 `@einfach-agent/core` 列在正式 `dependencies`（`packages/host-node/package.json:33-36`），不会出现声明发布后仅在 monorepo 内可解析、安装包缺依赖的问题。type-only import/export 也不新增运行时加载边。

### 2. `WorkspaceChangeContext` 的 required / optional / readonly 语义

- core owner 的四个字段仍是必填、可变的 `string`（`packages/agent-core/src/runtime/workspaceChange.ts:3-8`），与 base 中 host 的 interface 完全同构；别名没有引入 `readonly` 或把字段改为 optional。
- 可选的是顶层 `change_context` / 解码结果本身，不是四个 inner fields。共享 decoder 仅对 `undefined` 和 `null` 返回 `undefined`，一旦存在就逐个要求 camelCase 字段为字符串（`packages/host-node/src/workspace/change/decodeWorkspaceChangeContext.ts:7-34`），与四份 base decoder 一致。

### 3. 四处 decoder 的命令语义

- write、patch、delete 分别传入固定命令名（`writeWorkspaceFileHandler.ts:45`、`applyWorkspacePatchHandler.ts:52`、`deleteWorkspacePathHandler.ts:35`）；pathOps 仍由 `copy` / `move` 生成实际命令名后传入（`pathOpsHandler.ts:32-40`）。
- 非对象/数组仍报“`${command} 的 change_context 必须是对象`”，缺字段或字段非字符串仍报“`${command} 的 change_context.${field} 必须是字符串`”；命令名、camelCase 字段、异常类型与拒绝时机都没有改变。

### 4. content hash 的基线等价性

- 共享格式判定精确限定为 `sha256:` + 64 位小写 hex，拒绝裸 digest、大写、非 hex、错长度与尾随内容（`packages/host-node/src/workspace/change/contentHash.ts:3-10`）。
- 计算仍对字符串的 UTF-8 字节做 SHA-256，并用 `digest('hex')` 产出小写带前缀值（`contentHash.ts:13-15`）。
- patch 格式错仍抛普通 `Error`，write 格式错仍通过 `rejectWrite` 抛 `WriteRejection`（`patch/guard.ts:35-42`；`write/guard.ts:58-64`）。两条 hash mismatch 文案各自保持 base 原文，校验顺序也仍是“两个 guard 同时给出 → old content → hash 格式 → hash mismatch”。
- write 仍经 `pipelinePlan.ts` 调用 `verifyExpectedContent`，patch 仍经 `stageRules.ts` 调用 `verifyStagedGuard`；本 diff 没有把两条写入/暂存/落盘流程合并。

### 5. 测试、diff 与 TypeScript 阻断判定

- 执行报告记录指定 8 个测试文件、79 个测试全部通过；本审查按要求未重跑这些测试。新增 decoder/hash 测试与原 guard/handler 测试的静态覆盖与报告一致。
- 范围 diff 的 `git diff --check` 无输出；任务范围内的四个新文件当前为 untracked，交付时需与其他改动一并纳入。
- 复核原样 `pnpm exec tsc -b packages/agent-core/tsconfig.json packages/host-node/tsconfig.json --pretty false` 时，非零诊断全部是 `tools/{agents,fs,interaction,planning,shell,skills,vision}/**/*.md?raw` 的 TS2307，没有一条指向 009 改动文件。根 `tsconfig.app.json` 的 source path mapping 会把这些 tools 源码经 core 测试 import 拉入 program，但各 tools 包自己 `include` 的 `raw-modules.d.ts` 不会随源文件跨 project 自动纳入。该导入、声明与配置问题与 009 的类型别名/decoder/hash diff 无因果关系，判定为既有的范围外构建图问题，不阻断本叶验收。报告没有把原样命令记为通过，其 `DONE_WITH_CONCERNS` 与实际证据一致。

## 结论

公开类型依赖、decoder 业务错误契约、content hash 的算法/格式/异常与两条 mutation 流程均保持基线语义；批准交付。
