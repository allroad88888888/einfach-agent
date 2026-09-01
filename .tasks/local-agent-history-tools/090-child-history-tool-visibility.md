---
id: "090"
title: 向所有 child profile 开放工具
kind: leaf
parent: "4000"
depends_on: ["080"]
discovered_from: null
model: gpt-5.6-terra
status: cancelled
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/agent-core/src/subagents/historyToolProfile.ts
  - packages/agent-core/src/subagents/toolProfile.ts
  - packages/agent-core/src/subagents/toolProfile.test.ts
  - packages/agent-core/src/runtime/toolContext/delegationCapabilities.ts
  - packages/agent-core/src/runtime/toolContext.historyProfile.test.ts
  - packages/agent-core/src/subagents/runtime.agentHistory.test.ts
---

# 向所有 child profile 开放工具

已合并进 070，避免把同一条用户可用链路拆得过细；本叶不再单独执行。

## 目标

让 delegate_only、workspace_read、workspace_verify 三档 child 都能看见并实际执行四个历史工具。

## 产出

- `historyToolProfile.ts` 唯一声明四个 safe introspection 名称与谓词。
- `subagentAllowedTools()` 的三档都包含四项，原有全序阶梯和 workspace/verification 差集不变。
- `runChildTool` gate 显式允许 history predicate，不要求 confirmedTools/always-allow，不把 delegate_only 升级为 workspace read。
- 未知 profile 继续 fail-closed；dangerous capability 交集与 pause 禁止不变。

不修改 294 行 child loop 或 292 行 child tool-call handler；manifest 与执行 gate 在现有专责 owner 完成。

## 验收

1. 三档 manifest 均含四项，且原有工具集合精确不回归。
2. 三档 child 都通过真实 `runChildTool` 调用 root/sibling/descendant target；不是只测名字数组。
3. 无 agentHistory provider 时返回普通 tool unavailable；有 provider 时 warnings/results 原样进入 child tool result。
4. 测试与生产无 history permission/approval/historyScope/ancestor 分支或 always-allow fixture。
5. `pnpm exec vitest run packages/agent-core/src/subagents/toolProfile.test.ts packages/agent-core/src/runtime/toolContext.historyProfile.test.ts packages/agent-core/src/subagents/runtime.agentHistory.test.ts packages/agent-core/src/subagents/runtime.toolProfileAndRegistry.test.ts` 通过。
6. `pnpm exec tsc -b`、`pnpm check:state` 与 owners `<=300` 通过。

## 禁止项

- 不修改四工具实现/registry/app assembly。
- 不把 history 工具归类为 dangerous、workspace read、verification 或 replayUnsafe。
