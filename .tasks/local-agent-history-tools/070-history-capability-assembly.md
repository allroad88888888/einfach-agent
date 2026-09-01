---
id: "070"
title: 端到端装配并注册四个历史工具
kind: leaf
parent: "3000"
depends_on: ["010", "060"]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/agent-core/src/runtime/toolContext/historyCapabilities.ts
  - packages/agent-core/src/runtime/toolContext/historyCapabilities.test.ts
  - packages/agent-core/src/history/historyQuery.ts
  - packages/agent-core/src/runtime/toolContext.ts
  - packages/agent-core/src/runtime/persistenceBridge.ts
  - packages/agent-core/src/runtime/persistenceBridge.test.ts
  - apps/cli/src/historyCapability.ts
  - apps/cli/src/historyCapability.test.ts
  - apps/cli/src/persistence.ts
  - apps/cli/src/persistence.test.ts
  - apps/cli/src/runtime.ts
  - apps/cli/src/runtime.test.ts
  - apps/web/src/persistence/serverAgentHistoryCapability.ts
  - apps/web/src/persistence/serverAgentHistoryCapability.test.ts
  - apps/web/src/persistence/persistenceDrivers.ts
  - apps/web/src/persistence/persistenceDrivers.test.ts
  - apps/web/src/main.tsx
  - apps/web/src/main.serverHost.test.tsx
  - apps/server/src/invokeRouteError.ts
  - apps/server/src/invokeRouteError.test.ts
  - tools/agents/src/list-agent-histories/list-agent-histories.ts
  - tools/agents/src/list-agent-histories/list-agent-histories.md
  - tools/agents/src/list-agent-histories/list-agent-histories.test.ts
  - tools/agents/src/list-agent-history-items/list-agent-history-items.ts
  - tools/agents/src/list-agent-history-items/list-agent-history-items.md
  - tools/agents/src/list-agent-history-items/list-agent-history-items.test.ts
  - tools/agents/src/read-agent-history-item/read-agent-history-item.ts
  - tools/agents/src/read-agent-history-item/read-agent-history-item.md
  - tools/agents/src/read-agent-history-item/read-agent-history-item.test.ts
  - tools/agents/src/search-agent-histories/search-agent-histories.ts
  - tools/agents/src/search-agent-histories/search-agent-histories.md
  - tools/agents/src/search-agent-histories/search-agent-histories.test.ts
  - tools/agents/src/index.ts
  - tools/standard/src/index.ts
  - tools/standard/src/index.test.ts
  - packages/agent-core/src/subagents/historyToolProfile.ts
  - packages/agent-core/src/subagents/prompt.ts
  - packages/agent-core/src/subagents/toolProfile.ts
  - packages/agent-core/src/subagents/toolProfile.test.ts
  - packages/agent-core/src/runtime/toolContext/delegationCapabilities.ts
  - packages/agent-core/src/runtime/toolContext.historyProfile.test.ts
  - packages/agent-core/src/subagents/runtime.agentHistory.test.ts
  - docs/agent-history-tools.md
  - docs/agent-rollout-storage.md
---

# 端到端装配并注册四个历史工具

## 目标

一次完成用户可用链路：Web/CLI capability → ToolContext → 四个模型工具 → root/child profiles，并补一页最小运维说明。

本任务合并原 080、090、100，禁止再按平台、工具名或 profile 拆成更小任务；可以按单一职责拆文件。

## core 绑定

- `PersistenceDependencies` 增加可选 `agentHistory?: AgentHistoryCapabilityProvider`，dependencies/reset 与多 Core
  隔离语义完整；它是只读宿主 capability，不参与 recovery flush。
- `historyCapabilities.ts` 只负责从 provider 与当前会话 `workspaceRoot` 生成 `Pick<ToolContext,'agentHistory'>`。
- `buildToolContext` 在解析 workspace root 后 spread 该 capability；递归 `callTool` 与 child 共用同一 Core/provider。
- provider 缺席时字段缺席，工具层映射为 `AGENT_HISTORY_UNAVAILABLE`；不得建立空成功 facade。

## CLI

- `historyCapability.ts` 用 060 公共工厂、现有 persistence executor 与同一 `agentRollout` 创建一个 provider。
- `assembleCliPersistence` 配置 provider 到 core，并在 assembly 返回它；不得打开第二 database/driver。
- CLI host bridge 注入同一 borrowed provider 与 rollout driver，host routes/core 的 identity 测试必须相等。
- 既有唯一 composite persistence disposer 仍只执行 recovery → rollout flush；history provider 无额外 disposer。

## Web

- `serverAgentHistoryCapability.ts` 通过四条 HTTP host commands 实现 provider；隐藏 legacy root 由 ToolContext
  provider binding 注入 envelope，模型 schema 看不到路径。
- server persistence bundle 含 provider；static IndexedDB bundle不创建 adapter。
- `main.tsx` 把 provider 与 sessions/recovery/rollout 同批 configure；server startup 仍先 rollout reconcile，source
  corruption 在 hydrate/render 前失败。history capability 不另起 fallback。

## 四个工具与 child 可见性

- 注册 `list_agent_histories`、`list_agent_history_items`、`read_agent_history_item`、`search_agent_histories`；
  工具只校验 schema、调用 `ctx.agentHistory` 并保留结构化 warnings/cursor。
- capability 缺席返回稳定 unavailable；工具层不得 import SQLite、fs、store 或 host adapter。
- agents/standard registry 各注册一次；四项保持 replay-safe，不加入 dangerous/workspace/verification 分类。
- delegate_only、workspace_read、workspace_verify 三档 child 都能看见并实际调用四项；不增加 permission、approval、
  ancestor 或 workspace scope 分支。
- 文档只说明本机 canonical 全局范围、JSONL/SQLite/FTS/legacy 职责、static Web unavailable 与分页/错误边界。

## 验收

1. defaultCore 与两个独立 Core 的 provider/ToolContext 不串；递归 callTool 与 child context 继承同一 capability。
2. CLI provider、host routes、rollout driver/executor 单实例；shutdown disposer 数量与顺序不回归。
3. Web server command envelope 透传四方法与 warnings/cursor；static bundle不调用 adapter且字段缺席。
4. source corruption 仍在 Web/CLI startup fence 失败；projection warning不误报 unavailable。
5. `pnpm exec vitest run packages/agent-core/src/runtime/toolContext/historyCapabilities.test.ts packages/agent-core/src/runtime/persistenceBridge.test.ts apps/cli/src/historyCapability.test.ts apps/cli/src/persistence.test.ts apps/cli/src/runtime.test.ts apps/web/src/persistence/serverAgentHistoryCapability.test.ts apps/web/src/persistence/persistenceDrivers.test.ts apps/web/src/main.serverHost.test.tsx` 通过。
6. 四项各覆盖 schema/透传/unavailable/异常；standard registry 总数更新且无重复；三档 child profile 的 manifest
   和真实 execution gate 都通过。
7. `pnpm exec tsc -b`、相关 workspace build、`pnpm check:boundaries`、`pnpm check:state`、owners `<=300` 通过。

## 禁止项

- 不修改查询/FTS 实现，不让浏览器直接发送任意 SQL。
- 不把 legacyWorkspaceRoot 加入公开 tool schema或当 ACL 使用。

## R2 修复门

依据独立端到端复审，仅关闭 Web HTTP typed error 透传：

- server invoke error mapper 只对闭合的 history error code 集合保留 `AgentHistoryError.code`，其它域既有分类不变。
- Web history adapter 使用保留 `ServerInvokeError.code` 的结构化调用面，并只把合法 history code 重建为
  `AgentHistoryError`；网络/未知失败仍走普通 query failure。
- 测试覆盖 server mapper → Web adapter → 实际 tool execute，对 invalid cursor 与 source corrupt 保留 code
  且保持不可重试；不得改写通用 `httpInvoke` 的 Tauri-compatible 裸字符串合同。
