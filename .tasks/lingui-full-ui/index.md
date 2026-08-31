# Lingui 全界面中英文切换

创建：2026-08-21

基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`

状态：功能完成；全树集成收口已通过

## 目标

让 English 切换覆盖所有已发布的 Web 静态界面文案，而不只切换 WorkspaceSidebar。

`apps/web` 仍是唯一 UI 源码与 Lingui runtime；纯 Web 与 server/Tauri Webview 使用同一份 catalog。运行时
宿主差异不新增任何语言分支。

## 翻译边界

- 翻译 React 用户界面的静态标签、按钮、placeholder、固定状态、aria/title、可控的插值框架。
- 不翻译模型回复、用户输入、工作区/会话/插件/工具名称、工具 payload、文件路径、服务端错误原文或测试 fixture。
- `HostKind`、服务器协议和 Node/Tauri source 不属于本树。

## 全局约束

- 编排者只写本任务树、审查和调度；产品/测试代码一律由执行 agent 修改。
- 所有静态文案使用 Lingui `Trans`、`t` 或其符合当前 v6 配置的等价宏；禁止自建语言 state、条件中文/英文表或 React 本地 state。
- `apps/web/src/i18n/locales/**` 是共享生成物：只有 catalog 叶可写它、运行 extract/compile；源码叶不得编辑 PO 或编译产物。
- 所有源叶只修改明确列出的文件，保护现有 ModelConnection 与 Tauri 在途 diff；不 reset、暂存、提交、推送或批量格式化。
- 普通源文件单一职责且不超过 300 行；遇到既有超限文件只作最小迁移并在报告说明，不能借本任务大重构。
- English 验收必须激活真实 `activateLocale('en')`、使用 `AppI18nProvider`，不 mock 翻译结果；完成后恢复中文以免测试泄漏。

## 任务树

- 100 聊天主线 (`group`)
  - [010](010-session-navigation.md) 会话导航 (`leaf`，依赖：无)
  - [015](015-i18n-test-provider.md) 测试语言 Provider (`leaf`，依赖：无)
  - [020](020-message-transcript.md) 消息转录壳 (`leaf`，依赖：无)
  - [030](030-composer-surface.md) 消息输入面 (`leaf`，依赖：无)
  - [040](040-decision-cards.md) 执行决策卡 (`leaf`，依赖：无)
  - [050](050-conversation-catalog.md) 对话 catalog (`leaf`，依赖：010、020、030、040)
  - [060](060-conversation-regression.md) 对话英文回归 (`leaf`，依赖：050)
- 200 设置主线 (`group`)
  - [070](070-model-settings.md) 模型设置面 (`leaf`，依赖：060)
  - [080](080-mcp-settings.md) MCP 设置面 (`leaf`，依赖：060)
  - [090](090-plugin-skill-settings.md) 插件技能设置面 (`leaf`，依赖：060)
  - [100](100-settings-catalog.md) 设置 catalog (`leaf`，依赖：070、080、090)
  - [110](110-settings-regression.md) 设置英文回归 (`leaf`，依赖：100)
- 300 次级界面 (`group`)
  - [120](120-timeline-surface.md) 时间线固定框架 (`leaf`，依赖：110)
  - [150](150-final-i18n-delivery.md) 最终双语交付 (`leaf`，依赖：120，合并原 130、140)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 会话导航 | gpt-5.6-terra | completed | 2026-08-21 | 2026-08-21 |
| 015 | 测试语言 Provider | gpt-5.6-terra | completed | 2026-08-21 | 2026-08-21 |
| 020 | 消息转录壳 | gpt-5.6-sol | completed | 2026-08-21 | 2026-08-21 |
| 030 | 消息输入面 | gpt-5.6-terra | completed | 2026-08-21 | 2026-08-21 |
| 040 | 执行决策卡 | gpt-5.6-sol | completed | 2026-08-21 | 2026-08-21 |
| 050 | 对话 catalog | gpt-5.6-terra | completed | 2026-08-21 | 2026-08-21 |
| 060 | 对话英文回归 | gpt-5.6-sol | completed | 2026-08-21 | 2026-08-21 |
| 070 | 模型设置面 | gpt-5.6-terra | completed | 2026-08-21 | 2026-08-21 |
| 080 | MCP 设置面 | gpt-5.6-sol | completed | 2026-08-21 | 2026-08-21 |
| 090 | 插件技能设置面 | gpt-5.6-terra | completed | 2026-08-21 | 2026-08-21 |
| 100 | 设置 catalog | gpt-5.6-terra | completed | 2026-08-21 | 2026-08-21 |
| 110 | 设置英文回归 | gpt-5.6-sol | completed | 2026-08-21 | 2026-08-21 |
| 120 | 时间线固定框架 | gpt-5.6-sol | completed (final audit) | 2026-08-21 | 2026-08-21 |
| 130 | 次级 catalog | gpt-5.6-terra | merged into 150 | 2026-08-21 | 2026-08-21 |
| 140 | 全界面翻译审计 | gpt-5.6-sol | merged into 150 | 2026-08-21 | 2026-08-21 |
| 150 | 最终双语交付 | gpt-5.6-sol | completed | 2026-08-21 | 2026-08-21 |

## 调度与验证

先并行 010、020、030；040 在任一槽位释放时派发。050 是唯一写 PO 的聊天收口，随后 060 用真实 English
catalog 验收。设置和次级界面按依赖顺序继续，任一 catalog 完成前不得并行写 PO。

每个源码叶运行对应既有 Vitest 文件、`pnpm exec tsc -b` 与 `git diff --check -- <files>`；catalog 叶运行
`pnpm lingui:extract --clean`、`pnpm lingui:compile`；回归/审计运行其专项测试。全树完成后再跑
`pnpm build`、`pnpm check:state`、`pnpm check:boundaries`。已知任务外 `UndoBar.tsx` invariant 问题若仍使
`pnpm test` 失败，必须独立报告而非顺手修改。

## 决策与变更

- 裁决: 先修聊天主线 — 用户当前切到 English 仍直接看见聊天区中文；错了的代价是设置翻译晚一波可用。
- 裁决: catalog 串行收口 — PO/编译 JS 是共享生成物；错了的代价是并发写入导致翻译丢失或 catalog 污染。
- 裁决: 不翻译动态内容 — 内容来源不是 UI 设计文案；错了的代价是错误改变用户/模型/协议事实。
- 2026-08-21：基于用户对“仅 Workspaces 切换”的反馈，010、020、030 已并发派发；这三项不写共享 PO。
- 2026-08-21：010、020、030 的原有组件测试均未装配 Lingui Provider；发现 015 统一修补测试边界，
  其与源码叶无文件重叠。
- 2026-08-21：用户要求停止过度拆分；130 与 140 合并为 150，统一完成时间线 catalog 与全界面终验。
- 2026-08-31：全量测试发现 `BrowserActionCard.test.tsx` 未使用真实 i18n Provider，交由
  `integration-closure/010` 修复；120/150 缺失的历史独立 review 由 `integration-closure/030` 的当前
  全量终审取代。用户授权审查后分批 commit。
- 2026-08-31：catalog 经 `integration-closure/035` 稳定，`integration-closure/050` 全量门与最终独立审查 APPROVED，跨树收口完成。
