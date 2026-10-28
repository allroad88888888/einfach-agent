# 230 独立覆盖验收

结论：**PASSED**。

独立复核 `220-chat-first-layout.md`、最终 `220-scope.diff` / `220-prechange.diff`、执行报告与编排原生 CUA 图证后，C01–C05 均成立。未发现 Critical、Important 或 Minor 产品问题；没有把测试通过替代视觉验收。审查只写本报告，未修改产品代码、账本或既有报告，也未重复运行已绿测试。

## 发现与修正闭环

编排首次真实发送消息后发现连续 6 条内部 runtime event 默认展开，仍会挤占对话正文。220 已将相邻事件合并为默认关闭的“运行详情”，并把工具参数与结果收进折叠区，同时常显工具名称及执行中/完成/失败状态（`ConversationTimeline.tsx:9-29`）。最终 360px CUA 复验看到“运行详情 6”默认关闭；新增 2 项定向回归覆盖事件分组和工具详情展开。该 Important 候选已在验收前关闭，不留作通过后的已知缺陷。

独立审查还要求历史命令测试按真实入口操作，而不是直接点击关闭 `details` 内的按钮；最终测试先断言“会话操作”默认关闭、点击 summary 展开，再执行撤销/重做，保留显式 sessionId 与另一会话不受影响的断言。执行报告记录该定向文件 10/10 通过。

## C01–C05 覆盖

- **C01 通过：默认内容明显减量。** 默认页仅保留 Agent、会话、新建与带 `aria-label`/`title` 的 32px 齿轮（`ChatView.tsx:18-24`；`conversation.css:2-7`），移除了品牌头、四栏目常驻导航与重复对话说明。360px 与真实扩展截图均显示四控件单行且无水平溢出。符合 `layout.md › Best practices` 的关键内容留足空间，以及 `toolbars.md › Best practices` 的工具栏精简原则。
- **C02 通过：设置入口、首配与焦点完整。** 设置为同容器替换视图，含 Agent、技能、模型与 API Key 三项；空态直达连接，保存连接后进入 Agent，再返回对话创建会话。聊天保持 mounted，原生 `hidden` 使其退出可访问树；进入设置聚焦标题，返回/Escape 聚焦齿轮（`View.tsx:20-41`、`SettingsView.tsx`）。CUA 实际验证隐藏聊天不可访问、焦点往返、session 与草稿保留。Web 右上角齿轮遵循用户明确裁决；没有套用 macOS 原生菜单入口建议。符合 `accessibility.md › Speech` 的键盘可达原则与 `settings.md › Best practices` 的低频配置分流原则。
- **C03 通过：消息区占主高度，composer 固定底部。** 组件、扩展壳与聊天主体形成 `height:100%` / `min-height:0` 链；消息区为剩余空间独立滚动，活动区有上限并独立滚动，composer 是末行且 textarea/发送按钮同行（`conversation.css:1-13,51-60`；`sidepanel.css:3-6`）。360px 有消息截图中消息区约占四分之三，输入区保持可见；宽版等待卡片也未把输入区推出容器。
- **C04 通过：运行、决策、恢复与历史语义保留。** 忙碌/错误状态、停止、工具确认、追问答复、恢复与人工核对继续显式呈现；所有动作仍传当前显示的 `sessionId`（`ChatView.tsx:33-69`、`DecisionCards.tsx`）。撤销/重做及外部副作用边界位于“会话操作”；内部运行详情和工具原始 JSON 使用渐进披露。宽版 CUA 覆盖等待答复、停止、问题卡片和底部禁用输入；回归覆盖确认、答复、恢复、停止、撤销/重做与双会话隔离。
- **C05 通过：嵌入、隔离与生产扩展成立。** `BrowserAgentView` 的 `client` / `className` 合同未变；WeakMap client key 在 client 切换时重挂载本地 UI 状态，相关测试覆盖连接/API Key/Agent 草稿不跨 client。CSS 仅使用组件或扩展前缀；宽版业务 iframe 未受污染。真实已安装 extension dist 重载后，CUA 在已授权页面完成现有会话选择与重新绑定，最终截图显示单行目标栏、紧凑会话栏、大消息区和底部输入区。模型首配仍预填 DeepSeek V4.1 Flash / endpoint / model 且 Key 为空；19 工具、真实 CRUD、公开运行包与扩展构建边界未回退。

## 验证证据

- 执行叶最终记录：UI + extension 共 12 files / 47 tests 通过；UI build、extension build、根 app TypeScript、docs 与 `git diff --check` 通过。
- 独立审查要求的历史入口测试修改后，`BrowserAgentView.test.tsx` 10/10 定向通过。
- 编排 CUA 覆盖 360px 有消息与草稿、360px 三栏设置、宽版等待状态，以及真实 extension dist 重载后的目标绑定和高度布局。
- Apple HIG 审查采用 Web/桌面设计原则：`accessibility.md`、`layout.md`、`typography.md`、`color.md`、`designing-for-macos.md`、`toolbars.md`、`buttons.md`、`settings.md`、`entering-data.md`、`text-fields.md`、`focus-and-selection.md`、`scroll-views.md`。用户指定的 Web 右上角齿轮优先于原生 macOS 菜单约定。

深色与极端缩放未在本轮 CUA 中另行切换；源码提供暗色 token、提高对比度、减少动效与减少透明度媒体查询。这是图证范围说明，不影响 C01–C05 当前验收结论。
