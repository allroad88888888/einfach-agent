---
id: "030"
title: 实现对话配置交互
kind: leaf
parent: "200"
depends_on: ["010"]
model: gpt-5.6-terra
status: done
created: 2026-09-08
base: 0fb3afbdf656df7184134075887aa414eb348828
done: 2026-09-08
files:
  - apps/web/src/agentNew/ui/ComposerControlBar.tsx
  - apps/web/src/agentNew/ui/Composer.tsx
  - apps/web/src/agentNew/ui/ConversationCapabilitiesButton.tsx
  - apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.tsx
  - apps/web/src/agentNew/ui/ConversationCapabilitySection.tsx
  - apps/web/src/agentNew/ui/conversation-capabilities.css
  - apps/web/src/agentNew/ui/ActiveSessionProvider.tsx
  - apps/web/src/agentNew/ui/WorkspaceSidebar.tsx
  - apps/web/src/agentNew/ui/**/*ConversationCapabilit*.test.tsx
  - apps/web/src/i18n/locales/en/messages.po
  - apps/web/src/i18n/locales/en/messages.js
  - apps/web/src/i18n/locales/zh-CN/messages.po
  - apps/web/src/i18n/locales/zh-CN/messages.js
  - .tasks/conversation-capabilities/reports/030-report.md
---

# 实现对话配置交互

## 目标

在 Composer 附近提供清晰的会话工具/Skill 设置：空白草稿可编辑，已开始对话只读，并能复用配置创建新对话。

## 前置契约

先阅读 `010-session-policy-contract.md`、010 report 和实际导出。使用 010 公共命令，不直接改 `SessionMeta`、
不在 Web 端重写状态机或从 `loadedTools` 猜权限。

## 交互与视觉要求

- 在 Composer 控制条增加“能力”入口，展示工具数与 Skill 数的紧凑摘要；不挤占模型与审批控件。
- 空白草稿打开桌面右侧抽屉，窄屏（沿用项目 breakpoint）打开全屏面板。包含标题、状态说明、搜索框、
  工具/Skills 两个分区、分区全选/清空、每项开关、选中计数、关闭操作。
- 草稿切换即时写入会话命令；加载期间禁用操作并显示 skeleton/spinner；目录为空有具体空态；失败可重试。
- 一旦首条消息锁定，已打开面板立即切为只读，开关不可交互，说明“配置在发送首条消息后锁定”。
  已允许但当前消失/被上界禁用的项目保留展示，标记“不可用”，不能重新启用。
- 锁定态主操作为“按此配置新建对话”，调用 010 clone 命令，创建并激活一个可编辑草稿；原对话不变。
- legacy 老会话展示只读“旧版默认配置”，复制时按当前安全默认创建草稿。
- 使用项目现有 token、图标、focus ring、motion 与 Overlay/Dialog 习惯；避免卡片套卡片与装饰性渐变。
- Escape 关闭；打开后焦点进入面板；关闭归还触发按钮；窄屏可滚动且底部操作不被软键盘/安全区遮挡；
  支持 reduced motion。按钮与开关有可访问名称、键盘路径和正确 disabled/read-only 语义。
- 所有固定文案使用 Lingui，补齐中文与英文 catalog；动态工具/Skill 名称和描述不翻译。

## 文件职责

- Button 只负责入口与摘要。
- Panel 只负责面板外壳、加载/错误/锁定状态与命令编排。
- Section 只负责一个可搜索、可批量切换的能力列表分区。
- 独立 CSS 只负责本功能响应式样式；若现有文件改动将超限，应抽 hook/子组件而非继续堆叠。

## 验收标准

1. 组件测试覆盖 draft 加载/切换/搜索/全选/清空、锁定只读、unavailable、legacy、错误重试与 clone。
2. 断言首发导致的 provider/meta 更新会让已打开面板切换为 locked，不要求刷新。
3. 桌面与窄屏 DOM/ARIA 行为有测试；Escape、焦点归还、键盘操作和 disabled 状态正确。
4. `pnpm lingui:extract` 与 `pnpm lingui:compile`（若脚本名称不同，使用仓库现有等价命令）后 catalog 稳定。
5. 相关 Vitest、`pnpm exec tsc -b --pretty false`、`git diff --check` 与声明文件 `wc -l` 全绿。
6. 报告写入 `reports/030-report.md`，列出精确文件、命令、结果与截图/视觉 QA 情况；不得 commit。

## 执行记录（仅编排者回写）

- 2026-09-08：依赖 010，当前阻塞。
- 2026-09-08：010 已验收，解除阻塞。
- 2026-09-08：已派发执行。
- 2026-09-08：初审 CHANGES_REQUESTED 后完成批量竞态、错误、焦点与 ARIA 修复；独立复审 APPROVED。
