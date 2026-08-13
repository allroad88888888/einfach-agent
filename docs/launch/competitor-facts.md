# 竞品事实收集：pi / OpenCode / Cline / Cherry Studio

本文档只记录联网检索到的**事实**，不做与本项目的对比评价（对比评价见 D2）。每条事实附来源
链接；查不到公开资料的维度明确标注，不编造。

## pi（pi-coding-agent / pi-mono）

作者 Mario Zechner（GitHub：badlogic，libGDX 作者）。2026 年 4 月项目随作者加入 Armin Ronacher
联合创立的 Earendil 公司，仓库从 `badlogic/pi-mono` 迁移到 `earendil-works/pi`，核心保持 MIT
协议。npm 周下载量从 2025 年 12 月约 4,000 涨到 2026 年 1 月底约 130 万，主要由 OpenClaw 采用
pi 作为核心运行时驱动。
([explainx.ai](https://www.explainx.ai/blog/pi-minimal-agent-harness-mario-zechner-guide-2026)、
[ai.plainenglish.io](https://ai.plainenglish.io/pi-agent-the-418-line-agent-loop-that-outperforms-thousand-line-frameworks-4e89b35692be))

### 架构形态

pi 提供四种运行模式：交互模式（默认终端 TUI）、print/JSON 模式（`-p`/`--mode json` 输出后退出）、
RPC 模式（`--mode rpc`，基于 stdin/stdout 的 JSONL 与外部进程通信）、SDK 模式（作为库嵌入自定义
应用，暴露 `createAgentSession()` 等 API）。原文："Pi runs in four modes: interactive, print or
JSON, RPC for process integration, and an SDK for embedding in your own apps."设计哲学强调极简，
默认只给模型 4 个工具（read/write/edit/bash），系统提示词长度在同类 agent 中最短。
([github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)、
[explainx.ai](https://www.explainx.ai/blog/pi-minimal-agent-harness-mario-zechner-guide-2026))

### 扩展机制

不内置 MCP：原文 "No MCP. Build CLI tools with READMEs (see Skills), or build an extension that
adds MCP support."提供四层扩展：Extensions（TypeScript 模块，可注册自定义工具、命令、快捷键、
事件处理、UI，能力上可替换内置工具、添加子 agent、自定义压缩逻辑、权限网关、Git checkpoint、
SSH/沙箱执行）；Skills（遵循 Agent Skills 标准的 Markdown 文档，`/skill:name` 调用）；Prompt
Templates（可复用 Markdown 提示，`/name` 展开）；Themes（支持热重载的自定义主题）。
([github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md))

### 模型支持

官方 provider 列表含 30+ 家，包括 Anthropic、OpenAI、Azure OpenAI、Google Gemini、Google
Vertex、Amazon Bedrock、Mistral、Groq、xAI、NVIDIA NIM、OpenRouter 等；国产/非英语系模型明确列出
DeepSeek、Kimi For Coding（月之暗面）、MiniMax、Xiaomi MiMo（小米，含中国/阿姆斯特丹/新加坡三个
区域端点）、Ant Ling（蚂蚁集团）。另有社区扩展包 `pi-provider-kimi-code`，可复用 Kimi Code
（Moonshot）编码套餐接入。未在官方文档中查到专门的智谱 GLM provider 页面。
([github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)、
[github.com/Leechael/pi-provider-kimi-code](https://github.com/Leechael/pi-provider-kimi-code))

### 子 Agent 与观测

不内置子 agent：原文 "No sub-agents. There's many ways to do this. Spawn pi instances via tmux,
or build your own with extensions, or install a package."（存在社区包 `pi-subagent`）。会话以
JSONL 树形结构存储，每条记录含 `id` 与 `parentId`，支持原地分支；`/tree` 命令可视化导航会话树，
`/fork`/`/clone` 可从任意点分支或克隆会话，`--session <path|id>` 可恢复指定会话。会话内完整记录
工具调用与结果，可导出 JSON 或生成 HTML 分享，但未查到专门的 observability/trace 框架或跨会话
分析能力。
([github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)、
[pi.dev/packages/@bacnh85/pi-subagent](https://pi.dev/packages/@bacnh85/pi-subagent))

## OpenCode（sst/opencode）

### 架构形态

Client-server 架构：后端 server（Bun 运行时 + Hono 框架）负责 LLM 推理、工具执行、会话持久化与
MCP server 管理；多种前端客户端（终端 TUI、桌面应用、Web、IDE 扩展）通过 HTTP + SSE 连接后端。
项目是 TypeScript monorepo，用 Turbo 管理构建，用 Vercel AI SDK 做 provider 统一抽象，会话持久化
用 SQLite（Drizzle ORM）。
([opencode.ai/docs](https://opencode.ai/docs/)、[deepwiki.com/sst/opencode](https://deepwiki.com/sst/opencode))

### 扩展机制

官方文档分列插件系统（Plugins）、MCP servers、自定义工具（Custom Tools）、LSP 集成四类扩展入口。
Provider-agnostic：可自带 API key、跑本地模型（如 Ollama），或订阅官方托管服务 OpenCode Zen /
OpenCode Go。
([opencode.ai/docs](https://opencode.ai/docs/))

### 模型支持

官方称支持 75+ 家 provider（经 Vercel AI SDK 抽象）。文档中确认有独立配置页的国产模型 provider：
DeepSeek（DeepSeek console 创建 API key 接入，可选 DeepSeek V4 Pro 等模型）、Moonshot AI/Kimi
（Moonshot AI console 接入，可选 Kimi K2 模型）、Z.AI/智谱 GLM（Z.AI API console 接入，支持
GLM-4.7 模型及 GLM Coding Plan 订阅）。另可通过 OpenRouter、Together AI、Deep Infra 等聚合平台
间接访问更多国产模型（如 Kimi K2 Instruct）。OpenCode Go 付费订阅（$10/月）打包 16 个模型，含
Grok 4.5、Kimi K3、GLM-5.2 等。
([opencode.ai/docs/providers/](https://opencode.ai/docs/providers/)、
[explainx 相关检索结果整理](https://www.explainx.ai/blog/pi-minimal-agent-harness-mario-zechner-guide-2026))

### 子 Agent 与观测

子 agent 通过 JSON 或 Markdown 配置文件定义，放在 `~/.config/opencode/agents/`（全局）或
`.opencode/agents/`（项目级），需标记 `mode: subagent`。调用方式两种：主 agent 依据子 agent
描述自动选择调用；或用户通过 `@` 提及语法手动调用（如 `@general help me search for this
function`）。子 agent 会创建子会话，支持 `session_child_first`/`session_child_cycle`（默认
右键）/`session_parent`（默认上键）等命令在父子会话间导航。官方文档未提及内置 trace/
observability/回放能力；OpenTelemetry 集成仅通过第三方社区插件
`@devtheops/opencode-plugin-otel` 提供（需手动配置 `OPENCODE_ENABLE_TELEMETRY`、
`OPENCODE_OTLP_ENDPOINT` 等环境变量对接 SigNoz 等平台），非官方内置功能。
([opencode.ai/docs/agents/](https://opencode.ai/docs/agents/)、
[signoz.io/docs/opencode-observability](https://signoz.io/docs/opencode-observability/))

## Cline（cline/cline）

### 架构形态

起步于 VS Code 侧边栏扩展，到 2026 年已覆盖 VS Code、Cursor、Windsurf、JetBrains（IntelliJ/
PyCharm/WebStorm）、Antigravity、Zed、Neovim，另有独立 CLI 与名为 Kanban 的 Web 任务看板（可
"Run many agents in parallel with dependency chains"）。2026 年 Cline 发布了开源的 "Cline SDK"
agent 运行时，IDE 扩展、CLI、Kanban 三者统一构建在这套共享运行时之上。
([docs.cline.bot](https://docs.cline.bot/)、
[cline.bot/blog/introducing-cline-sdk-the-upgraded-agent-runtime](https://cline.bot/blog/introducing-cline-sdk-the-upgraded-agent-runtime))

### 扩展机制

原生支持 MCP（"one of the first coding tools to support MCP natively"），可扩展外部 API/服务与
自定义工具。配置方式：手动编辑 `~/.cline/mcp.json`（CLI）或 IDE 内 UI；也可用 `cline mcp` 命令
交互式配置向导。传输支持本地 STDIO（进程内、低延迟）和远程传输——Streamable HTTP（推荐）与 SSE
（仅遗留场景）。支持按 server 启用/禁用、`autoApprove` 自动批准控制。未在检索到的文档页面中发现
官方 MCP marketplace 的明确描述。
([docs.cline.bot/mcp/mcp-overview](https://docs.cline.bot/mcp/mcp-overview))

### 模型支持

三条接入路径：Cline 官方 usage-billing（免配置 API key）、ClinePass 订阅（$9.99/月，打包 11 个
精选开源权重编码模型，含 GLM-5.2、Kimi K2.7 Code、Kimi K3、DeepSeek V4，2–5 倍标准 API 速率
限制）、自带 API key（BYOK）。BYOK 下有独立配置页的国产模型 provider 确认包括：DeepSeek、
Moonshot（Kimi 模型家族）、Z AI/智谱 AI（GLM-4.5、GLM-4.5 Air，具备混合推理与 agentic 能力）、
豆包 Doubao（字节跳动/火山引擎）、Qwen Code（阿里通义千问，编码定向接入）、Huawei Cloud MaaS，
以及 Groq、Fireworks AI、Together、SambaNova 等其他 30+ provider，并支持通用 OpenAI-compatible
自定义 base_url 接入。
([docs.cline.bot/provider-config/deepseek](https://docs.cline.bot/provider-config/deepseek)、
[docs.cline.bot/provider-config/zai](https://docs.cline.bot/provider-config/zai)、
[docs.cline.bot/provider-config/other-30-plus-providers](https://docs.cline.bot/provider-config/other-30-plus-providers))

### 子 Agent 与观测

**Checkpoint**：基于与项目实际 Git 历史分离的隐藏 shadow Git 仓库，每次工具调用（文件编辑、命令
执行等）后自动提交当前文件状态，可捕获 Git 未跟踪的文件；提供三种恢复方式——仅恢复文件
（Restore Files）、仅恢复任务/对话（Restore Task Only）、同时恢复文件与任务（Restore Files &
Task）。**Subagents**（实验性功能，标注 "Behavior may change in future releases"，覆盖 VS
Code/JetBrains/CLI 三平台）：通过 `use_subagents` 工具并行启动多个独立 agent，每个拥有独立
prompt、独立上下文窗口与 token 预算，可用工具限于只读探索——`read_file`/`list_files`/
`search_files`/`list_code_definition_names`/只读 `execute_command`（如 `ls`/`grep`/`git
log`）/`use_skill`；明确**不能**编辑文件、用浏览器、访问 MCP server 或生成嵌套子 agent；结果
汇总为"最相关文件路径"供主 agent 阅读，成本按子 agent 分别计量后汇总进任务总成本。企业方案页面
另提及 Observability（OpenTelemetry、Datadog 等集成），但检索到的文档未详细说明其与
checkpoint/subagent 功能的具体关联。
([docs.cline.bot/features/checkpoints](https://docs.cline.bot/features/checkpoints)、
[docs.cline.bot/features/subagents](https://docs.cline.bot/features/subagents))

## Cherry Studio（CherryHQ/cherry-studio）

### 架构形态

跨 Windows/macOS/Linux 的桌面客户端（仓库含 `electron.vite.config.ts`/`electron-builder.yml`，
基于 Electron）。定位为"全能 AI 工作站"：融合多模型对话、智能体（Agent）、知识库管理、AI 绘图、
翻译、频道分发（面向微信/Telegram 等 IM 平台的 agent 部署）、定时任务、小程序等能力，而非单一
聊天客户端。GitHub 43K+ star，官方称全网下载量超千万，Apache 2.0 协议开源。
([github.com/CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)、
[docs.cherryai.com.cn/docs/en-us](https://docs.cherryai.com.cn/docs/en-us))

### 扩展机制

原生支持 Anthropic MCP 协议，浏览器、文件系统、数据库、Notion、GitHub、SQL、Shell 等数百种工具
可一键接入；智能体（Agent）与部分助手（Assistant）均可挂载 MCP。另有"技能（Skill）"概念——加装在
助手/智能体身上的专业能力包（如"会做 PPT"），开箱即用。支持自定义助手创建（内置 300+ 预设助手）
与可视化工作流构建器（拖放节点：LLM 调用、软件、逻辑判断、API 请求）；但据社区技术文章，当前
"是纯提示词驱动的 agent……低代码 workflow 编排目前不太支持"。路线图中提及 MCP Marketplace，
未确认是否已正式上线。
([docs.cherryai.com.cn/advanced-basic/concepts-101](https://docs.cherry-ai.com/advanced-basic/concepts-101)、
[github.com/CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)、
[oschina.net](https://www.oschina.net/news/339590/cherry-studio-1-1-5-mcp))

### 模型支持

官方 Provider 快速参考页确认支持的国产模型/厂商：DeepSeek、智谱 GLM（ZhiPu，含 GLM-4.6V、
GLM-4.5-Air 等，标注"多模态，兼容 Anthropic 可跑智能体"）、Moonshot AI/Kimi（标注"超长上下文，
最长 200 万字"）、豆包 Doubao（字节跳动/火山引擎）、百度文心一言（Baidu Cloud/ERNIE 系列）、
阿里百炼 Bailian（Qwen 系列）、百川 Baichuan AI、MiniMax（多模态：语音、视频）；此外可经硅基流动
（SiliconFlow）、魔搭 ModelScope 等聚合平台接入更多国产开源模型，并支持通过 Ollama 本地私有部署。
([docs.cherryai.com.cn/pre-basic/providers/quick-reference](https://docs.cherryai.com.cn/pre-basic/providers/quick-reference))

### 子 Agent 与观测

智能体（Agent）功能官方描述为"进阶版同事"，具备"拆解目标、派子智能体、跑后台命令"的多步骤任务
执行能力，明确存在子智能体派驻机制。执行过程可视化：右侧面板可查看状态/文件/子任务/消息流；
开发者模式下可查看"调用链"。权限模式可从"逐次确认"调节到"完全访问"。未查到官方文档提及跨会话
持久化的 trace 存储、结构化 span 数据、回放（replay）机制，或与 OpenTelemetry 等第三方
observability 平台的集成——这类更深度的可观测能力**未查到公开资料**。
([docs.cherryai.com.cn/cherry-studio/preview/agent](https://docs.cherryai.com.cn/cherry-studio/preview/agent))

---

检索时间：2026-08-13

## 主要来源清单

- pi：
  [github.com/badlogic/pi-mono（coding-agent README）](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)、
  [npmjs.com/package/@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)、
  [explainx.ai 博客](https://www.explainx.ai/blog/pi-minimal-agent-harness-mario-zechner-guide-2026)、
  [ai.plainenglish.io 博客](https://ai.plainenglish.io/pi-agent-the-418-line-agent-loop-that-outperforms-thousand-line-frameworks-4e89b35692be)、
  [pi.dev subagent 包页面](https://pi.dev/packages/@bacnh85/pi-subagent)、
  [github.com/Leechael/pi-provider-kimi-code](https://github.com/Leechael/pi-provider-kimi-code)
- OpenCode：
  [opencode.ai/docs](https://opencode.ai/docs/)、
  [opencode.ai/docs/providers](https://opencode.ai/docs/providers/)、
  [opencode.ai/docs/agents](https://opencode.ai/docs/agents/)、
  [deepwiki.com/sst/opencode](https://deepwiki.com/sst/opencode)、
  [signoz.io/docs/opencode-observability](https://signoz.io/docs/opencode-observability/)
- Cline：
  [docs.cline.bot](https://docs.cline.bot/)、
  [docs.cline.bot/mcp/mcp-overview](https://docs.cline.bot/mcp/mcp-overview)、
  [docs.cline.bot/features/checkpoints](https://docs.cline.bot/features/checkpoints)、
  [docs.cline.bot/features/subagents](https://docs.cline.bot/features/subagents)、
  [docs.cline.bot/provider-config/deepseek](https://docs.cline.bot/provider-config/deepseek)、
  [docs.cline.bot/provider-config/zai](https://docs.cline.bot/provider-config/zai)、
  [docs.cline.bot/provider-config/other-30-plus-providers](https://docs.cline.bot/provider-config/other-30-plus-providers)、
  [cline.bot/blog/introducing-cline-sdk-the-upgraded-agent-runtime](https://cline.bot/blog/introducing-cline-sdk-the-upgraded-agent-runtime)
- Cherry Studio：
  [github.com/CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)、
  [docs.cherry-ai.com/advanced-basic/concepts-101](https://docs.cherry-ai.com/advanced-basic/concepts-101)、
  [docs.cherryai.com.cn/docs/en-us](https://docs.cherryai.com.cn/docs/en-us)、
  [docs.cherryai.com.cn/pre-basic/providers/quick-reference](https://docs.cherryai.com.cn/pre-basic/providers/quick-reference)、
  [docs.cherryai.com.cn/cherry-studio/preview/agent](https://docs.cherryai.com.cn/cherry-studio/preview/agent)、
  [oschina.net 报道](https://www.oschina.net/news/339590/cherry-studio-1-1-5-mcp)
