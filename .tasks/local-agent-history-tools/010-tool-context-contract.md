---
id: "010"
title: 拆出 ToolContext 合同
kind: leaf
parent: "1000"
depends_on: ["020"]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/agent-core/src/tools/types.ts
  - packages/agent-core/src/tools/context.ts
  - packages/agent-core/src/tools/index.ts
---

# 拆出 ToolContext 合同

## 目标

把 299 行 `tools/types.ts` 中的工具执行上下文抽成专责文件并加入历史查询能力槽。

## 产出

- `context.ts` 唯一定义并导出 `ToolContext`；只移动它专属的内联 capability 形状。
- `ToolContext` 增加可选 `agentHistory?: AgentHistoryCapability`，只引用 020 的 transport-neutral 合同。
- `types.ts` 兼容 re-export `ToolContext`，已有深层 import 不需要在本叶批量迁移。
- `tools/index.ts` 从 `context.ts` 导出同一类型；不能产生第二份结构合同。
- type-only 引用不得形成 declaration emit 循环；`Tool`、`ToolResult`、workspace/shell 通用 DTO 仍留在 `types.ts`。

本叶只增加类型槽，不装配 provider、不改变任何工具行为；070 负责运行时绑定。

## 验收

1. `rg -n "interface ToolContext" packages/agent-core/src/tools` 只有 `context.ts` 一处定义。
2. 旧 `../tools/types` 与公共 `@einfach-agent/core/tools` import 均能解析同一 `ToolContext`。
3. `pnpm exec vitest run packages/agent-core/src/runtime/toolContext.workspaceRoot.test.ts packages/agent-core/src/runtime/toolContext.verifyProfile.test.ts` 通过。
4. 未配置 capability 的既有 ToolContext fixture 继续通过；配置时类型可调用四方法。
5. `pnpm exec tsc -b` 通过；三个 owner 均 `<=300`。

## 禁止项

- 不改 `buildToolContext`、不装配 provider、不改 tool 行为。
- 不创建 `types2.ts`、`part1.ts` 或大杂烩文件。
