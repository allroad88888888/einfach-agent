# Einfach Agent 与同类项目对比

## 口径声明

- **检索时间 2026-08-13**。竞品事实一律以 [`competitor-facts.md`](competitor-facts.md) 为准，
  本文不重新检索、不补充无来源的说法；该文档里标注"未查到公开资料"的维度，本文同样标注为未知，
  不用推测填空。
- **本表服务于"开发者框架"定位**，不是全功能评测。四家竞品中 pi/OpenCode/Cline 是编码 Agent，
  Cherry Studio 是面向终端用户的 AI 工作站——它们各自的产品完成度、UI 打磨、开箱体验都远超本项目，
  本表不比这些，只比"作为可被拼装、可被嵌入的 Agent Runtime"这一面。
- **本项目一侧的每条描述都逐条对着代码核过**，未开放的能力不写进强项。判定标准是"默认构建下用户
  能用到"：代码写完但门禁默认关闭的（如 Kimi），记在弱项而不是强项。

## 主对比表

| 维度 | Einfach Agent | pi | OpenCode | Cline | Cherry Studio |
| --- | --- | --- | --- | --- | --- |
| **架构形态** | pnpm workspace 分包、单向依赖；一个 core 装配出 Web / Tauri 桌面 / headless CLI 三宿主 | 单进程 CLI，四模式：交互 TUI、print/JSON、RPC（stdin/stdout JSONL）、SDK 嵌入 | client-server：Bun + Hono 后端，TUI / 桌面 / Web / IDE 前端经 HTTP + SSE 接入 | IDE 扩展起家，覆盖 VS Code/JetBrains/Zed/Neovim 等 + CLI + Kanban 看板，统一在开源 Cline SDK 运行时上 | Electron 桌面客户端，"全能 AI 工作站"（对话、知识库、绘图、翻译、定时任务） |
| **扩展机制** | 工具按域分包装配（shell/fs/interaction/planning/skills/agents 六域 + MCP 独立域）；plugin host + 生命周期 hook；项目内 Skills 目录自动扫描；MCP stdio/HTTP | 无内置 MCP（明写 "No MCP"）；Extensions（TS）/ Skills（MD）/ Prompt Templates / Themes 四层 | Plugins / MCP servers / Custom Tools / LSP 四类入口 | 原生 MCP（STDIO + Streamable HTTP + 遗留 SSE），按 server 启停与 `autoApprove` | 原生 MCP（数百种工具一键接入）+ Skill 能力包 + 300+ 预设助手 + 可视化工作流构建器 |
| **模型支持** | 自研 adapter 4 家：DeepSeek、GLM 默认开放，Kimi 门禁默认关闭；新增标准 OpenAI-compatible 协议基线（CLI 经环境变量接自定义 base_url，桌面 UI 暂未接入可选）；无聚合层 | 官方 30+ provider；含 DeepSeek、Kimi For Coding、MiniMax、小米 MiMo、蚂蚁 Ling；未查到官方 GLM 页 | 官方称 75+ provider（Vercel AI SDK 抽象）；DeepSeek / Moonshot / Z.AI GLM 各有独立配置页 | 官方计费 + ClinePass 订阅 + BYOK 30+；DeepSeek、Moonshot、Z.AI、豆包、Qwen、华为云等 | DeepSeek、智谱 GLM、Kimi、豆包、文心、百炼、百川、MiniMax + 硅基流动/ModelScope 聚合 + Ollama 本地 |
| **子 Agent** | 树形 delegation，逐路径预算（深度/子节点/并发/总节点/模型调用数），JSONL 归档 + 治理脚本 | 不内置（明写 "No sub-agents"）；会话 JSONL 树 + `/tree`、`/fork`、`/clone`；有社区包 pi-subagent | 配置文件定义（`mode: subagent`），自动选择或 `@` 手动调用，父子会话导航命令 | 实验性 `use_subagents` 并行只读探索：独立上下文与 token 预算，不能改文件/用浏览器/访问 MCP/嵌套；另有 shadow Git checkpoint | 智能体可"派子智能体"，右侧面板看状态/文件/子任务，开发者模式可看调用链 |
| **观测与回放** | 一等 trace：结构化 span（agent/llm/tool/internal）落 IndexedDB/SQLite，内置 TraceViewer；子 Agent 归档可脚本回放 | 会话内完整记录工具调用，可导出 JSON / 生成 HTML 分享；未查到 trace 框架或跨会话分析 | 官方文档未提内置 trace；OTel 仅第三方社区插件 `@devtheops/opencode-plugin-otel` | 企业方案页提 Observability（OTel、Datadog）；与 checkpoint/subagent 的关联未详述 | 开发者模式可看调用链；跨会话 trace 存储、结构化 span、回放**未查到公开资料** |
| **可嵌入性 / 装配自由度** | core 无主张：工具、存储、观测、技能、委派全部槽位注入，CI 强制依赖边界；但包全部 `private`，未发 npm，只能 clone 进 workspace | 官方 SDK 模式 + npm 包（周下载约 130 万）+ RPC 模式供外部进程集成 | server 可被任意客户端经 HTTP+SSE 接入；未见"作为库嵌入"的官方定位 | 2026 年开源 Cline SDK 作为共享 agent 运行时，官方三端（IDE/CLI/Kanban）复用同一套 | 面向终端用户的成品应用；未见作为库/运行时被第三方嵌入的公开路径 |

## 我们的差异位

### 1. 装配式内核：能力全部是槽位，边界由 CI 守

内核不硬编码任何工具、任何存储、任何观测后端。`createCore()` 把项目 Skills provider、plan
runtime、delegation 工厂都收成可选构造参数，宿主装配期注入；不注入就是没有，不是降级到某个默认
实现。

- 槽位定义：[`packages/agent-core/src/runtime/core/createCore.ts`](../../packages/agent-core/src/runtime/core/createCore.ts)、
  [`packages/agent-core/src/runtime/core/coreInstance.ts`](../../packages/agent-core/src/runtime/core/coreInstance.ts)
- 工具是外部包：[`tools/standard/src/index.ts`](../../tools/standard/src/index.ts) 只是六域的 meta
  聚合，想要精简工具集的嵌入方可以只 import 其中几个域包各自注册。
- 需要活运行时依赖的工具域怎么注入：[`tools/mcp/src/index.ts`](../../tools/mcp/src/index.ts)
  （`registerMcpTools(registry, dependencies)`，工具自身不 import 任何单例）。
- 插件而非分支：压缩、finish reason、loop guard、迁移都在
  [`packages/agent-core/src/runtime/core/plugins/`](../../packages/agent-core/src/runtime/core/plugins/)，
  可运行样例见 [`packages/agent-plugin-example/src/`](../../packages/agent-plugin-example/src/)。
- 边界是门禁不是口号：[`scripts/check-boundaries.js`](../../scripts/check-boundaries.js) 禁止 core
  反向 import React、工具域、能力包与 Tauri SQL 插件，在
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) 里排在 `pnpm test` 之前。

### 2. 一个 core，三个宿主，换的是 driver 不是实现

Web 预览、Tauri 桌面、headless CLI 跑同一个 runtime；差异全部落在装配层选哪个 driver，以及哪些
工具在当前宿主可见（如 `server` 工具在非 Tauri 环境不进模型可见清单）。

- 三个装配入口：[`apps/web/src/main.tsx`](../../apps/web/src/main.tsx)、
  [`apps/desktop/`](../../apps/desktop/)、[`apps/cli/src/main.ts`](../../apps/cli/src/main.ts)
- 同一组槽位换实现：持久化
  [`packages/persistence-idb/`](../../packages/persistence-idb/) ↔
  [`packages/persistence-sqlite/`](../../packages/persistence-sqlite/)，观测
  [`packages/observability-idb/`](../../packages/observability-idb/) ↔
  [`packages/observability-sqlite/`](../../packages/observability-sqlite/)。
- `main.tsx` 里 `registerStandardTools` / `configurePersistence` / `configureObservability` /
  `configureDefaultDelegation` 集中在启动文件——这就是"换宿主要改哪些行"的完整答案。

### 3. 子 Agent 治理面 + 国产模型协议细节的一等公民支持

四家竞品里，pi 不内置子 agent，OpenCode 有子 agent 但没内置 trace，Cline 的子 agent 是实验性只读
探索、observability 属企业方案，Cherry Studio 有子智能体和调用链视图但没查到跨会话 trace 与回放。
"树形 + 预算 + 归档 + 回放"这四件同时具备，在本表范围内是本项目独有的组合。

- 树形与逐路径预算：[`packages/subagents/src/delegationBatch.ts`](../../packages/subagents/src/delegationBatch.ts)
  （`maxDepth` / `maxChildren` / `maxConcurrent` / `maxTotalNodes` / `maxModelCalls`，子节点预算按
  路径收窄且不得超过父预算）
- 归档与回放：[`packages/subagents/src/archive/`](../../packages/subagents/src/archive/)（JSONL
  事件流写入 `.webAgent-archive/`）+ [`scripts/subagent-replay-report.js`](../../scripts/subagent-replay-report.js)
  + 容量/保留/索引压缩/技能治理四个 `pnpm subagent:*` 脚本
- 结构化 trace：[`packages/agent-core/src/observability/types.ts`](../../packages/agent-core/src/observability/types.ts)
  （`SpanKind = agent | llm | tool | internal`）→ 落盘 driver → 内置查看器
  [`apps/web/src/traceViewer/TraceViewer.tsx`](../../apps/web/src/traceViewer/TraceViewer.tsx)
- 子 Agent 视图：[`apps/web/src/agentNew/ui/SubagentTreePanel.tsx`](../../apps/web/src/agentNew/ui/SubagentTreePanel.tsx)、
  [`apps/web/src/agentNew/ui/SubagentRunTrace.tsx`](../../apps/web/src/agentNew/ui/SubagentRunTrace.tsx)
- 协议细节自己扛：[`packages/agent-ai/src/deepseek.ts`](../../packages/agent-ai/src/deepseek.ts) 处理
  "工具调用续轮必须完整回传 `reasoning_content`、缺失即 400"这类只有直连才会撞上的约束；
  [`packages/agent-ai/src/glm.ts`](../../packages/agent-ai/src/glm.ts) 的 thinking / `reasoning_effort`；
  [`packages/agent-ai/src/cacheUsage.ts`](../../packages/agent-ai/src/cacheUsage.ts) 归一
  `prompt_cache_hit/miss/write_tokens`；已验证差异逐条记在
  [`docs/model-adapter-compatibility.md`](../model-adapter-compatibility.md)。走聚合 SDK 的项目把这
  层交给上游抽象，我们是自己维护并写进兼容契约文档。

## 诚实的弱项

### 1. 生态与社区为零

仓库虽已 public（`github.com/allroad88888888/einfach-agent`），但 GitHub description 与 topics
至今为空，没有可对比的社区规模数据。对面是 Cherry Studio 43K+ star、pi 的 npm 周下载约 130 万、
Cline 覆盖 7 个以上编辑器平台。没有第三方插件市场，没有社区 provider 包（pi 有 `pi-provider-kimi-code`、
`pi-subagent` 这类社区补位），没有问答社区。遇到问题只能读源码，没有别人替你踩过坑。

### 2. 包没发布到 npm，无法作为库被引用

`packages/*` 与 `tools/*` 全部 `private: true`、版本停在 `0.1.0`，`exports` 直接指向未编译的
`src/*.ts`——这套解析依赖仓库自己的 Vite alias 与 tsconfig paths，离开本 workspace 不成立。想用
只能 clone 整个仓库并接受它的构建约定。pi 有官方 SDK 模式和 npm 包、Cline 开源了 Cline SDK，
这两条"被别人 import"的路本项目一条都还没通。发布路径仍是待办草案，见
[`npm-publish-plan.md`](npm-publish-plan.md)。

### 3. 模型支持面窄，且已交付的比代码里写的还少

自研 adapter 有 4 家，默认构建下真正能用的是 DeepSeek 与 GLM 两家。Kimi 的 adapter、上传协议、
区域路由代码都已写完，但整个入口挂在构建开关下：`VITE_KIMI_IMAGE_INPUT_ENABLED` 不为 `'true'` 时，
[`apps/web/src/agentNew/ui/ModelCredentialPanel.tsx`](../../apps/web/src/agentNew/ui/ModelCredentialPanel.tsx)
会把 Kimi 凭据卡与会话入口整体隐藏，[`apps/web/src/modelInput/kimiImageFeature.ts`](../../apps/web/src/modelInput/kimiImageFeature.ts)
把能力降级为 `unsupported`；[`docs/README.md`](../README.md) 记录其状态为 NO-GO。第四家
`openai-compat`（[`packages/agent-ai/src/openaiCompat.ts`](../../packages/agent-ai/src/openaiCompat.ts)）
已交付标准协议基线——baseUrl 必填、不做任何厂商私有净化——并在 CLI 侧接线完成：
`OPENAI_COMPAT_API_KEY` / `OPENAI_COMPAT_BASE_URL` 环境变量或 `~/.webAgent/config.json` 可以指向
任意自定义 base_url 的兼容端点（接线见
[`apps/cli/src/credentials.ts`](../../apps/cli/src/credentials.ts)）。但桌面凭据面板还没跟上——
`apps/desktop/src/model_credentials.rs` 的 `ModelProvider` 枚举只收录 deepseek/glm/kimi 三家，
openai-compat 在桌面 UI 里目前选不了，只能经 CLI 使用。同时仍没有 OpenAI / Anthropic / Gemini
品牌通路，本地模型（如 Ollama）也未经验证或产品化——即便理论上能经 openai-compat 的通用协议连接，
这条路目前没有测试覆盖，不计入已交付能力。对面 OpenCode 官方称 75+ provider、Cline BYOK 30+、
Cherry Studio 还能经聚合平台和本地部署再扩一层。

### 4. 文档与产品文案只有中文

`docs/` 全部中文，没有英文 README，也没有英文文档。项目约定要求用户可见的助手文案保持中文（见
[`CLAUDE.md`](../../CLAUDE.md)）。非中文使用者读不懂界面，非中文开发者读不懂设计文档，等于把绝大
部分潜在贡献者挡在门外。

### 5. 工程成熟度不足以支撑第三方依赖

仓库没有 lint 脚本，`tsc -b` 是唯一的静态门禁。没有 CHANGELOG，没有版本发布流程，没有语义化版本
承诺——`0.1.0` 之后接口怎么变、什么算 breaking，目前没有对外约定。`docs/` 里多份蓝图仍处于"部分
实施"状态，蓝图描述的是目标形态而非已交付 API，引用前必须逐条核对实现与测试。

## 该选谁

**适合选 Einfach Agent 的人：**

- 你要的是**能拆开改的运行时内核**，不是装上就用的成品：想换掉存储层、接自己的观测后端、只装三个
  工具域、把 loop 行为写成插件——这些在本项目是设计入口，不是 fork 后硬改。
- 你的目标形态是**同一套 Agent 逻辑同时上 Web、桌面和 CLI**，不想维护三份实现。
- 你主要用 **DeepSeek / GLM**，并且在意 provider 协议细节（`reasoning_content` 回传、缓存 usage
  归一、上下文窗口表）由项目自己维护并有兼容契约文档，而不是压在聚合 SDK 里。
- 你需要**多层子 Agent 的可控性与可审计性**：预算硬约束、归档落盘、事后回放、结构化 span。
- 你能接受读中文文档、clone 仓库开发、自己兜底踩坑。

**不该选的人：**

- 你要的是**今天就能用的编码助手**——装 Cline 或 pi，成熟度和生态不是一个量级。
- 你需要**广泛的模型选择**，或者要用 OpenAI / Anthropic / Gemini / 本地 Ollama——选 OpenCode 或
  Cherry Studio，本项目这些一个都没有。
- 你想 **`npm install` 一个 SDK** 嵌进自己的应用——现在做不到，用 pi 的 SDK 模式或 Cline SDK。
- 你要**面向终端用户的完整产品体验**（知识库、绘图、翻译、IM 分发）——那是 Cherry Studio 的领域。
- 你的团队**读不了中文文档**，或者需要一个有社区、有稳定发布节奏、有版本承诺的依赖。
