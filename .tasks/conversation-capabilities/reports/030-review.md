# 030 独立复审

结论：**APPROVED**

## 复审结果

上一轮阻断项均已修复，未发现新的 030 阻断问题。

- 真实双项 bulk 已由并发改为顺序执行。`apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.tsx:73-88`
  对目标项逐个 `await toggleDraftSessionCapability`，避免多个命令共享旧 revision。使用真实 010
  `createCommands` 顺序禁用同类工具 `alpha`、`beta`，两次均返回 `updated`，最终策略为 revision 2 且
  `disabledTools: ["alpha", "beta"]`。UI 集成测试也使用真实命令选择至少两个当前工具、点击“清空”，并断言
  DOM 与 draft policy 均包含全部目标项
  （`apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.locked.test.tsx:43-63`）。
- 更新错误会保留。`load(preserveError)` 仅在非保留模式清错
  （`apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.tsx:46-57`），update catch 使用 `load(true)`
  （同文件 `:82-85`）；测试确认 toggle 拒绝后 alert 仍存在且 Retry 可用
  （`apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx:98-106`）。
- catalog reload 不再抢焦点。打开 effect 只依赖 `open` 与稳定 trigger ref，并把初始焦点放到面板关闭按钮
  （`apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.tsx:63-71`）；单项更新后 checkbox 保持焦点的断言位于
  `apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx:77-88`。Escape、Tab 环绕及关闭后焦点归还仍由
  Panel `:111-143` 和测试 `:122-131` 覆盖。
- unavailable 状态已进入可访问描述。checkbox 的 `aria-describedby` 与“不可用”文案使用同一稳定 id
  （`apps/web/src/agentNew/ui/ConversationCapabilitySection.tsx:9-11,63-83`），测试以
  `toHaveAccessibleDescription('不可用')` 验证（Panel test `:94-95`）。动态能力名称和描述仍直接渲染；只有
  固定 UI 文案进入 Lingui，边界正确。
- 窄屏契约已有机械覆盖。CSS 在 720px 以下将面板设为 `100% × 100dvh`
  （`apps/web/src/agentNew/ui/conversation-capabilities.css:69-73`），footer 使用 safe-area inset，同文件 `:63`；
  CSSOM 测试验证 media condition、尺寸与 safe-area 文本
  （`apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx:134-148`）。桌面右侧抽屉、可滚动 body 与
  modal dialog 语义分别见 CSS `:26-38`、Panel `:113-143`。唯一动画是 spinner，并在 reduced motion 下停用
  （CSS `:59-60,67,75-77`）。

## 其余验收核对

- draft、locked、legacy、初始 loading、空态、加载/更新 error、unavailable、clone、搜索、全选/清空均有
  实现和定向测试。首发锁定通过 Provider 的 policy 投影即时传入已打开 Panel，不依赖刷新
  （`apps/web/src/agentNew/ui/ActiveSessionProvider.tsx:69-79`；
  `apps/web/src/agentNew/ui/ComposerControlBar.tsx:145-153`；
  `apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.locked.test.tsx:65-86`）。
- locked/legacy clone 继续只调用 010 公共 `cloneSessionCapabilities`，Web 未改写 `SessionMeta` 或复制策略状态机
  （`apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.tsx:90-101,172-177`）。
- 030 文件职责符合声明：Button 负责入口摘要，Panel 负责外壳与命令编排，Section 负责单类列表，CSS 负责
  本功能样式。9 个 UI 源/测试/CSS 文件均 ≤300 物理行；最大为存量小改的 `Composer.tsx` 294 行，新增
  文件最大为 Panel 185 行。
- 执行报告已明确没有浏览器截图设施，并以 CSSOM + DOM/ARIA 测试覆盖窄屏契约；此限制不阻断本次验收。

## 复验命令

- `pnpm exec vitest run apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.locked.test.tsx apps/web/src/agentNew/ui/ComposerModelControls.integration.test.tsx packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts`
  - PASS：4 files，22 tests。
- 使用 `pnpm exec tsx -e` 调用真实 `createCommands`，依次 toggle 两个同类工具。
  - PASS：`["updated","updated"]`；最终 revision 2，两个工具均在 `disabledTools`。
- `git diff --check`
  - PASS。
- `wc -l` 检查 030 声明的 9 个 UI 源/测试/CSS 文件。
  - PASS，均 ≤300 行。
- `pnpm exec tsc -b --pretty false`
  - 非 030 阻断：仅报并行 020 当前中间态错误，位于
    `packages/agent-core/src/runtime/sessionCapabilityToolRuntime.test.ts`、
    `tools/skills/src/skill-read/skill-read.ts`、`tools/skills/src/skill-search/skill-search.ts`；030 声明文件无
    TypeScript 错误，按任务说明记录后继续验收 UI。
