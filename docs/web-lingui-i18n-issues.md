# Web Lingui 中英文界面 Issue 树

状态：首个垂直切片已完成；全界面迁移待后续波次
创建日期：2026-08-21
协调者：`/root`（架构、验收与集成审查；不直接实现叶子）

## 目标与边界

在 Web 桌面界面接入 Lingui `6.6.0`（当前 npm stable），提供持久的中文/英文选择，且在应用右上角可随时切换。首个垂直切片覆盖全局运行时、右上角开关、工作区侧栏和 Shell 的可见文案；其余既有界面分批迁移，不允许把未翻译字符串伪装成已完成的双语支持。

当前交付完成 L00–L10：运行时、持久化偏好、右上角开关、Shell、工作区侧栏与目录字段已支持中英文。L20 之后仍是已拆分、未开始的迁移债。

非目标：本卡不翻译模型生成内容、用户输入、文件名、工具返回或第三方插件内容；不修改 Core/CLI/服务端协议；不触碰当前在途的模型连接配置行为。

## 已确认的约束

- 依赖均锁定到 `6.6.0`：`@lingui/core`、`@lingui/react`、`@lingui/cli`、`@lingui/vite-plugin`、`@lingui/babel-plugin-lingui-macro`。React 宏从 `@lingui/react/macro` 导入；不安装已废止且仅停在 `5.9.5` 的 `@lingui/macro` 包。
- 应用根在 `apps/web`，入口 `apps/web/src/main.tsx`；状态只能用 Einfach。语言偏好必须是独立 atom，不接入目前有在途改动的 `settings/*`。
- 现有工作树脏；所有叶子禁止重置、暂存、提交或改动未列出的文件。`AppShell*` 有用户在途改动，集成卡只能在冻结输入后作最小追加并保留已有 diff。
- 每个新增源文件一句话职责且不超过 300 行；CSS 遵循现有 `agentnew.<域>.css` 分片方式。

## 任务树

```text
LINGUI-I18N  Web 中英文界面
├─ L00  运行时与构建契约
│  ├─ L00A  Lingui 6.6.0 工具链与目录配置
│  └─ L00B  Einfach 语言偏好与 catalog 激活
├─ L10  首个可用界面
│  ├─ L10A  工作区侧栏文案迁移
│  ├─ L10A1 工作区目录字段文案迁移
│  ├─ L10A2 工作区侧栏英文 catalog
│  ├─ L10B  右上角语言切换控件
│  ├─ L10B1 语言控件英文 catalog
│  └─ L10C  Shell 挂载与可访问性集成
├─ L20  对话主线迁移
│  ├─ L20A  会话列表
│  ├─ L20B  无会话空态
│  ├─ L20C  消息列表壳
│  ├─ L20D  输入框
│  ├─ L20E  工具活动
│  ├─ L20F  计划面板
│  ├─ L20G  工具确认卡
│  ├─ L20H  补充问题卡
│  └─ L20I  上下文统计
├─ L30  设置面迁移
│  ├─ L30A  设置中心入口
│  ├─ L30B  启动凭据门禁
│  ├─ L30C  模型凭据面板
│  ├─ L30D  模型端点卡
│  ├─ L30E  模型连接配置（GATED）
│  ├─ L30F  MCP 设置面板
│  ├─ L30G  MCP 服务器卡
│  ├─ L30H  MCP 新建服务器表单
│  ├─ L30I  插件设置面板
│  ├─ L30J  插件条目与工具开关
│  └─ L30K  项目 Skills 面板
├─ L40  验证与交付
│  ├─ L40A  catalog 提取/编译门禁
│  ├─ L40B  中文↔英文端到端回归
│  └─ L40C  独立审查与脏工作树核验
└─ L50  后续范围登记
   └─ L50A  未迁移 UI 与翻译债清单
```

## 叶子任务与模型分配

| ID | Wave | Owner model | Exclusive files | 目标、非目标与验收 | Status |
| --- | --- | --- | --- | --- | --- |
| L00A | 1 | gpt-5.6-sol（high） | `package.json`、`pnpm-lock.yaml`、`lingui.config.ts`、`vite.config.ts` | 加 Lingui v6 正确工具链（core/react/cli/vite/babel macro 均 6.6.0）与 extract/compile 脚本，配置 `zh-CN`/`en` catalog；不改 UI。`pnpm lingui:extract --clean`、`pnpm lingui:compile`、`pnpm build` 通过。 | done：extract/compile、Vite build、locale chunks，2026-08-21 |
| L00B | 1 | gpt-5.6-sol（high） | `apps/web/src/i18n/**`、`apps/web/src/main.tsx`、专属测试 | 建独立 Einfach 偏好 atom、浏览器持久化与安全的异步 catalog 激活；将 `I18nProvider` 接到根。不得使用 React state/Context 承载语言偏好。切换、重载恢复、未知 locale 回退均有测试。 | done：i18n 7/7；main static/server + i18n 14/14，2026-08-21 |
| L10A | 1 | gpt-5.6-terra（medium） | `WorkspaceSidebar.tsx`、其测试 | 将侧栏用户可见静态文案迁为 Lingui；不改全局运行时或 Shell。保留中文交互断言，英文 catalog 与渲染证据由 L10A2 负责。 | done：中文/英文测试 6/6，2026-08-21 |
| L10A1 | 2 | gpt-5.6-luna（medium） | `WorkspaceRootField.tsx`、其测试、两份 PO 中由该字段提取的 entries | 迁移由工作区设置弹层呈现的目录字段文案；不改 `WorkspaceSidebar` 或设置状态。中文/英文均有聚焦断言。 | done：2/2 测试、catalog 编译，2026-08-21 |
| L10A2 | 2 | gpt-5.6-terra（medium） | `apps/web/src/i18n/locales/en/messages.po` 中由 `WorkspaceSidebar` 提取的 entries | 填写 L10A 的英文 `msgstr`，随后编译并给出英文渲染证据；不修改其他组件的 entries。首次提取已冻结。 | done：14 条英译与测试证据，2026-08-21 |
| L10B | 2 | gpt-5.6-terra（medium） | 新建 `LanguageSwitcher.tsx`、专属测试、`agentnew.language-switcher.css`、`agentnew.css` 中一条 import | 创建无状态（只读写 L00B atom）的 `中文 / English` 可访问控件；不改 `AppShell`。键盘操作与当前语言的 `aria-pressed` 有测试。`agentnew.css` 有用户在途注释改动，只允许追加一条 import。 | done：2/2 测试与 tsc，2026-08-21 |
| L10B1 | 3 | gpt-5.6-terra（medium） | 两份 PO 中由 `LanguageSwitcher` 提取的 entries | 填写语言控件所需英文 `msgstr` 并追加英文激活断言；L10A1 已释放 PO。 | done：英文可访问名称、3/3 测试，2026-08-21 |
| L10C | 4 | gpt-5.6-sol（high） | `AppShell.tsx`、`AppShell.test.tsx`、新建 `agentnew.app-shell-header.css`、`agentnew.css` 中一条 import、两份 PO 中由 AppShell 提取的 entries | 将 L10B 放在主界面右上角并补 Shell 的可见文案；保留工作树中既有在途 diff。`agentnew.css` 只可追加 import。前置输入均已冻结。 | done：7/7 测试、catalog 编译与 tsc，2026-08-21 |
| L20A | 5 | gpt-5.6-terra（medium） | `SessionList.tsx`、`SessionList.test.tsx`、专属 PO entries | 迁移会话导航；不改会话命令或动态标题。双语聚焦测试。 | ready |
| L20B | 5 | gpt-5.6-luna（medium） | `ActiveSessionProvider.tsx`、其测试、专属 PO entries | 仅迁移无会话空态；不改变会话 store 绑定。 | ready |
| L20C | 5 | gpt-5.6-sol（high） | `MessageList.tsx`、`MessageList.test.tsx`、专属 PO entries | 迁移消息表层固定文案；模型、用户和工具 payload 保持原样。 | ready |
| L20D | 5 | gpt-5.6-terra（medium） | `Composer.tsx`、`Composer.test.tsx`、专属 PO entries | 迁移输入框固定提示/动作；附件子组件另立卡。 | ready |
| L20E | 5 | gpt-5.6-luna（medium） | `ToolActivity.tsx`、`ToolActivity.test.tsx`、专属 PO entries | 迁移工具活动的固定状态文案；动态工具名不翻译。 | ready |
| L20F | 5 | gpt-5.6-sol（high） | `PlanPanel.tsx`、`PlanPanel.test.tsx`、专属 PO entries | 迁移计划面板固定 UI，不改变批准/继续命令。 | ready |
| L20G | 5 | gpt-5.6-terra（medium） | `ToolConfirmCard.tsx`、其测试、专属 PO entries | 迁移危险工具确认卡的固定动作；工具 payload 不翻译。 | ready |
| L20H | 5 | gpt-5.6-terra（medium） | `AskUserQuestionCard.tsx`、其测试、专属 PO entries | 迁移补充问题卡的框架文本；问题内容保持原样。 | ready |
| L20I | 5 | gpt-5.6-luna（medium） | `ContextStats.tsx`、其测试、专属 PO entries | 迁移上下文统计的标签；数字与模型数据保持原样。 | ready |
| L30A | 6 | gpt-5.6-terra（medium） | `SettingsCenter.tsx`、其测试、专属 PO entries | 迁移设置中心入口，不改开关状态。 | blocked: L20A–L20I |
| L30B | 6 | gpt-5.6-luna（medium） | `StartupCredentialGate.tsx`、其测试、专属 PO entries | 迁移启动凭据门禁，不改凭据校验。 | blocked: L20A–L20I |
| L30C | 6 | gpt-5.6-terra（medium） | `ModelCredentialPanel.tsx`、`ModelCredentialCard.tsx`、各自测试、专属 PO entries | 迁移模型凭据界面；不改存储或网络行为。 | blocked: L20A–L20I |
| L30D | 6 | gpt-5.6-luna（medium） | `ModelEndpointCard.tsx`、其测试、专属 PO entries | 迁移模型端点卡；不改 endpoint 配置。 | blocked: L20A–L20I |
| L30E | 6 | gpt-5.6-sol（high） | `ModelConnectionProfilesPanel*`、专属 PO entries | 迁移模型连接配置；必须等当前在途模型连接改动冻结。 | GATED: 现有脏文件 |
| L30F | 6 | gpt-5.6-terra（medium） | `McpSettingsPanel.tsx`、其测试、专属 PO entries | 迁移 MCP 总面板；不改连接配置。 | blocked: L20A–L20I |
| L30G | 6 | gpt-5.6-sol（high） | `McpServerCard.tsx`、其测试、专属 PO entries | 迁移服务器卡；协议字段与诊断动态内容保持原样。 | blocked: L20A–L20I |
| L30H | 6 | gpt-5.6-terra（medium） | `McpAddServerForm.tsx`、其测试、专属 PO entries | 迁移新增服务器表单；不改校验规则。 | blocked: L20A–L20I |
| L30I | 6 | gpt-5.6-terra（medium） | `PluginSettingsPanel.tsx`、其测试、专属 PO entries | 迁移插件设置容器；不翻译插件元数据。 | blocked: L20A–L20I |
| L30J | 6 | gpt-5.6-luna（medium） | `PluginEntryCard.tsx`、`PluginToolToggleList.tsx`、各自测试、专属 PO entries | 迁移插件条目固定 UI；插件名与描述不翻译。 | blocked: L20A–L20I |
| L30K | 6 | gpt-5.6-terra（medium） | `ProjectSkillsPanel.tsx`、其测试、专属 PO entries | 迁移项目 Skills UI；技能原始名称与描述不翻译。 | blocked: L20A–L20I |
| L40A | 7 | gpt-5.6-luna（medium） | 新建专属 catalog 检查脚本与测试（如需） | 让 extract、compile、构建可重复执行；不擅改业务 UI。 | blocked: L30A–L30K |
| L40B | 6 | gpt-5.6-sol（high） | 新建独立 e2e/integration 测试 | 覆盖初始中文、切英文、重载恢复、主导航无遗留中文的负例；不复用业务组件测试文件。 | blocked: L40A |
| L40C | 7 | gpt-5.6-sol（high，非实现 owner） | 只读审查；必要时新增独立审查测试 | 审查 atom 边界、catalog 完整性、可访问性、依赖版本与意外脏文件；逐项记录 P0/P1/P2。 | blocked: L40B |
| L50A | 7 | gpt-5.6-luna（medium） | 本文 | 列出仅因范围/在途改动未迁移的用户可见文案；不把它们标记为完成。 | blocked: L40C |

## 波次与并发规则

- Wave 1 的 L00A、L00B、L10A 文件完全不重叠，可并发；L00A/L00B 同属一个 Owner，避免 `main.tsx` 和 catalog 契约交叉写入。
- L10B 只能在 L00B 给出稳定 export 后开始；L10C 是唯一允许修改 `AppShell*` 的叶子，且必须复核脏工作树。
- L20/L30 的每项以文件集独占，禁止并发接触同一组件或测试。源码/专属测试可并行；两份 PO 是共享生成物，必须先由一个已完成源码叶子独占 extract、填写其 entries、compile 后才把 PO 释放给下一叶。动态文案保持原始数据，不纳入翻译 catalog。
- 任何实现者不得暂存、提交、重置或格式化未列出的文件；根代理只做架构、账本、验收和只读验证。

## 验证基线

- 工具链：`pnpm lingui:extract --clean`、`pnpm lingui:compile`、`pnpm build`。
- 组件：每个叶子的 `pnpm exec vitest run <owned tests>`。
- 全量：`pnpm test`、`pnpm check:state`、`pnpm check:boundaries`、`git diff --check`。
- 交付前以 `git status --short` 和逐路径 diff 将本功能与已有模型连接在途改动分开核验。
