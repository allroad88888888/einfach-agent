---
id: '220'
title: 浏览器侧栏以大面积对话为主，配置收进右上角设置
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: '180'
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/ui/**
  - browser-agent/extension/src/app.tsx
  - browser-agent/extension/src/sidepanel.css
---

用户最新明确指出「整个布局信息都太臃肿，对话窗口太小，大部分应该丢到右上角，加设置 icon」。这是已获执行授权的既有任务树续改。本任务取代 180 的常驻四栏目导航方向，不推翻已完成模型表单与工具功能。

## 设计与实现合同

- 必须读取 /Users/dol/.codex/skills/apple-hig-design/SKILL.md 及其要求的基础参考和 toolbars/settings/buttons；应用基础 Web 信息层级与逐步展开原则，不套原生 macOS 菜单栏限制（用户明确要右上角齿轮）。也应用 frontend-design-codex 与 one-file-one-thing。报告先写具体布局与职责清单，普通源码/测试 <=300 行，不做碎片化拆分、不加包/依赖/字体。
- C01 默认对话：去掉「浏览器工作台 / Agent 配置与执行」品牌头、常驻 对话/Agent/技能/模型 四导航、重复「对话」标题与说明。顶部紧凑工具栏只保留当前 Agent/会话、新建、右上角设置图标；尽量单行，360px 最多两行，不能每个控件竖排一整行。历史会话可用轻量展开入口；为图标提供 aria-label/title，最小点击区32px，焦点清楚。不要缩小消息字号来腾空间。
- C02 设置：右上角齿轮打开同容器设置页，有清楚「返回对话」或关闭入口，内含 Agent / 技能 / 模型与 API Key 三项；仅在设置页呈现这些导航，维持真实首配连接→Agent→开始对话链路。窄侧栏用全容器替换视图，不做窄屏叠多个弹窗/小抽屉。可以保持 ChatView mounted+hidden 以保留选中 session 和未发送 draft，隐藏视图必须不可聚焦/不在可访问树中；不假称 modal 然后缺焦点管理。进入设置移动焦点到设置标题/返回，关闭回到齿轮；局部 Escape 支持返回，不注册宿主全局键盘。
- C03 对话高度：修复当前 .bav-messages min-height260/max-height52vh 与外层 min-height100% 导致嵌入/侧栏挤压。已定高容器用完整 flex/grid 高度链、min-height:0；消息记录占剩余空间并独立滚动，输入区固定在组件底部，不能靠把整个 body 锁定欺骗预览。360x约700 场景中消息区应占主要高度（目标>=60%，按真实截图判断），发送按钮和输入区同行/组合，不再窄屏整行巨大按钮。空态简短，首次配置行动保留。
- C04 次要信息：撤销/重做与长边界说明放会话更多/历史操作的展开区（保留撤销只影响对话的说明，在使用动作时可见）；空闲状态不长期占一行，忙碌/停止、错误、确认、追问、恢复依旧明显且可操作，内容过长不把输入框推出视口。扩展 target-bar 改一行目标名或「未绑定页面」，可把重新绑定放 details/更多内，错误不能隐藏。不得改权限、bindActiveTab、bridge或会话创建语义；保留当前 service-worker action 授权修复。
- C05 嵌入与隔离：BrowserAgentView 公开 client/className 合同不破坏，保留 WeakMap client 身份隔离及 sessionId 显式命令；设置开关不能清掉草稿，但切换 client 必须清掉。样式仅本组件前缀，不污染宿主。生产包和 extension 都需正确，不靠 fixture 覆盖产品 CSS；fixture 可窄改有限高度壳来真实验证。保留 19 工具、模型 DeepSeek V4.1 Flash 预填（key空）、既有真实 CRUD、模拟模型/业务 iframe。

## 入口与验证

源码入口 ui/src/View.tsx、chat/ChatView.tsx、chat/ConversationTimeline.tsx、settings/SettingsView.tsx、styles/{shell,conversation,settings}.css，扩展 app.tsx/sidepanel.css。
就近 meaningful 测试：配置导航从齿轮进入/返回、选定会话和未发送 draft 来回设置仍保留、client 切换仍清理、必要焦点/键盘；更新旧测试导航查询，保留 CRUD/第二模型transport/缺失引用/显式session命令断言。不要删除原断言换成简单快照。BrowserAgentView.test.tsx 接近300行，新增场景另设有意义场景文件。
根cwd执行 pnpm exec vitest run browser-agent/ui browser-agent/extension；UI build→extension build；根 tsc；docs/diff check。禁止 install/改 lock、Chrome/浏览器/CDP/Playwright、钥匙串、真实Key、远程issue、commit/push、再次委派。所有既有未提交工作保留。
报告只写 /Volumes/work/ai/web-agent/.tasks/browser-agent/reports/220-report.md，不改任务与index。视觉基本稳定及最新 dist 可用时提前通知编排，编排会在原生Chrome CUA做宽/360px截图与操作验证；不可冒称自己截图。完成后独立230覆盖审查。

200 授权问题实现已修，真实 Chrome 初始停在单网站权限弹窗。用户侧稍后完成后，编排已只读观察真实会话成功绑定；此任务不扩大权限或以重设计绕过授权。

现场 C04 追加：编排在本地实际消息中发现连续6条内部运行事件常驻占空间。220已将连续runtime-event合并为默认关闭「运行详情」，工具名称/状态常显，参数结果折叠，保留projection/runtime语义。12 files/47 tests通过，后续仅历史操作测试补先展开details，定向10/10通过；最终diff由编排更新。
