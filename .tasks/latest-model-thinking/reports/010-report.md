# 010 执行报告

## 状态

DONE_WITH_CONCERNS

## 改动摘要

- 在 `ModelThinkingCapability` 的受支持能力契约上增加只读可选字段 `required`；省略时保持现有 optional 行为。
- 新增 provider-neutral 的 `modelRequiresThinking(capability)` 查询，并把 `modelSupportsThinking()` 收窄为类型谓词。
- Composer 对 required capability 使用有效开启状态：始终显示 `On`，开关不可操作，`aria-label` 与 `title` 均说明“Thinking 始终开启”，同时 effort radio 仍可选择。
- Composer 设置转换在模型选择、程序化开关与 effort 更新三个入口都将 required capability 归一为 `thinking: true`；普通 optional、unsupported 与 unknown 行为保持原测试覆盖。
- 通过合成 required capability 测试语义，没有提前修改由 030/040 负责的 GLM/Kimi 模型目录。
- `ComposerThinkingControl.css` 无需改动；已有 disabled/enabled 样式可表达新状态。

## 逐条验收命令与结果

1. `pnpm exec vitest run packages/agent-ai/src/modelThinkingCapability.test.ts apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx apps/web/src/agentNew/ui/composerModelSettings.test.ts`
   - 结果：通过；3 个测试文件、23 个测试全部通过。
2. `pnpm exec tsc -b --pretty false`
   - 结果：通过；退出码 0，无诊断输出。
3. `git diff --check -- packages/agent-ai/src/modelThinkingCapability.ts packages/agent-ai/src/modelThinkingCapability.test.ts apps/web/src/agentNew/ui/ComposerThinkingControl.tsx apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx apps/web/src/agentNew/ui/composerModelSettings.ts apps/web/src/agentNew/ui/composerModelSettings.test.ts apps/web/src/agentNew/ui/ComposerThinkingControl.css`
   - 结果：通过；无空白错误。
4. `wc -l packages/agent-ai/src/modelThinkingCapability.ts packages/agent-ai/src/modelThinkingCapability.test.ts apps/web/src/agentNew/ui/ComposerThinkingControl.tsx apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx apps/web/src/agentNew/ui/composerModelSettings.ts apps/web/src/agentNew/ui/composerModelSettings.test.ts apps/web/src/agentNew/ui/ComposerThinkingControl.css`
   - 结果：依次为 100、80、104、119、143、248、199 行，全部不超过 300 行。
5. `pnpm exec eslint packages/agent-ai/src/modelThinkingCapability.ts packages/agent-ai/src/modelThinkingCapability.test.ts apps/web/src/agentNew/ui/ComposerThinkingControl.tsx apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx apps/web/src/agentNew/ui/composerModelSettings.ts apps/web/src/agentNew/ui/composerModelSettings.test.ts`
   - 结果：未执行成功；仓库环境没有 `eslint` 可执行文件，pnpm 返回 `Command "eslint" not found`。

## 已完成覆盖矩阵行及证据

- `C-04`：完成本叶负责的 required capability + Composer 基础语义。`ComposerThinkingControl.test.tsx` 以合成 effort capability 验证 On、禁止关闭、三档可选及明确 aria/title；GLM-5.3 两个实际目录项由后续 030 接入。
- `C-06`：完成本叶负责的 required capability + Composer 基础语义。同一 provider-neutral 测试可供 Kimi K3 消费；Kimi K3 实际目录项由后续 040 接入。
- `C-14`（010 任务文件所列）：完成强制思考设置转换。`composerModelSettings.test.ts` 验证选择 required 模型、请求关闭、选择具体 effort 与 Auto 时均保持 `thinking: true`。索引覆盖矩阵没有 `C-14` 行，见“疑虑”。
- capability 契约证据：`modelThinkingCapability.test.ts` 验证显式 `required: true` 才返回 true，省略字段及 unknown 均返回 false。

## 未验证项

- 未执行 ESLint：当前依赖环境未提供该命令。
- 未做浏览器视觉检查；本叶没有 CSS 改动，控件 DOM/可访问状态由 Testing Library 覆盖。
- 未验证实际 GLM-5.3/Kimi K3 catalog 项，因为这些属于依赖本叶的 030/040，当前目录仍是旧型号。
- 未运行整树的 build、Lingui extract/compile、state/boundary 检查；它们属于索引最终总门，不是 010 验收命令。

## 范围外发现

- 工作区已有 `.gitignore`、`.project-lines/`、`CLAUDE.md`、UndoBar、若干 agent CSS、`apps/desktop/gen/` 等无关改动；均未触碰。
- 任务文件将 `C-14` 列为本叶覆盖行，但索引覆盖矩阵当前只定义 `C-01` 至 `C-13`。

## 疑虑

- `C-14` 的语义可从任务上下文推断为“强制思考设置转换”，但缺少索引中的正式矩阵定义，后续审查时可能产生编号歧义。
- ESLint 命令缺失，因此只能以 Vitest、TypeScript 与 diff 检查作为当前静态/动态证据。

## 建议后续动作

- 编排者在账本中确认或补齐 `C-14` 的正式定义，或把 010 任务文件中的编号纠正为已有矩阵行。
- 030/040 在实际 GLM-5.3 与 Kimi K3 capability 上声明 `required: true`，复用本叶 helper，禁止在 React/adapter 写型号黑名单。
- 最终总门使用仓库实际提供的 lint/check 脚本；若预期直接运行 ESLint，应补齐对应开发依赖或命令入口。
