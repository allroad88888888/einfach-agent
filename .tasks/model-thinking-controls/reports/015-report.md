# 015 report

## 已完成

- 为四个共享的受支持 capability 常量声明 `defaultEnabled: true`：DeepSeek V4、GLM-5.2、GLM
  toggle-only（GLM-5.1/5/5-Turbo 与 GLM-4.5+）及 Kimi K2.6。因此全部 14 个受审的内置支持模型
  均继承官方默认开启状态，且没有为每个模型复制 capability 对象。
- `unsupported` 的旧 GLM capability 保持没有默认值；`unknown` capability 也没有默认值，未改变其
  不支持 Thinking 的语义。
- 使用 `it.each` 矩阵逐项断言所有 supported 内置模型为 `defaultEnabled: true`，并覆盖三个
  unsupported GLM 模型及一个 unknown OpenAI-compatible 模型均未声明默认值。

## 测试与验收

- `pnpm exec vitest run packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/modelThinkingCapability.test.ts` — 2 files、36 tests passed。
- `pnpm --filter @einfach-agent/ai build` — passed。
- `git diff --check` 及两个未跟踪叶文件的 `git diff --no-index --check` — passed。
- 行数：`builtinModelDescriptors.ts` 146、`builtinThinkingCapabilities.test.ts` 128；均低于 300。

## 边界

- 仅修改本叶声明的 capability data/test，并写入本报告；未修改 task/index、未暂存、提交、重置或覆盖
  共享 worktree 的其他在途改动。
