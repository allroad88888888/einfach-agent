# 040 执行报告

## 改动摘要

- 将 `PlanPanel.tsx` 中计划/阶段状态、展开收起、回滚提示、交付物/依赖、证据/阻塞插值框架、审批与继续动作迁移到 Lingui。
- 将 `PlanStageExecutionTrace.tsx` 中 section aria、section title 与空态文案迁移到 Lingui。
- 将 `ToolConfirmCard.tsx` 中风险状态、工具标题、参数预览 aria、session 授权与允许/拒绝动作迁移到 Lingui。
- 将 `AskUserQuestionCard.tsx` 中暂停状态、默认标题、section aria、必填提示、placeholder、是/否与继续动作迁移到 Lingui。
- 统一使用 `@lingui/react/macro` 的 `useLingui().t` 或 `Trans`；未使用 named `t` import。
- 保持 plan/stage title、objective、deliverables、risk reason、tool name/args、用户问题/选项、block reason 等动态数据原样；未改变批准、拒绝、继续、回滚、工具确认或回答命令。
- 未编辑 PO/编译产物，未运行 Lingui extract/compile，未改动任务 files 边界外的产品或测试文件。
- 行数自检：`PlanPanel.tsx` 256、`PlanStageExecutionTrace.tsx` 55、`ToolConfirmCard.tsx` 137、`AskUserQuestionCard.tsx` 220，均不超过 300 行。

## 逐条验收命令与结果

1. `pnpm exec vitest run apps/web/src/agentNew/ui/PlanPanel.test.tsx apps/web/src/agentNew/ui/PlanPanel.commandBoundary.test.tsx apps/web/src/agentNew/ui/ToolConfirmCard.test.tsx apps/web/src/agentNew/ui/AskUserQuestionCard.test.tsx`
   - 结果：未通过，4 个 test files 失败，28 个 tests 中 27 失败、1 通过。
   - 直接原因：当前共享 `renderWithStore` 未提供 `I18nProvider`，组件在 `useLingui()` 处一致抛出 `useLingui hook was used without I18nProvider`。
   - 编排者已确认共享任务 015 负责将 `renderWithStore` 接入真实 `AppI18nProvider`，015 完成后由统一复验收口；040 不越界修改 helper。

2. `pnpm exec tsc -b`
   - 结果：未通过，exit code 2。
   - 任务外原因：ModelConnection 在 `model`/`models` 之间存在在途类型漂移，错误位于 `ModelConnectionProfileSettings.tsx`、`ModelCredentialPanel.connections.test.tsx`、`apps/web/src/settings/**` 等任务外文件。
   - TypeScript 输出没有指向 040 的四个文件。

3. `git diff --check -- apps/web/src/agentNew/ui/PlanPanel.tsx apps/web/src/agentNew/ui/PlanStageExecutionTrace.tsx apps/web/src/agentNew/ui/ToolConfirmCard.tsx apps/web/src/agentNew/ui/AskUserQuestionCard.tsx`
   - 结果：通过，无输出。

4. `wc -l apps/web/src/agentNew/ui/PlanPanel.tsx apps/web/src/agentNew/ui/PlanStageExecutionTrace.tsx apps/web/src/agentNew/ui/ToolConfirmCard.tsx apps/web/src/agentNew/ui/AskUserQuestionCard.tsx`
   - 结果：通过，依次为 256/55/137/220 行。

## 未验证项

- 未在 015 合入后重跑四个专项 Vitest 文件；由编排者统一复验。
- 未得到全量 `pnpm exec tsc -b` 绿灯；当前被任务外 ModelConnection 类型漂移阻断。
- 未验证 English catalog 实际译文；050 是唯一 catalog 写入任务，060 负责真实 English 回归。

## 范围外发现

- 共享测试 helper 当前缺少 `I18nProvider`；已由任务 015 处理。
- ModelConnection 相关在途改动导致 `model`/`models` 类型不一致，阻断全量 TypeScript 验收。

## 疑虑

- 专项测试与全量 TypeScript 尚无绿灯，因此本任务应标记为 `DONE_WITH_CONCERNS`。
- `Trans` 保留了工具标题中 `<code>` 富文本插值；其余需要 string prop 或条件字符串的文案使用 `useLingui().t`。

## 建议后续动作

1. 015 完成后重跑 040 的四个专项 Vitest 文件。
2. ModelConnection 在途改动收口后重跑 `pnpm exec tsc -b`。
3. 050 对本任务新增 message 执行 extract/英文翻译/compile，060 使用真实 `activateLocale('en')` 与 `AppI18nProvider` 做 English 回归。

## R1 修复与复验

### 修复摘要

- 在 `ToolConfirmCard.tsx` 中将 `apply_patch` 多路径预览的静态分隔符 `、` 迁移为 Lingui message（通过 `useLingui().t`）。
- `ConfirmCardBody` 调用 `useLingui().t` 得到翻译后分隔符，再显式传给纯格式化 helper `describeArgs`；helper 未使用 hook。
- 路径值仍从工具参数原样提取，确认命令、风险判断、session 授权与截断行为均未改变。

### R1 验收结果

1. `pnpm exec vitest run apps/web/src/agentNew/ui/PlanPanel.test.tsx apps/web/src/agentNew/ui/PlanPanel.commandBoundary.test.tsx apps/web/src/agentNew/ui/ToolConfirmCard.test.tsx apps/web/src/agentNew/ui/AskUserQuestionCard.test.tsx`
   - 结果：通过，4/4 test files 通过，28/28 tests 通过。
   - 此结果取代本报告前文因共享 Provider 缺失导致的专项测试失败记录。

2. `git diff --check -- apps/web/src/agentNew/ui/PlanPanel.tsx apps/web/src/agentNew/ui/PlanStageExecutionTrace.tsx apps/web/src/agentNew/ui/ToolConfirmCard.tsx apps/web/src/agentNew/ui/AskUserQuestionCard.tsx`
   - 结果：通过，无输出。

3. `wc -l apps/web/src/agentNew/ui/PlanPanel.tsx apps/web/src/agentNew/ui/PlanStageExecutionTrace.tsx apps/web/src/agentNew/ui/ToolConfirmCard.tsx apps/web/src/agentNew/ui/AskUserQuestionCard.tsx`
   - 结果：通过，依次为 256/55/137/220 行，均不超过 300 行。

### R1 未验证项与疑虑

- R1 按指定验收范围未重跑 `pnpm exec tsc -b`；前次任务外 ModelConnection `model`/`models` 类型漂移记录仍保留。
- 无新增范围外发现或 R1 代码疑虑。
