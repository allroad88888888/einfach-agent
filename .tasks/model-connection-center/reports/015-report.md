# 015 执行报告

## 改动摘要

- 在 `packages/agent-ai/src/builtinProviders.test.ts` 增加官方 DeepSeek、GLM、Kimi 的表驱动 characterization：断言 vendor identity 决定官方 origin、各自 request projection，并且只有 DeepSeek 上行 `user_id`；GLM 保留其 `reasoning_effort: max`，Kimi 保留 region 路由语义。
- R1 增加 `DeepSeekReasoningEffort` 精确类型等价 characterization，将 DeepSeek 允许集合固定为 `'high' | 'max'`；GLM 独有的 `'low' | 'medium'` 与其他非法值因此不属于 DeepSeek 取值域。
- 新增 `apps/web/src/modelTransport/providerRoute.test.ts`，使用 label/model 看似官方的第三方 profile，断言其请求始终生成带 `connectionId` 的 `openai-compat` target；同时覆盖官方 origin 身份、未登记 ID、URL 不全等、ID/URL 错配及 legacy/profile identity 混用的 fail-closed 行为。
- 未修改生产 adapter、endpoint、profile registry、transport target 或 provider settings。
- `apps/web/src/modelTransport/openAiCompatEndpoint.test.ts` 在本任务开始前已有工作区在途改动；本任务未编辑该文件，但将其纳入指定验收。

## 逐条验收命令与结果

1. `pnpm exec vitest run packages/agent-ai/src/builtinProviders.test.ts apps/web/src/modelTransport/providerRoute.test.ts apps/web/src/modelTransport/openAiCompatEndpoint.test.ts`
   - 通过：3 个测试文件，33 项测试全部通过。
2. `pnpm --filter @einfach-agent/ai build`
   - 通过：`tsup`、声明文件构建及声明说明符修复均成功。
3. `git diff --check`
   - 通过，无空白错误。
4. `wc -l packages/agent-ai/src/builtinProviders.test.ts`
   - 通过：294 行，未超过普通文件 300 行上限。

## 未验证项

- 无。全仓 `pnpm exec tsc -b` 已由更新后的任务卡明确移至 060/070 消费端迁移后的总门，不属于 015 R1 的聚焦验收。

## 范围外发现

- 并行的多模型 profile schema 修改已使多处 UI、settings command/runtime 和测试仍引用已删除的单数 `model` 字段，导致全仓 TypeScript 构建失败。本任务遵守 files 边界，未顺手修复。
- 任务开始时 `packages/agent-ai/src/builtinProviders.test.ts` 与 `apps/web/src/modelTransport/openAiCompatEndpoint.test.ts` 已有在途改动；本任务保留这些改动，未覆盖或回退。

## 疑虑

- 无。

## 建议后续动作

- 由独立 reviewer 复核 R1 的精确取值域断言；060/070 按更新后的任务树执行全仓 `tsc -b` 总门。
