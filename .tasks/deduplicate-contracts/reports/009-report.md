# 009 执行报告

回执：`DONE_WITH_CONCERNS`

## 摘要

- `WorkspacePatchOperationArgs` 与 `WorkspaceChangeContextArgs` 改为 core 公开类型的别名，host-node 不再拥有重复的 operation union 或 change context 结构。
- change 域新增 `decodeWorkspaceChangeContext(command, value)`，write / patch / delete / pathOps 四个 command decoder 统一调用它。
- change 域新增 content hash 格式判定与 UTF-8 SHA-256 计算原语，patch / write guard 复用原语，同时保留各自的异常类型、hash mismatch 文案与写入流程。
- 新增 decoder 和 content hash 两份就近单元测试；所有新增/修改文件均不超过 300 行。

## 逐项验收

1. ✅ 四个 handler、patch guard、write guard 与新增共享模块测试通过。
   - 命令：`pnpm exec vitest run packages/host-node/src/workspace/change/decodeWorkspaceChangeContext.test.ts packages/host-node/src/workspace/change/contentHash.test.ts packages/host-node/src/workspace/pathOps/pathOpsHandler.test.ts packages/host-node/src/workspace/patch/applyWorkspacePatchHandler.test.ts packages/host-node/src/workspace/delete/deleteWorkspacePathHandler.test.ts packages/host-node/src/workspace/write/writeWorkspaceFileHandler.test.ts packages/host-node/src/workspace/patch/guard.test.ts packages/host-node/src/workspace/write/guard.test.ts`
   - 结果：8 files / 79 tests 全部通过。
2. ✅ `commandPayloads.ts` 不再声明 patch operation union；它直接别名 `@einfach-agent/core/tools` 的 `WorkspacePatchOperation`。
3. ✅ 共享 decoder 保留原契约：inner fields 只读 camelCase，缺字段和非对象按 command-specific 文案拒绝，`undefined` / `null` 视为缺席；现有 handler 测试和新增参数化测试均通过。
4. ⚠️ 原样 `pnpm exec tsc -b packages/agent-core/tsconfig.json packages/host-node/tsconfig.json` 未通过，但报错全部是范围外 `tools/*` 内既有 `*.md?raw` 模块声明不可见的 TS2307。为隔离本次类型接线，分别执行了：
   - `pnpm exec tsc -p packages/agent-core/tsconfig.json --types node,vite/client`
   - `pnpm exec tsc -p packages/host-node/tsconfig.json --types node,vite/client`
   - 结果：两条均通过。

其他检查：

- ✅ `pnpm run check:boundaries`：通过（仅输出仓库既有观察项）。
- ✅ `git diff --check`：通过。
- ✅ 静态扫描确认四个 handler 中已无本地 `optionalChangeContext` / `requiredContextField`，patch / write guard 中已无本地 hash 格式正则与 SHA-256 实现。

## 未验证

- 由于上述范围外 `*.md?raw` TS2307，未能以原样验收命令得到零退出码。
- 未运行全仓测试；009 声明的定向测试与边界检查已运行。

## 范围外发现

- 多个 `tools/*` 包虽各自存在 `raw-modules.d.ts`，但从 agent-core 的 TypeScript project 经路解析时，这些 ambient 声明没有进入 program，导致原样双包 `tsc -b` 在 `tools/*/*.md?raw` 上报 TS2307。本任务没有修改这些范围外文件。

## 疑虑

- 产品实现、定向测试和隔离后的类型检查均通过；唯一疑虑是原样验收命令仍受范围外 ambient declaration 问题阻断。

## 建议

- 在独立任务中让各 tools package 的 `*.md?raw` 声明在跨包 TypeScript project 中稳定可见，然后重跑 009 指定的原样 `tsc -b` 命令。
