# 插件生态蓝图

> **这是演进蓝图，描述目标形态，不代表任何 API 已交付。** 本文只做设计，不含实现。
> 当前真实可用的插件面以 [Core 插件化蓝图](core-plugin-extraction-blueprint.md)、
> [插件扩展面产品化蓝图](plugin-productization-blueprint.md)、
> [插件 UI Renderer 协议蓝图](plugin-renderer-protocol-blueprint.md) 与
> [`packages/agent-core/src/plugin.ts`](../packages/agent-core/src/plugin.ts) 的代码为准。
> 对应 issue：[插件生态与模型 Provider 注册化 Issue 树](plugin-and-provider-issues.md) 的 P1。
> 更新时间：2026-08-13。

> **交付状态（截至 P11，2026-08-13）**：第 3 节全部交付——目录约定（3.1）、加载协议（3.2，
> manifest 解析 + 动态导入 + branded 导出校验）、错误隔离（3.3）与三宿主接线（3.4 的 CLI 行
> `apps/cli/src/plugins.ts`、桌面行 `apps/web/src/plugins/desktopProvider.ts` 经 Tauri 桥 +
> blob 求值 + 契约桥说明符重写，浏览器预览按蓝图明示不支持）；第 4 节工具闸门已交付
> （`pluginToolGate.ts` 默认不注册 + 面板逐工具勾选、记录按用户存）；第 5 节设置面板与熔断
> （连续 3 次失败自动停用）已交付并随 `main.tsx` 启动装配；20 分钟上手验收见
> [`plugin-quickstart.md`](plugin-quickstart.md)（CLI 真实运行验证，桌面路径有生产等价单测、
> 待真机复验）。**未交付**：第 6 节 npm 分发仍阻塞于 G4（core 公开面收敛）；第 7 节
> `timeline.persist` 阻塞于 R5 RFC 未批准。

## 1. 问题陈述

今天的插件是 **assembly-time** 的：宿主源码里 `createCore({ plugins })` 传入，改插件 = 改仓库 =
重新构建。对标物 [pi 的 Extensions](launch/competitor-facts.md) 是 **load-time** 的：一个
TypeScript 模块丢进目录就生效。本蓝图回答的唯一问题是——**怎么把前者产品化成后者**，而不是
再造一套扩展点。

## 2. 现状盘点：内核层已备，生态层缺失

| 能力面 | 内核层（已交付） | 生态层缺口 |
| --- | --- | --- |
| 安装面 | `definePlugin` + `createCore({ plugins })`，branded 校验、按 Core 实例隔离 | 只能由宿主源码传入；用户没有"加装"入口 |
| loop hook | `prepareRequest`、`beforeToolCall`、`afterToolCall`、`shouldStop` 已接线，失败隔离并写 trace | hook 没有稳定的插件身份维度；无法按插件单独停用 |
| 插件工具 | `registerTool` + 安装前全量重名预检、原子拒绝、卸载无残留 | 第三方工具要不要对模型可见，没有策略 |
| CallTiming | 九个核心时机，`<domain>:<event>` 由宿主经受限 API 分派 | 插件不能声明自己的时机域 |
| renderer | [`packages/agent-react/src/index.ts`](../packages/agent-react/src/index.ts) 的 per-root registry，内建 kind 锁定、失败回滚 | 只能由 React root 在源码里 `installReactPlugins` |
| 受限命令 | `stopCurrentRun()` facade，作用域限当前会话当前 run | 没有 per-plugin 的权限分层 |
| 观测 | trace span/event（[`observability/types.ts`](../packages/agent-core/src/observability/types.ts)），插件失败已有事件 | trace 里没有稳定的 `plugin.id`，无法按插件归因 |
| 样例 | [`packages/agent-plugin-example`](../packages/agent-plugin-example/README.md) 的 Core + React 配对样板 | 没有分发形态，只能在 workspace 内引用 |

结论：**缺的不是扩展点，是"装配之外的入口 + 插件身份 + 信任确认"**。本蓝图的三块新东西正是
目录加载、身份/manifest、确认与启停；已有的 hook/工具/renderer 契约一律复用，不重造。

## 3. 动态加载面

### 3.1 目录约定

`<workspace>/.webAgent/plugins/<plugin-dir>/`，与项目 Skills 同源，扫描先例照抄
[`tools/skills/src/projectSkillsLoader.ts`](../tools/skills/src/projectSkillsLoader.ts) 与
[项目内 Skills 自动加载蓝图](project-skills-blueprint.md)：固定根目录、扫描条目上限、
**目录不存在不算错误**（绝大多数 workspace 没有它，否则设置页常驻噪声诊断）、单条失败只记
diagnostics 不影响其余。

两种形状，同一套加载器：

- **单文件插件**：`<plugin-dir>/plugin.js` —— 最低门槛，对齐 pi 的"一个模块即可"。
- **包插件**：`<plugin-dir>/package.json` 的 `main`/`exports` —— 为 npm 分发预留（见第 6 节）。

### 3.2 加载协议

入口旁的 `plugin.json`（包插件可用 `package.json` 的 `webAgent` 字段）声明：

| 字段 | 约束 |
| --- | --- |
| `id` | 反向域名 namespace，**直接复用** [R5 RFC](persistent-plugin-timeline-item-rfc.md) 第 3 节的 `plugin.id` 正则与禁用前缀（`core.*`、`web-agent.*`）。身份规则先统一，省一次迁移。 |
| `name` / `version` | 展示与诊断用；`version` 不属于信任边界。 |
| `apiVersion` | 宿主声明支持区间；不匹配即不加载，列为 `incompatible` 诊断项，不是崩溃。 |
| `capabilities` | 申报要用的面：`tools` / `hooks` / `commands` / `renderer` / `timeline.persist`。 |
| `entry` | `core` 与 `react` **必须分开声明**，对齐 renderer 协议里"两套独立安装面"的既有结论。 |

导出契约：入口的默认导出（或具名 `corePlugin` / `reactPlugin`）必须是 `definePlugin` /
`defineReactPlugin` 的产物，由 `isPublicPlugin` 之类的 branded 检查把关，裸对象一律拒绝。
**注册只允许发生在 install 回调里**，top-level 副作用做注册的插件视为不合规——否则"加载"和
"启用"无法分离，第 4 节的确认门就形同虚设。

### 3.3 错误隔离：坏插件不许拖垮 runtime

四道线，每道都降级为诊断项而不是异常传播：

1. **扫描期**：manifest 缺失/JSON 坏/字段非法 → 跳过该目录，记 diagnostics。
2. **加载期**：动态 import 抛错、语法错误、apiVersion 不匹配 → 该插件标 `failed`/`incompatible`，
   **不阻塞其余插件，也不阻塞应用启动**。
3. **安装期**：工具重名等 → 沿用已交付的全量预检 + 原子拒绝，回滚该插件已注册项。
4. **运行期**：hook 抛错沿用现有隔离（trace 证据 + 按 hook 契约收敛 run），并新增熔断——连续
   失败 N 次自动停用该插件（N 与恢复方式见第 8 节开放决策）。

### 3.4 三宿主差异（第一期不平均用力）

| 宿主 | 加载机制 | 诚实的风险描述 | 第一期 |
| --- | --- | --- | --- |
| 桌面（Tauri） | Rust 侧读文件 → 前端 `import()` blob URL 或等价求值 | **这是在渲染进程里执行第三方代码，与页面同权**：可触达 Tauri IPC、DOM、`fetch`。manifest 的 `capabilities` 在第一期是**申报，不是沙箱**，不得在 UI 上暗示它有强制力。若桌面壳启用了 CSP，需先确认插件求值的策略缺口。 | 支持（唯一既有 workspace FS 又有完整 UI 的宿主） |
| CLI（Node） | 原生动态 `import()` file URL | 最自然，但外部插件**必须自带 Node 可直接消费的 ESM**：仓库内的 `?raw` 与 workspace alias 不适用，也不能要求消费方复刻 [`raw-module-loader.mjs`](../apps/cli/src/raw-module-loader.mjs)。无 React root，故只装 core 侧入口。 | 支持（core 插件） |
| 浏览器预览（非 Tauri dev / 静态产物） | 无 workspace 文件系统 | 项目 Skills 在这里已天然降级为空，插件同理。**不要**为它造 dev server 读盘端点——那等于给浏览器开一条任意文件读取通道。 | **不支持**，设置页明示"当前宿主不支持用户插件" |

## 4. 信任模型

### 4.1 借鉴 MCP 起进程确认

[MCP 的 stdio 起进程确认](mcp-integration.md) 已经把"执行本机代码前先问"这件事做对过一次，
两条经验直接搬：

- **确认绑定指纹，不绑定名字**（[`stdioLaunchConsent.ts`](../apps/web/src/mcp/stdioLaunchConsent.ts)）：
  MCP 把 command/args/cwd/env 一起进指纹，因为"改了 env = 换了实际执行的代码"。插件同构——
  consent 绑定 **入口文件字节 + 规范化 manifest 的哈希**，改一个字节旧确认即作废。不这样的话，
  插件自更新就能绕过用户当初批准的那件事。
- **卡片摊开真实后果**（[`McpLaunchConsentPrompt.tsx`](../apps/web/src/agentNew/ui/McpLaunchConsentPrompt.tsx)）：
  首次加载时展示插件 id、来源路径或 npm 包名与版本、申报的能力清单（注册哪些工具、挂哪些 hook、
  是否有模型可见工具、是否需要 renderer），并直白写明"此代码将以与应用相同的权限在本机运行"。

**确认粒度**：整插件一次，不逐能力追问——逐能力问只会训练用户点"全部同意"。但能力清单变化会改
manifest 哈希，因而自动触发重新确认。

### 4.2 权限分层（建议形态）

| 层 | 内容 | 确认强度 |
| --- | --- | --- |
| L0 | 纯 renderer（只有 `defineReactPlugin` 入口） | 仍执行第三方代码，只是不进模型与工具面；文案可弱化，**不可省略确认** |
| L1 | core 插件：工具、hook、受限命令 | 完整确认，逐条列出工具名与 hook 名 |
| L2 | 申报 `timeline.persist` | 一律拒绝，阻塞于 R5（见第 7 节） |

必须诚实：L0 与 L1 的差别是**申报口径**，不是运行时隔离。真正的隔离要 worker/iframe 沙箱，
第一期不做（见第 8 节非目标）。

### 4.3 默认姿态 = 开放决策

默认关（每个插件都要确认）还是默认开（目录存在即信任），**本蓝图不替用户拍板**，列入第 9 节。

## 5. 启停与可观测

- **设置页新增"插件"面板**：列出扫描结果与状态机 `discovered → pending_consent → enabled /
  disabled / failed / incompatible`，每条可启停。启停状态按 workspace 持久化（与 MCP 配置同类的
  独立 JSON），**不进会话历史，也不进 checkpoint**。
- **启停不需要重启应用**：停用 = 执行安装 disposer（P2.1 已有卸载语义，工具与订阅无残留）；
  启用 = 走一次完整安装预检。但诚实写清楚：**已在跑的 run 不受影响，改动从下一个 run 生效**——
  中途更换 hook 集合会让同一次 run 的前后半段行为不一致。
- **归因**：插件相关的 span/event 一律带 `plugin.id` 与 `plugin.version` 属性。`TraceAttributes` 是
  `Record<string, unknown>`，加维度不需要改任何 driver；现有的插件失败事件补齐这两个属性即可。
  插件注册的工具在 trace 里标注 owner，使"哪个插件让这次 run 变慢/失败"可查。
- **用户可见文案指名道姓**：显示"插件 X 的 afterToolCall 失败"，不是"内部错误"。归因做不到指名，
  启停面板就只是摆设。

## 6. 分发

**阶段 1 · 本地目录**：用户手放或 clone 进 `.webAgent/plugins/`。这是第一期的唯一形态。

**阶段 2 · npm 包**：阻塞于 [npm 发包方案蓝图](launch/npm-publish-plan.md)。插件必须
`import '@web-agent/core/plugin'`（React 侧还要 `@web-agent/react-plugin`），而这两个包今天
`private: true` 且 `exports` 指向 `.ts` 源码（该蓝图的 G2/G3）。更关键的是 **G4——core 公开面
尚未收敛**（仓库内实际深导入 61 个子路径），在它落地前对外承诺的插件 API 不可能稳定。因此
npm 分发不进第一期。

安装形态建议：用户在插件目录自行安装依赖，**宿主不代跑包管理器**——替用户跑 `npm install` 等于
执行任意 `postinstall` 脚本，那是一道比加载插件更大的门。

### 与 pi Extensions 的对照

| 维度 | pi Extensions | 本蓝图 |
| --- | --- | --- |
| 扩展能力 | 工具、命令、快捷键、事件、UI；可替换内置工具 | 工具、loop hook、受限命令、timeline renderer；内建 kind 锁定不可替换 |
| 宿主 | 单一 CLI | 桌面 + CLI（首期），一次声明多处生效；浏览器预览明确不支持 |
| UI 扩展 | 终端 UI | React timeline 卡片 + per-root registry |
| 观测 | 会话 JSONL，未见 trace 框架 | trace span/event + `plugin.id` 归因 |
| 自定义持久化记录 | 未见协议约束 | 有硬门槛（R5 的 envelope/配额/quarantine） |
| **生态规模** | 已有社区扩展包 | **零**。这是最大的差距，且不是设计能补的 |
| **简单性** | 一个 TS 模块即可 | manifest + 确认 + 能力申报，**明显更重** |
| 主题 / 快捷键 | 有（主题支持热重载） | 非目标 |

诚实结论：我们多的是"多宿主一次生效、timeline 卡片、trace 归因、持久化纪律"；少的是**生态与
轻量**。对早期使用者，后两者往往更值钱。所以本蓝图的成败标准不是扩展点数量，而是
**第一个第三方插件能不能在 20 分钟内写完并跑起来**——manifest 与确认流程的每一项复杂度都要按
这条标准复核。

## 7. 与 R5 RFC 的关系

[自定义持久化 Timeline Item RFC](persistent-plugin-timeline-item-rfc.md) 尚未批准，因此：

- 第三方插件**不能**持久化自定义 timeline item。manifest 允许申报 `timeline.persist`，宿主在
  R5 落地前**一律拒绝授予**并列为诊断项，不提供任何"临时通道"。
- 不得用变通绕过：插件通过工具写 workspace 文件仍受 confinement 约束，但那不是 timeline item，
  也不进 checkpoint/archive，不能当作替代方案对外宣传。
- 本蓝图**复用**但不修改 R5 的身份规则（`plugin.id` 正则与禁用前缀）。R5 获批后，第 4.2 节的
  L2 层才有实际内容；在此之前 L2 是一个明确关闭的占位。

## 8. 非目标（第一期不做）

| 非目标 | 理由 |
| --- | --- |
| 热重载 | 需要在不中断 run 的前提下替换 hook 集合，且 ESM 模块缓存不可撤销。收益是开发者便利，成本是运行时不确定性——开发者重启即可。 |
| worker/iframe 沙箱隔离 | 真做要把 PluginApi 全面消息化（结构化克隆 + 全异步 hook），会推翻已交付的同步 hook 契约。第一期用"确认 + 归因"替代，并在文档与 UI 里明说这不是隔离。 |
| 主题扩展 | 本项目 UI 是 React 应用而非终端；主题属于设计系统层，不该借插件 API 进入 Core。 |
| 快捷键扩展 | 属于宿主输入层，三宿主键位语义不一致，先做只会固化一个错误抽象。 |
| 插件市场 / 目录索引 | 没有生态之前造市场是空转。 |
| 插件间依赖与显式加载顺序 | 第一期按 id 字典序确定性加载；引入依赖图会立刻带来版本求解问题。 |
| 解锁内建 timeline renderer 替换 | R2/R3 已锁定六个内建 kind，本期不解锁，避免第三方改写核心记录的展示。 |
| 插件注册 CallTiming 自定义时机域 | 九个核心时机由宿主分派，第三方新增时机需要先有稳定的域命名与预算约束。 |

## 9. 开放决策（需用户拍板，蓝图不代为决定）

1. **默认信任姿态**：扫描到的插件默认停用（逐个确认）／默认启用但首次加载前确认／目录存在即
   信任。本蓝图倾向"默认停用"，但不替你决定。
2. **首期支持宿主**：仅桌面／桌面 + CLI（本蓝图倾向）／三宿主都要（浏览器需另造读盘通道，
   本蓝图明确反对）。
3. **插件能否注册模型可见工具**：全部可见／需在确认卡片单独勾选／首期一律不可见（只允许 hook
   与 renderer）。这条直接决定第三方代码能否进入模型上下文与工具执行路径。
4. **运行期熔断**：连续失败几次自动停用？是否允许自动恢复，还是必须用户手动重新启用？
5. **npm 分发时机**：是否必须等 G4（core 公开面收敛）完成；在此之前是否接受"仅本地目录 +
   不承诺 API 稳定"的 alpha 形态。
6. **`.webAgent/plugins/` 是否随 workspace 进 Git**：团队共享插件 = 团队共享任意代码执行。若
   允许，确认记录应按用户而非按 workspace 保存，否则一次 `git pull` 就能带进已被"确认过"的代码。

以上任一项未拍板前，P2+ 实现卡不应开工。
