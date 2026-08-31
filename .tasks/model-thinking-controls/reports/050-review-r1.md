# 050 R1 独立复审

## 结论

**APPROVE**

上轮唯一 High 已闭合，未发现邻近回归。`thinking === undefined` 现在只在受支持 capability 上读取受审 `defaultEnabled`；unsupported/unknown 始终投影为 false/不可用。DeepSeek effort 与 Kimi toggle-only 的 provider-default 均初始显示 On，首次点击经真实 command 精确写入 `thinking: false`；显式 `true/false` 的显示与首次点击仍正确。

## 上轮 High 闭合证据

- `apps/web/src/agentNew/ui/ComposerControlBar.tsx:68-69` 的解析顺序为：先要求 capability 是 `toggle|effort`，再取 `modelSettings.thinking ?? capability.defaultEnabled ?? false`。因此显式 `false` 不会被默认 `true` 覆盖，显式 `true` 保持 On；unsupported/unknown 即使 settings 中有脏 `thinking: true` 也被外层 capability kind 门控为 false。
- 015 已在四个共享受支持 capability 上声明 `defaultEnabled: true`：DeepSeek effort、GLM-5.2 effort、GLM toggle-only 与 Kimi toggle-only（`packages/agent-ai/src/builtinModelDescriptors.ts:58-88`）。unsupported capability 与全局 unknown capability 均无默认值。
- `apps/web/src/agentNew/ui/ComposerModelControls.integration.test.tsx:96-111` 使用真实 `defaultCore` command，以矩阵覆盖 DeepSeek V4 Pro 和 Kimi K2.6 的缺省 `thinking`：初始按钮 `aria-pressed=true`，第一次点击后完整 session settings 写入 `thinking:false`，且只持久化一次。该路径证明修复不是组件本地视觉假象。
- `apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx:26-55` 证明显式 On 首次点击上报 `false`、显式 Off 首次点击上报 `true`，并保留对应 `aria-pressed`、radio enabled/disabled 语义。
- capability 矩阵逐项覆盖全部 14 个 supported 内置模型 `defaultEnabled:true`、3 个 unsupported GLM 无默认值及 unknown OpenAI-compatible 无默认值（`packages/agent-ai/src/builtinThinkingCapabilities.test.ts:38-44,94-127`）。

## 无回归核对

- R1 的产品改动仅是 ControlBar 的受控 enabled 派生；三类 settings handler、完整 `ModelSettings`、profile identity、busy 锁、Auto/effort、会话切换及原 Composer 发送/授权/附件路径未变。
- DOM 结构、可见文案、`ComposerThinkingControl` 产品组件及全部 CSS 均未修改，因此复用已审的 1440×900、640×900 中文与 640×900 英文视觉证据是充分的；窄窗、focus 与 reduced-motion 结论不变。
- 行数：ControlBar 127、Thinking component test 91、integration test 135、Composer 293、015 两个文件 146/128；均低于 300 行硬上限。

## 复跑验证

- `pnpm exec vitest run packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/modelThinkingCapability.test.ts`：**2 files / 36 tests passed**。
- `pnpm exec vitest run`（050 指定 5 个文件）：**5 files / 32 tests passed**。
- `pnpm exec tsc -b tsconfig.app.json --pretty false`：通过。
- R1 相关 tracked/untracked diff whitespace 与物理行数检查：通过。

## Findings

- Critical：无。
- High：无。
- Medium：无。
- Low：无。

## 范围确认

本次限定复审读取 015 task/report/review、更新后的 ControlBar、Thinking 组件测试、真实 command 集成测试、050 report R1 记录及 capability 数据/矩阵；只核对上轮唯一 High 与邻近回归。除本 review 外未修改产品代码、task、index 或 PO，未暂存、提交，也未派发子 agent。
