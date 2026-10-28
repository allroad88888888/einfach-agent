# 190 独立覆盖验收：180 UI 改版

## 结论

**PASSED**。V01–V05 全部通过。源码审查未发现隔离、首配、选择、存储或会话命令语义回归；编排已补齐四次真实 CUA 视觉观察，本次复验也通过现有原生 Chrome 只读截图独立看到了同屏的宽屏 Agent 配置与新版真实扩展窄侧栏。界面已消除双层导航、密集默认控件和无意义卡片，生产样式、360px 容器与已安装扩展均有实际证据。

本评审只读产品和当前 Chrome 画面，没有点击、导航、输入或操作业务网页，没有重跑已报告为绿色的测试，也没有启动浏览器/CDP/Playwright、安装扩展、访问凭据或调用真实模型。

## V01–V05 覆盖结果

| 项目 | 结果 | 独立审查证据 |
| --- | --- | --- |
| V01 主导航/空态 | 通过 | `View.tsx` 只有一层四栏目导航并使用 `aria-current`，模型入口可访问名称为“模型与 API Key”。编排 360px 空态图证显示无空 Agent/会话选择器，只有清楚首配说明与单一 CTA。本次只读截图也看到扩展窄侧栏的四栏目、对话说明和单 CTA，层级清楚。 |
| V02 模型表单 | 通过 | `ConnectionEditor.tsx` 保存名称、接口地址、模型 ID 和可选 API Key；保存后清空 password DOM 值，已配置状态只显示文字。编排真实 360px 模型表单观察确认字段、帮助文、状态与保存动作无横向溢出或覆盖；`first-setup.test.tsx` 覆盖实际模型传输与密钥不回显。 |
| V03 Agent/技能 | 通过 | 连接变更会重置模型；工具和技能仍以原生 checkbox 随表单提交。折叠不丢选择，缺失引用默认展开并要求显式移除。宽屏图证与本次截图都显示列表在左、编辑表单在右，工作说明和模型优先，工具/技能以箭头和数量紧凑分组。 |
| V04 对话 | 通过 | 会话选择继续显式调用 `selectSession`；提问、确认、停止、恢复、撤销/重做均携带显示中的 `sessionId`。现有测试覆盖工具进度、问题、确认、停止、恢复、undo/redo 与双会话隔离。 |
| V05 宿主/360px/宽屏 | 通过 | 产品规则限定在 `.browser-agent-view`，生产 `dist/styles.css` 包含拆分后的 shell/settings/conversation 规则，容器查询覆盖 420/560/620px，fixture 的 `width=360` 真正约束根容器。编排已观察 360 空态、360 模型表单、宽屏 Agent 和已安装扩展；本次现有 Chrome 截图再次确认宽屏产品区、隔离业务 iframe 与窄侧栏同时正确呈现。 |

## 功能回归结论

- client 隔离：`BrowserAgentView` 继续以 `WeakMap` 身份 key 重挂内部 workspace；测试覆盖双 client 并存及切换 client 后连接/API Key/Agent 草稿不串用。
- 首配：空态 → 模型连接 → Agent → 对话的偏好连接链路保留，模型传输与 API Key 不回显有定向测试。
- 选择语义：编辑列表使用 `aria-pressed`，主导航使用 `aria-current`；工具/技能勾选不会因折叠丢失，缺失引用不会静默删除。
- 存储语义：连接、技能资源、Agent CRUD 仍调用公开 client；既有会话继续使用创建时快照，视觉改版没有改变持久化结构。
- 对话语义：显式 session 命令、停止、确认、恢复、撤销和不可逆边界均保留。
- 验证：执行者报告 UI + extension 10 files / 36 tests、UI/extension build、app tsc、state、boundaries、docs 通过；编排亲验全 browser-agent 与 boundaries 为 48 files / 179 tests，并且根 `tsc -b` 通过。本次按任务要求没有重复执行。

## 独立视觉复验

重新读取后的 `180-browser-check.md` 记录了四次实际 CUA 观察：真实 360px 空态、360px 模型表单、宽屏 Agent 能力分组、重新加载后的已安装扩展侧栏。原始图证在编排会话的 CUA 图像输出，报告没有虚构本地 PNG 路径。

本次通过 `cua.getApp('com.google.Chrome')` 与只读 `getScreenshot()` 直接查看当前 Chrome，没有执行任何页面动作。画面同时显示：

- 宽屏工作台使用纸白/冷灰层次，顶部只有一层四栏目导航；Agent 列表和编辑表单并列，主要保存按钮突出，管理模型按钮保持次级权重。
- 工作说明、连接和模型在能力详情之前；工具/技能是两条轻量 disclosure 行，不再用大卡片堆叠 19 项工具。
- 业务 iframe 位于独立次要面板，与产品工作台的字体、边界和背景互不污染。
- 真实扩展侧栏显示中文“目标页面 / 创建会话后将自动绑定当前页面”、工作台头、四栏目与纯净空态；窄宽度下“模型与 Key”仍完整可读，没有横向溢出、裁切或覆盖。

视觉中能看到默认业务 iframe 的原生控件较朴素，但它明确属于隔离演示业务页，不是 Browser Agent 产品样式缺陷。

## 设计与 HIG 审查

本次按 Apple skill 实际读取并用于核对：`accessibility.md`、`layout.md`、`typography.md`、`color.md`、`designing-for-macos.md`、`entering-data.md`、`text-fields.md`、`buttons.md`、`sidebars.md`、`disclosure-controls.md`、`lists-and-tables.md`、`feedback.md`。这些原则只用于 Web 侧栏的层级、反馈、可访问性和适配，没有强加原生菜单栏或 iOS 底栏。

- `accessibility.md › Vision / Mobility`：清楚焦点环、文字状态和桌面最小 28px 目标均保留；正文/帮助文字为 14/12px。报告计算的浅色正文、次级文字和主按钮对比度均达到 4.5:1。
- `layout.md › Best practices`、`lists-and-tables.md › Best practices`：列表与详情在宽容器并列，小容器顺序排列，选中行有持久反馈；实图未见拥挤或溢出。
- `disclosure-controls.md › Best practices`：工具和技能放在有描述与计数的 disclosure 中，模型和工作说明保持可见；缺失引用自动展开。
- `buttons.md`、`feedback.md › Best practices`：主要保存/创建使用重点色，次要、文字、危险动作权重不同；成功和错误反馈留在相关表单上下文。
- `entering-data.md`、`text-fields.md`：API Key 不预填、不回显，字段有帮助文本，首配成功后给出下一步。

编排最终静态检查还发现扩展目标条深色按钮 hover 曾沿用浅色背景，以及 `font` shorthand 写法无效。180 已把 hover 改为 `#303543`，并改用 `font-family`、`font-size`、`line-height` 分项声明；extension build 通过且 dist 时间已更新。浅色实图不受该窄修影响，深色源码对比和有效字体继承问题已闭合。

## 限制

本轮没有切换用户系统外观去实测深色、增强对比或减少动态，也没有重复原生键盘和真实保存操作；这些状态由语义 token、媒体查询、对比度审查及既有 user-event/真实 client 回归覆盖。现有证据足以完成 180 的既定验收，不构成遗留缺陷。
