# 030 执行报告：对话能力配置 UI

## 结果

已在 Composer 控制条提供会话“能力”入口和已选工具/Skills 摘要。面板通过 010 的公开
`getSessionCapabilityCatalog`、`toggleDraftSessionCapability` 与 `cloneSessionCapabilities` 命令
读取、修改和复制策略；Web 端没有读取 `loadedTools` 或改写 `SessionMeta`。

草稿态支持搜索、单项切换和分区全选/清空。locked/legacy 态为只读，locked 的 unavailable
tombstone 保留展示，二者均可创建并激活新草稿。`ActiveSessionProvider` 将策略只读投影到
Composer，使首发锁定更新会立即禁用已打开面板的交互控件。

审查修复：批量操作逐项 `await` 010 toggle，确保每次读取前一项已递增的 revision；失败后的
reload 保留 alert 和 retry；初次打开只聚焦关闭按钮，后续 catalog reload 不再抢走 checkbox
焦点；unavailable checkbox 经 `aria-describedby` 关联“不可用”说明。

`one-file-one-thing` 影响了划分：入口摘要、面板命令编排、单分区列表和响应式样式分别独立；
所有新增/大改普通源与测试文件均低于 300 行。

## 变更文件

- `apps/web/src/agentNew/ui/ActiveSessionProvider.tsx`：只读提供 capability policy 投影。
- `apps/web/src/agentNew/ui/Composer.tsx`、`ComposerControlBar.tsx`：接入入口、面板状态与策略版本。
- `apps/web/src/agentNew/ui/ConversationCapabilitiesButton.tsx`：入口和紧凑选中数摘要。
- `apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.tsx`：抽屉/全屏外壳、焦点、Escape、加载/错误、命令编排与 clone。
- `apps/web/src/agentNew/ui/ConversationCapabilitySection.tsx`：一个能力种类的搜索、批量操作与开关列表。
- `apps/web/src/agentNew/ui/conversation-capabilities.css`：桌面右侧抽屉、720px 以下全屏、safe area 与 reduced-motion 样式。
- `apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx`、`ConversationCapabilitiesPanel.locked.test.tsx`：入口摘要、draft、搜索、顺序批量切换、loading/error retry、unavailable accessible description、locked、legacy、clone、Escape/focus、真实 010 多工具批量操作、provider 锁定更新及窄屏 CSS media/safe-area 契约。
- `apps/web/src/i18n/locales/{en,zh-CN}/messages.po` 与生成的 `messages.js`：完整中英文 catalog。

## 验证

1. `pnpm lingui:extract && pnpm lingui:compile`
   - 508 messages，English Missing 0；重复 extract/compile 后 catalog 稳定。
2. `pnpm exec vitest run apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.locked.test.tsx apps/web/src/agentNew/ui/ComposerModelControls.integration.test.tsx`
   - PASS：3 files，11 tests。
   - `ConversationCapabilitiesPanel.locked.test.tsx` 使用真实 010 command 清空至少两个实际工具，并断言两者都写入 draft disabled allowlist，覆盖 revision 竞态修复。
3. `git diff --check`
   - PASS。
4. `wc -l` 对 9 个本任务触及的 UI 源/测试/CSS 文件逐项检查。
   - PASS：最大为存量小改的 `Composer.tsx` 294 行；新增文件最大
     `ConversationCapabilitiesPanel.tsx` 185 行。
5. `pnpm exec tsc -b --pretty false`
   - 当前被并行 020 的中间态阻断：`sessionCapabilityToolRuntime.test.ts` 有 readonly policy / model item
     类型不匹配，`tools/skills/src/skill-{read,search}` 缺 `ToolContext` 及一个隐式 any。030 未修改这些文件；
     编排者确认由合并工作区复跑。

## 视觉 QA

未启动浏览器截图会话。仓库没有浏览器/截图测试设施；JSDOM 测试已检查 CSSOM 的
`@media (max-width: 720px)` 中 `.conversation-capabilities-panel` 是 `100% × 100dvh`，并检查注入的样式
含 `safe-area-inset-bottom`。组件 DOM/ARIA 测试确认 `dialog`、modal、focus entering/return、Escape
和 disabled/read-only 语义；CSS 定义桌面右侧抽屉与 `max-width: 720px` 的全屏窄屏布局，底部 clone
操作包含 `safe-area-inset-bottom`，并禁用 reduced-motion 下的 spinner 动画。未 commit，未恢复 stash。
