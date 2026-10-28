# 180 浏览器工作台 UI 改版报告

## 设计计划与自审

这块界面的唯一任务是让使用者明确当前在和哪个 Agent 工作，并能快速找到 Agent、技能、模型与 API Key 配置。视觉识别点集中在顶部的小型工作台标识和单层四栏目导航；内容区保持克制，不使用营销式标题、统计卡、假在线状态或整片玻璃。

- 色彩：纸白 `#ffffff`、冷灰 `#f6f7fb`、墨色 `#202532`、次级文字 `#667085`、边界 `#e7eaf1`、重点蓝 `#4059de`。状态色只用于成功、危险、等待等实际语义。
- 字体：系统 `-apple-system / BlinkMacSystemFont / PingFang SC / system-ui`；正文和输入 14px，标签 13px，帮助文本 12px，页面标题 19px；工具数据使用 `SFMono-Regular`。
- 布局：宽屏是轻量列表加编辑表单；窄容器改为顺序流。初始对话空态隐藏无效选择器，只保留首配说明和一个入口。
- 签名：四栏目单层导航与“工具能力 / 技能能力”的紧凑披露。19 项工具不会淹没工作说明和模型选择。
- 动效：只有 100ms 按下、颜色和披露箭头反馈；`prefers-reduced-motion` 会全部关闭。
- 文件职责：`styles/shell.css` 管工作台壳、token 和通用控件；`styles/settings.css` 管配置列表、表单与能力披露；`styles/conversation.css` 管会话、消息与决策状态；`styles.css` 只聚合。组件仍按 chat/settings 的业务职责分布。

自审时删除了重复的配置子导航、英文 kicker、无 Agent 时的空选择器和大虚线空卡。没有添加远程字体、UI 依赖、假 macOS 窗控或装饰性玻璃。

## HIG 依据

实际读取了 Apple skill 的 `accessibility.md`、`layout.md`、`typography.md`、`color.md`、`designing-for-macos.md`、`entering-data.md`、`text-fields.md`、`buttons.md`、`sidebars.md`、`disclosure-controls.md`、`lists-and-tables.md`、`feedback.md`。

- `accessibility.md › Vision / Mobility / Speech`：正文对比、键盘焦点、桌面控件尺寸、颜色之外的文字状态；导航用 `aria-current`，列表选择用 `aria-pressed`。
- `layout.md › Best practices / Visual hierarchy`：用间距和浅层表面分组，重要的模型与工作说明优先，容器宽度自适应。
- `typography.md` 与 `color.md`：系统字体、少量字号层级和语义 token；提供浅色、深色、增强对比回退。
- `entering-data.md` 与 `text-fields.md`：保留动态错误和字段帮助，API Key 不回填，首配成功后明确下一步。
- `buttons.md`：只有主要保存/创建动作使用重点蓝；次要、文字和危险操作有不同视觉权重。
- `sidebars.md` 与 `lists-and-tables.md`：配置对象用持久选中行，宽屏列表与详情并列，窄屏自动顺序排列。
- `disclosure-controls.md › Best practices`：工具和技能属于次要细节，默认折叠；摘要显示选中数量，缺失引用自动展开并显示“取消选择后可保存”。
- `feedback.md › Best practices`：成功、失败、恢复与运行状态都留在相关上下文，不用普通弹窗。

HIG 提供的是层级、可访问性和交互原则。`#4059de` 的产品蓝、工作台小标识、四栏目名称、能力计数文案和 fixture 构图是本项目判断。浅色实际对比度：`#202532/#ffffff` 15.31:1，`#667085/#ffffff` 4.97:1，`#667085/#f6f7fb` 4.65:1，白字/`#4059de` 5.67:1。深色：`#f4f5f8/#191c25` 15.61:1，`#aeb6c7/#191c25` 8.36:1，`#11131a/#8291f2` 6.43:1，`#c3caff/#29305b` 7.92:1。

## 实现结果

- `BrowserAgentView` 保留 client WeakMap 身份隔离，合并为 `chat / agents / skills / connections` 单一视图状态，公开 props 未变。
- SettingsView 移除重复 subtabs；切换栏目时清理旧 success/error notice，首配连接到 Agent 的偏好链路仍保留。
- Agent 能力用原生 details 披露，显示选中/缺失数量。折叠只影响显示，checkbox 仍在表单内，测试覆盖缺失工具跨折叠仍保持选中并要求显式移除。
- 编辑器列表增加当前项语义和视觉选中态。宽屏双栏、360px 单列，普通按钮不再全部实色或描边。
- 对话首屏改为清楚的单行动空态；已有 Agent 后显示创建控件，Agent 被删除后已有会话选择仍可访问。消息、工具状态、确认、恢复、撤销、停止和输入语义保留。
- Extension 目标条改为紧凑中文，不展示 tab 数字；运行中禁止重绑和错误反馈保持可见。
- Fixture 改为居中工作台与次要业务预览；`width=360` 在桌面视口真实约束并居中，小视口贴边，模拟模型说明不覆盖表单。
- CSS 全局产品规则均限定在 `.browser-agent-view`；extension CSS 只作用于扩展自己的页面。

## 验证

- `pnpm exec vitest run browser-agent/ui browser-agent/extension`：10 files / 36 tests 通过。
- `pnpm --filter @einfach-agent/browser-agent-ui build`：通过。
- `pnpm --filter @einfach-agent/browser-extension build`：通过（在 UI build 完成后顺序执行）。
- `pnpm exec tsc -p tsconfig.app.json --noEmit`：通过。
- `pnpm check:state`：通过，扫描 1114 个非测试 TS/TSX 文件。
- `pnpm check:boundaries`：通过，扫描 1092 个非测试 TS/TSX 文件。
- `node scripts/check-docs.js`：620 个 Markdown 文件通过。
- 新增/大改源码与测试均不超过 300 行；`BrowserAgentView.test.tsx` 当前 282 行。

本执行没有启动浏览器、CDP、Playwright，也没有声称完成截图或原生键盘验证。宽屏、360px 和已安装扩展的原生 Chrome/CUA 证据由编排者独立记录。

末轮静态审查修正了 extension 目标条按钮的有效字体声明，并为深色模式提供独立 hover 背景；随后单独重建 extension 通过。编排者已记录安装扩展刷新后的 CUA 证据。

## 默认 DeepSeek V4.1 Flash 增量

新建模型连接现在只在 UI 草稿中预填 `DeepSeek V4.1 Flash`、`https://api.deepseek.com/v1` 和 `deepseek-flash`。API Key 仍为空，不读取环境或其他连接；已有连接编辑保持原值，点击新建仍可修改全部字段。首配测试先断言四项默认状态，再覆盖为自定义多模型配置并验证实际请求使用所选模型。

- 定向 UI：`BrowserAgentView.test.tsx` 与 `first-setup.test.tsx`，2 files / 11 tests 通过。
- UI build、随后 extension build 通过；`tsc -p tsconfig.app.json --noEmit` 通过。
