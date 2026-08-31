---
id: "020"
title: 收窄厂商 Thinking 请求
kind: leaf
parent: "100"
depends_on:
  - "010"
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/agent-ai/src/deepseek.ts
  - packages/agent-ai/src/glm.ts
  - packages/agent-ai/src/kimi.ts
  - packages/agent-ai/src/builtinProviders.ts
  - packages/agent-ai/src/builtinProviders.test.ts
  - packages/agent-ai/src/deepseek.test.ts
  - packages/agent-ai/src/glm.test.ts
  - packages/agent-ai/src/kimiChat.test.ts
  - packages/agent-ai/src/thinkingRequestProjection.test.ts
---

# 收窄厂商 Thinking 请求

## 目标

只向上游发送当前模型支持的 Thinking 字段。

## 上下文

core 已把 `settings.thinking` 投影成 `{ type: enabled|disabled }`，厂商 effort 从
`vendorSettings.reasoning_effort` 进入 adapter。当前 DeepSeek/GLM 的 TypeScript 类型不能保护从 JSON
恢复的运行时字符串；GLM 类型还漏了官方值。Kimi 只应保留 `thinking.type`。

基于 010 capability 在 adapter 边界收窄：

- DeepSeek V4 仅在 thinking enabled 时允许 high/max；disabled 或脏值不发 effort。
- GLM-5.2 仅在 enabled 时允许 index 的正向 effort；其它 GLM 模型即使设置袋残留 effort 也删除。
- GLM `minimal|none` 若从旧配置进入，统一投影为 thinking disabled 且不并发发送矛盾 effort，或按 010
  的单一规范化接口处理；测试必须钉住唯一行为。
- Kimi K2.6 继续发送 `thinking.type`，不得新增未经官方表支持的 `reasoning_effort`；消息、图片与 usage
  编码不回归。
- unsupported/unknown 模型不从 fallback descriptor 偷到 DeepSeek 私有投影。

不改 core 的 opaque vendor bag，不把厂商分支上移到 core/web。

## 接口

### 消费

- 010 的 capability 查询与合法 effort 集合。

### 产出

- 对 C-01～C-05、C-11 的 fetch 注入 wire-body 证据，060 消费。

## 验收标准

1. `pnpm exec vitest run packages/agent-ai/src/deepseek.test.ts packages/agent-ai/src/glm.test.ts packages/agent-ai/src/kimiChat.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts` → enabled/disabled/Auto/合法/非法/跨模型 effort 全部通过。
2. 请求断言使用最终 fetch body，不只测中间 helper；不联网、不打印 Key。
3. `pnpm --filter @einfach-agent/ai build && git diff --check` → 通过。
4. `wc -l` 检查本任务新增/大改文件；若 `deepseek.test.ts` 因存量 300 行附近被顶破，按场景把新增协议用例留在独立测试文件，不能机械分 part。

## 执行记录（仅编排者回写）

- 2026-08-21：首轮独立审查 REJECT：Thinking object extra fields 未 canonicalize；全 agent-ai 套件有两条
  既有装配断言未随新契约收敛。将直接相关的 `builtinProviders.test.ts` 补入 files，交原执行者做限定 R1；
  该文件当前 294 行，R1 后不得超过 300 行。
- 2026-08-21：R1 独立复审 APPROVE；两个 Medium 闭合，全 agent-ai 套件通过，装配测试 298 行。
