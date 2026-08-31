---
id: "070"
title: 审核模型中心边界
kind: leaf
parent: "300"
depends_on:
  - "015"
  - "020"
  - "060"
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/ModelCredentialPanel.connections.test.tsx
  - apps/web/src/agentNew/ui/ModelConnectionProfileSettings.test.tsx
  - apps/web/src/settings/modelConnectionProfileCommands.test.ts
  - apps/web/src/settings/modelConnectionProfileManifest.test.ts
  - packages/host-node/src/model/connectionProfileProbe.test.ts
  - packages/host-node/src/model/connectionProfileForward.test.ts
  - packages/host-node/src/model/connectionProfileForwardBinding.test.ts
---

# 审核模型中心边界

## 目标

验证模型中心不突破密钥边界。

## 上下文

这是实现后的跨层验收叶，不增加产品行为。它只在任务 files 内补足聚焦回归用例，验证 010–060 已声明
的不变量；不要为让全量存量测试通过而编辑无关产品文件。执行前先读所有上游报告，记录每条声明过的
命令但不重复运行那些命令。

至少覆盖以下攻击/回归路径：

- 旧 `{ model }` profile 迁移后可选中其唯一模型，删除该模型/连接后默认运行时安全回退；
- 同一个 Base URL 的两个 profiles 选择不同模型，transport 只携带各自 ID，host 仍以各自 Key 转发；
- probe 的 Key 不会落入 profile list/read、UI 文本、transport envelope 或错误，失败 probe 不改配置；
- manifest 带秘密字段被拒绝，导入成功也仍要求用户本机填写 Key；
- 静态模式不显示第三方连接管理，官方 DeepSeek 与 legacy 兼容入口不被新 UI 改路由。

消化前序审查的 Minor：`connectionProfileProbe.test.ts` 需直接构造 3xx 响应，及 1,000 模型和 200-byte
ID 的边界；`modelConnectionProfileManifest.test.ts` 需直接断言根级未知字段与 `connection.id` 被拒绝；
新增 `ModelConnectionProfileSettings.test.tsx` 直接挂载绑定层，覆盖本地 FileReader 的合法 manifest 仅
预填 label/baseUrl/models 且 Key 为空，以及含 `apiKey`/未知字段、读取错误后编辑器保持打开并显示通用错误。
测试 FileReader 必须使用可控 fake，不读本机真实文件。

报告中对每项给命令、断言和是否已由上游覆盖；若发现产品缺陷，按严重性记录，不在本任务自行扩展
文件范围。

## 接口

### 消费

- 010–060 的完成 diff、执行报告与公开/内部契约。

### 产出

- 无产品接口；完整跨层验证证据供编排者终审。

## 验收标准

1. `pnpm exec vitest run packages/agent-ai/src/builtinProviders.test.ts apps/web/src/modelTransport/providerRoute.test.ts apps/web/src/agentNew/ui/ModelCredentialPanel.connections.test.tsx apps/web/src/agentNew/ui/ModelConnectionProfileSettings.test.tsx apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/settings/modelConnectionProfileManifest.test.ts packages/host-node/src/model/connectionProfileProbe.test.ts packages/host-node/src/model/connectionProfileForward.test.ts packages/host-node/src/model/connectionProfileForwardBinding.test.ts` → 所列跨层安全用例全部通过。
2. `pnpm exec tsc -b && pnpm check:state && pnpm check:boundaries && pnpm exec vite build --config vite.config.ts && git diff --check` → 全部通过，或将与本树无关的既有阻塞精确列入报告。
3. `rg -n "apiKey|Authorization|Bearer" apps/web/src/agentNew/ui apps/web/src/settings/modelConnectionProfile*` 的命中逐项审计 → 不存在 profile list/read/probe response、导入结果或持久化 UI atom 的 Key 值。

## 执行记录（仅编排者回写）

- 2026-08-21：060 已完成，已派发；本卡接收 020、050、060 审查留下的 Minor 回归覆盖。
- 2026-08-21：执行完成，所有验收命令通过，等待独立复审。
- 2026-08-21：独立复审通过；编排者复跑跨层测试与全部硬门通过。
