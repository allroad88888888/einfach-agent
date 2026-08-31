---
id: "020"
title: 同步模型回归夹具
kind: leaf
parent: "100"
depends_on: []
discovered_from: "model-connection-center/070, model-thinking-controls/060"
model: gpt-5.6-terra
status: done
created: 2026-08-31
done: 2026-08-31
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/subagents/src/defaultTierRouting.test.ts
  - packages/agent-core/src/runtime/modelRun.requestProjection.test.ts
  - packages/host-node/src/model/cancelCommands.test.ts
---

# 同步模型回归夹具

## 目标

使旧模型回归断言匹配已终审的精确能力契约。

## 上下文

三项失败都是旧断言没有消费最终契约：

- `glm-5-turbo` 在 `builtinModelDescriptors.ts` 是 toggle-only。低价抽取又显式 `thinking:false`，因此
  GLM 请求可以发送 disabled thinking，但绝不能保留会话的 `reasoning_effort:'high'`。
- DeepSeek Thinking 请求投影已按精确模型 fail-closed。`modelRun.requestProjection.test.ts` 使用虚构模型
  `m` 却期待 Thinking 生效；改为官方 `DEFAULT_DEEPSEEK_MODEL` 后，原断言应继续证明 temperature 不上行、
  thinking enabled 与 high effort 上行、会话设置不被突变。
- `createModelRoutes()` 已终审增加 `model_connection_profile_probe`，cancel registrar 的精确 key 清单漏了它。

只改测试。若当前生产行为不符合上述契约，停止并回报 `BLOCKED`，不得改 adapter、runtime 或 route 实现。

## 验收标准

1. `pnpm exec vitest run packages/subagents/src/defaultTierRouting.test.ts packages/agent-core/src/runtime/modelRun.requestProjection.test.ts packages/host-node/src/model/cancelCommands.test.ts` → 全部通过。
2. GLM Turbo 用例显式断言请求无 `reasoning_effort`；不能删除模型与低价路由断言。
3. DeepSeek 用例使用公共官方模型常量，仍精确断言 temperature、thinking、effort 与持久化设置。
4. 路由清单只补已存在的 probe key，仍证明流式请求转发不在 invoke 表。
5. `pnpm exec tsc -b --pretty false`、范围 `git diff --check` 与 `wc -l` 通过；三个文件均不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-31：由全量 `pnpm test` 的三个跨包契约失败发现；temperature 用例的根因是虚构模型被新能力表正确 fail-closed。
- 2026-08-31：执行与独立审查通过；编排者复跑 3 文件 21/21、diff-check 与行数门全绿。
