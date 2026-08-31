# 015 独立审查

## 结论

**APPROVE**

本叶在声明范围内闭合：全部 14 个受支持内置模型均通过 4 个共享 capability 常量显式继承
`defaultEnabled: true`；3 个 unsupported GLM 与 unknown OpenAI-compatible 模型既没有默认值，也没有获得
Thinking 支持。未发现阻塞 finding。

## 核对结果

- `DEEPSEEK_THINKING`、`GLM_5_2_THINKING`、`GLM_TOGGLE_THINKING`、`KIMI_TOGGLE_THINKING`
  均显式声明 `defaultEnabled: true`，并由对应内置模型复用；没有逐模型复制 capability 对象。
- supported 矩阵覆盖 DeepSeek V4 Pro/Flash、GLM-5.2、10 个 toggle-only GLM 与 Kimi K2.6，共 14 个模型。
- `GLM_UNSUPPORTED_THINKING` 保持 `kind: 'unsupported'` 且无 `defaultEnabled`；unknown lookup 仍返回
  `kind: 'unknown'` 且无默认值。通用 capability 测试同时证明两类均不被 `modelSupportsThinking` 接受。
- 模型集合、supported/unsupported 分类、effort/toggle 形态与 index 的官方能力裁决逐项一致。默认开启值也与
  本叶引用的官方来源一致：DeepSeek 明确 Thinking 默认开启；GLM 的 `thinking.type=enabled` 为默认并覆盖
  表中 4.5+ 模型；Kimi 配置的 Thinking 新会话默认值为 `enabled=true`。
- 测试使用 `it.each` 覆盖全部 14 个 supported、全部 3 个 unsupported 及 1 个 unknown；并保留既有
  DeepSeek effort、GLM-5.2 effort/disabled aliases、GLM toggle-only 与 Kimi 无伪造 effort 的矩阵。
- 文件职责单一；`builtinModelDescriptors.ts` 146 行，`builtinThinkingCapabilities.test.ts` 128 行，均低于
  300 行硬上限。

## 复跑验证

- `pnpm exec vitest run packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/modelThinkingCapability.test.ts`
  — **2 files / 36 tests passed**。
- `pnpm --filter @einfach-agent/ai build` — 通过。
- `git diff --check` — 通过；两个未跟踪叶文件分别执行 `git diff --no-index --check`，均无 whitespace
  error（退出码 1 仅表示相对 `/dev/null` 存在内容差异）。

## 范围确认

完整读取 index、010、015、050-review、015-report、两个声明文件，并追读 capability 契约与其单元测试以
确认 unsupported/unknown 的支持语义。除本 review 外未修改产品代码、任务或 index，未暂存、提交，也未派发
子 agent。
