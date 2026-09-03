---
id: 009
title: workspace mutation 类型与 change context 只有一个 owner
kind: leaf
parent: 000
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-03
done: 2026-09-03
base: 558de25
files:
  - packages/agent-core/src/runtime/workspacePatch.ts
  - packages/host-node/src/commandPayloads.ts
  - packages/host-node/src/workspace/change/
  - packages/host-node/src/workspace/pathOps/pathOpsHandler.ts
  - packages/host-node/src/workspace/pathOps/pathOpsHandler.test.ts
  - packages/host-node/src/workspace/patch/applyWorkspacePatchHandler.ts
  - packages/host-node/src/workspace/patch/applyWorkspacePatchHandler.test.ts
  - packages/host-node/src/workspace/delete/deleteWorkspacePathHandler.ts
  - packages/host-node/src/workspace/delete/deleteWorkspacePathHandler.test.ts
  - packages/host-node/src/workspace/write/writeWorkspaceFileHandler.ts
  - packages/host-node/src/workspace/write/writeWorkspaceFileHandler.test.ts
  - packages/host-node/src/workspace/patch/guard.ts
  - packages/host-node/src/workspace/patch/guard.test.ts
  - packages/host-node/src/workspace/write/guard.ts
  - packages/host-node/src/workspace/write/guard.test.ts
---

# workspace mutation 类型与 change context 只有一个 owner

## 目标
host-node 直接消费 core 的 workspace patch operation 类型，并由 host workspace change 域统一解码 `change_context` 与校验 content hash 格式。

## 交付边界
公开类型接线、四个 command decoder、hash 原语和测试一起交付。各命令对缺失上下文、hash mismatch 的业务错误措辞与可逆性策略保留。

## 上下文
- `packages/agent-core/src/runtime/workspacePatch.ts` 与 `packages/host-node/src/commandPayloads.ts` 定义相同 operation union。
- change context 四字段 decoder 位于 write/patch/delete/pathOps handlers。
- patch/write guards 复制 SHA-256 格式与计算；只共享 primitive，不合并两条写入流程。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- core `WorkspacePatchOperation` 与 `WorkspaceChangeContext`。
### 产出
- host 域 `decodeWorkspaceChangeContext(command, value)` 和 content hash 纯原语。

## 验收标准
1. 四个 handler、patch guard、write guard 的现有测试和新增共享模块测试全部通过。
2. `commandPayloads.ts` 不再拥有重复的 patch operation union。
3. 每个 handler 对 camelCase inner fields、缺字段、非对象和 undefined 行为保持原契约。
4. `pnpm exec tsc -b packages/agent-core/tsconfig.json packages/host-node/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：派发执行 agent，base `558de25`。
- 2026-09-03：执行 DONE_WITH_CONCERNS，仅范围外 md?raw 构建图失败；独立 reviewer APPROVED。
- 2026-09-03：编排者复跑 79 tests 通过，准予提交。
