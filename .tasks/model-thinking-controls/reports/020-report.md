# 020 report

## 已完成

- 在内置 provider 装配边界新增精确的 capability 投影：实际 vendor 与 model 必须命中
  010 的受审表，才会发送合法的 `thinking` 或 `reasoning_effort`。执行 fallback、旧 GLM、
  未知模型与 OpenAI-compatible profile 不会继承 DeepSeek 的 Thinking 字段。
- DeepSeek V4 仅在 Thinking enabled 时上行 `high | max`；`Auto`、disabled 与脏值均省略
  effort。GLM-5.2 接受全部 `low | medium | high | xhigh | max`；`minimal | none` 统一为
  `thinking: { type: 'disabled' }` 且不带 effort。其他 GLM 与 Kimi 仅保留 capability
  支持的开关。
- 修正 `GlmReasoningEffort` 以包含官方的 `xhigh`。
- 新增专责的 fetch-wire 协议测试，覆盖 DeepSeek、GLM-5.2、GLM toggle-only、Kimi、
  unsupported、未知 fallback 与 OpenAI-compatible 的最终请求 body；没有联网或输出 Key。

## 测试与验收

- `pnpm exec vitest run packages/agent-ai/src/deepseek.test.ts packages/agent-ai/src/glm.test.ts packages/agent-ai/src/kimiChat.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts` — 3 files、29 tests passed。`glm.test.ts` 是叶中列出的目标路径但当前仓库不存在；GLM wire 覆盖在本叶新增的专责测试中。
- `pnpm --filter @einfach-agent/ai build` — passed。
- `git diff --check` 与新增测试文件的 `git diff --no-index --check` — passed。
- 行数：`builtinProviders.ts` 260、`glm.ts` 59、`thinkingRequestProjection.test.ts` 122，均不超过 300。
  路过的存量 `deepseek.test.ts` 为 359 行，未扩写或重构；新增协议场景均放入独立测试文件。

## 边界

- 仅修改本叶声明的 `builtinProviders.ts`、`glm.ts` 与新增
  `thinkingRequestProjection.test.ts`，并写入本报告。
- 保留共享 worktree 既有的 OpenAI-compatible connection profile/transport 与 010 descriptor
  抽取改动；未修改 task/index、未暂存、提交或覆盖无关文件。

## R1 审查修复

- Thinking 投影现在仅从合法 `type` 重建新的 `{ type: 'enabled' | 'disabled' }` 对象；多余字段
  不会到达 wire body，非法对象会 fail closed 并同时省略 effort。
- 收敛 `builtinProviders.test.ts` 的在途 identity 用例：DeepSeek 改为受审的
  `deepseek-v4-pro`，DeepSeek/GLM 仅在显式 enabled 时期待 effort。未启用 Thinking 时不发
  effort 的反向最终-fetch 断言放在专责 `thinkingRequestProjection.test.ts`，使存量测试保持在
  300 行以内。
- 新增最终 fetch body 用例覆盖 enabled/disabled 对象的多余字段，以及非法 Thinking 对象。

### R1 验收

- 叶相关 Vitest：4 files、51 tests passed。
- `pnpm exec vitest run packages/agent-ai/src`：28 files、235 tests passed。
- `pnpm --filter @einfach-agent/ai build`、`git diff --check` 与新增测试的
  `git diff --no-index --check`：passed。
- 行数：`builtinProviders.ts` 260、`builtinProviders.test.ts` 298、`glm.ts` 59、
  `thinkingRequestProjection.test.ts` 175；均不超过 300。
