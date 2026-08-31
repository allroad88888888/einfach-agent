# 020 R1 独立复审

## 结论

**APPROVE**

上轮两个 Medium 均已闭合；未发现新的阻塞或非阻塞 finding。

## Findings

- 无。

## 上轮 Findings 闭合证据

- `packages/agent-ai/src/builtinProviders.ts:88-93,110-123` 现在由 `canonicalThinking` 读取唯一合法
  `type` 后重建新的 `{ type: 'enabled' | 'disabled' }`，不再透传原对象。非法、缺失或非对象值返回
  `undefined`；effort 分支随后要求 canonical Thinking 为 enabled，因此非法对象同时省略 `thinking` 与
  `reasoning_effort`，保持 fail closed。
- `packages/agent-ai/src/thinkingRequestProjection.test.ts:100-133` 使用最终 fetch body 证明 enabled 与
  disabled 对象的 `unexpected` 字段均被删除，非法 `type: 'automatic'` 时 Thinking 与 effort 均不发送。
- `packages/agent-ai/src/builtinProviders.test.ts:92-127` 的装配断言已改用受审模型
  `deepseek-v4-pro` 与 `glm-5.2`，两者都显式传入 `thinking: { type: 'enabled' }` 后才期待 effort。
- `packages/agent-ai/src/thinkingRequestProjection.test.ts:82-98` 以最终 fetch body 反向证明 DeepSeek 与
  GLM-5.2 即使 settings 留有合法 effort，只要没有 enabled Thinking，就既不发送 Thinking 也不发送
  effort。

## 独立验证

- `pnpm exec vitest run packages/agent-ai/src`：28 files / 235 tests passed；上轮失败的
  `builtinProviders.test.ts` 已通过。
- `pnpm --filter @einfach-agent/ai build`：passed。
- `git diff --check`：passed；未跟踪的 `thinkingRequestProjection.test.ts` 另以
  `git diff --no-index --check` 检查通过。
- `wc -l packages/agent-ai/src/builtinProviders.test.ts`：298，符合普通文件不超过 300 行的硬规则。
  同轮相关文件 `builtinProviders.ts` 260 行、`thinkingRequestProjection.test.ts` 175 行，也均未超限。

## 范围确认

本次仅复审上轮两个 Medium、更新后的实现/测试、`reports/020-report.md` 与 agent-ai 全套门。除本报告外
未修改产品、测试、task 或 index 文件，未暂存、提交或派发子 agent。
