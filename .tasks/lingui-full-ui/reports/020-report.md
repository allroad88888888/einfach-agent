# 020 消息转录壳迁移报告

状态：`DONE_WITH_CONCERNS`

## 改动摘要

- `MessageList.tsx`：将空对话、思考过程标题/步骤数/展开收起、撤回按钮及其 `aria-label` / `title` 迁移到 Lingui `Trans` / `useLingui().t`。
- `MessageTimelineRenderer.tsx`：将流式生成光标的 `aria-label` 迁移到 Lingui。
- `ToolActivity.tsx`：将工具进度区域的 `aria-label` 迁移到 Lingui；工具名和进度正文继续原样渲染动态 payload。
- `ThoughtTraceEntries.tsx`：将思考/执行/注入标签、工具状态与标题、调用/结果框架、详情标签、等待态和截断字符数插值迁移到 Lingui。
- 模型思考、消息正文、运行时事件标题/摘要/详情、工具名、参数和结果内容均保持原样；未改 timeline view model、运行状态或消息数据。
- `MessageList.tsx` 开始时已有未提交的撤回功能改动；本任务保留其行为，只迁移其中静态文案。
- 按 `one-file-one-thing` 检查：四个文件分别为 230、34、28、235 行，均未超过 300 行。

## 逐条验收命令与结果

1. `pnpm exec vitest run apps/web/src/agentNew/ui/MessageList.test.tsx apps/web/src/agentNew/ui/MessageList.timeline.test.tsx apps/web/src/agentNew/ui/ToolActivity.test.tsx`
   - 结果：失败，退出码 1；3 个测试文件、16 个测试均失败。
   - 原因：现有测试 wrapper 未提供 Lingui `I18nProvider`，组件在 `useLingui()` 处统一抛出 `useLingui hook was used without I18nProvider`。编排者已确认此为已有测试基建差距，本叶不得扩写范围外测试文件。
2. `pnpm exec tsc -b`
   - 结果：失败，退出码 2。
   - 原因：任务范围外的 ModelConnection 在途改动存在 `ModelConnectionProfile.model` / `models` 类型不一致；报错集中于 `ModelConnectionProfileSettings.tsx`、`ModelCredentialPanel.connections.test.tsx` 和 `apps/web/src/settings/**`。四个本任务文件未产生 TypeScript 报错。
3. `git diff --check -- apps/web/src/agentNew/ui/MessageList.tsx apps/web/src/agentNew/ui/MessageTimelineRenderer.tsx apps/web/src/agentNew/ui/ToolActivity.tsx apps/web/src/agentNew/ui/ThoughtTraceEntries.tsx`
   - 结果：通过，退出码 0，无输出。

## 未验证项

- 未验证真实 English catalog 下的显示结果；按任务树由 050 提取/翻译 catalog，再由 060 使用 `activateLocale('en')` 与 `AppI18nProvider` 回归。
- 遵守约束，未运行 Lingui extract/compile，未编辑 PO 或编译产物。
- 因现有专项测试 wrapper 缺少 `I18nProvider`，未获得本叶三个既有测试文件的绿色回归结果。

## 范围外发现

- `MessageList.test.tsx`、`MessageList.timeline.test.tsx`、`ToolActivity.test.tsx` 的渲染 helper 尚未接入 `AppI18nProvider`。
- ModelConnectionProfile 的 `model` 到 `models` 迁移当前不一致，阻塞仓库级 `tsc -b`。
- `MessageList.tsx` 在本任务开始前已是 dirty 状态，包含撤回消息、恢复草稿与聚焦输入框的功能改动；本任务未改变该逻辑。

## 疑虑

- 专项测试与类型检查均未全绿，因此交付标记为 `DONE_WITH_CONCERNS`；当前失败均有明确的任务范围外原因。
- 050 生成 catalog 前，新消息只存在于源码，English 切换尚不能展示对应翻译。

## 建议后续动作

1. 由负责回归测试的叶任务将上述旧测试接入真实 `AppI18nProvider`，激活目标 locale 后重跑专项测试。
2. 由 ModelConnection 在途改动所有者统一 `ModelConnectionProfile.model/models` 契约后重跑 `pnpm exec tsc -b`。
3. 050 按依赖执行 extract/翻译/compile，060 再做真实中英文切换回归。
