# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本文件是仓库内编码 Agent 的快速工作约定。项目现状和启动方法以 `README.md` 为准，
专题设计入口见 `docs/README.md`。

## 命令

这是 pnpm workspace，`packages/*` 和 `tools/*` 使用 `workspace:*`。不要使用 `npm install`。

- `pnpm install`：安装并链接全部 workspace 包。
- `pnpm dev`：启动 Vite Web 预览。
- `pnpm build`：`tsc -b` 后构建 Vite。仓库没有 lint 脚本，这是唯一的静态门禁。
- `pnpm test` / `pnpm test:watch`：Vitest。
- `pnpm exec vitest run <file>`：单文件；`pnpm exec vitest run -t "<name>"`：按用例名过滤。
- `node scripts/check-docs.js`：Markdown 门禁——相对链接必须真实存在，且禁止引用迁移前的旧源码
  路径（规则见脚本里的 `legacySourcePathPattern`，连在文档里写出那个字面量都会失败）。
  改任何 `.md` 都要跑，CI 里它排在测试之前。
- `pnpm cli -p "<prompt>"`：headless CLI 宿主跑一轮真实 run（读 `~/.webAgent/config.json`
  或环境变量取模型 Key；`--help` 看全部选项）；无 `-p` 进入 REPL。
- `pnpm tauri dev` / `pnpm tauri build`：桌面端开发与打包。
- `cargo test --manifest-path apps/desktop/Cargo.toml`：Rust 桥测试。
- 子 Agent 治理：`pnpm subagent:replay` / `subagent:capacity` / `subagent:archive:retention` /
  `subagent:index:compact` / `subagent:skills`。

CI（`.github/workflows/ci.yml`）跑两条：`check-docs → check-boundaries → pnpm test → pnpm build`，
以及三平台的 `cargo test` + `pnpm tauri build --no-bundle --ci`。

## 构建与解析模型

workspace 包**不单独编译**：`vite.config.ts` 的 `resolve.alias` 与 `tsconfig.app.json` 的
`paths` 都把 `@web-agent/*` 直接指到各包的 `src`。改包无需 build，但新增/改名包时这两处
alias 必须同步添加，否则类型或运行时会各错各的。`tsconfig.app.json` 的 `include` 覆盖
`apps/web/src`、`packages/*/src`、`tools/*/src`。

Vitest 的 root 是仓库根（不是 Vite 的 `apps/web` root），jsdom + `apps/web/src/test/setup.ts`，
`isolate: true`：每个测试文件独立 worker，setup 在 worker 内注册标准工具，并只在用例之间重置
`defaultCore` 的 root/session store。测试文件是并行的，以 `vite.config.ts` 为准
（`README.md` 里"测试按串行模式运行"的说法已过时）。组件测试用
`apps/web/src/test/renderWithStore.tsx` 的隔离 store；IndexedDB 测试用 `fake-indexeddb`。

## 模型凭证与传输

`apps/web/src/main.tsx` 只注入桌面受管凭证标记和受限模型传输。真实 Key 仅由桌面原生层从
`~/.webAgent/config.json` 读取。默认新文件不存在时，原生层才安全复制旧
`~/.web-agent/config.json`；新文件优先且旧文件保留。`WEB_AGENT_CONFIG_DIR` 只能选择配置目录，
不能传入或读取模型 Key；设置覆盖目录时不触发迁移。

三种宿主的传输各不相同：Tauri 走原生代理，浏览器 dev 走 `scripts/model-preview-relay` 的本地
Node 中继，静态产物直接拒绝模型请求。`scripts/public-model-credential-guard.ts` 在 Vite 配置
阶段执行——任何 `VITE_*_API_KEY` 都会让 dev/build 直接失败，别试图用 `VITE_` 变量传密钥。

Kimi 的上传、`ms://` 引用编码和清理语义属于 `agent-ai` adapter，Tauri 只保持 provider-neutral
受限传输。

## 当前结构

- `apps/web/src/main.tsx`：默认应用装配；注册标准工具、配置模型传输、选择持久化和观测 driver。
- `apps/web/src/agentNew/ui/`：React UI，包含会话、消息、计划、确认、子 Agent 树和输入区。
- `apps/web/src/mcp/`：MCP 应用层（配置、持久化、连接编排、工具清单缓存、stdio 起进程确认、
  Tauri stdio connector）。**在 `main.tsx` 里随应用启动装配**，不是等设置弹窗打开才装——
  否则 `autoConnect` 形同虚设。详见 [docs/mcp-integration.md](docs/mcp-integration.md)。
- `apps/desktop/`：Rust/Tauri 的 shell、workspace、Git、dialog、SQLite 与 MCP stdio 实现。
- `packages/agent-ai/`：DeepSeek/GLM/Kimi 请求、流式响应、provider 私有图片准备、adapter 重试
  和 vendor 能力描述表。
- `packages/agent-core/`：装配式 Agent Runtime 内核：工具契约/registry、loop、插件、观测与持久化
  contract、checkpoint 与 atoms；不含具体工具域或宿主 driver。
- `packages/agent-react/`（`@web-agent/react-plugin`）：React 侧插件安装面与 timeline renderer
  registry；core 不依赖 React。
- `packages/agent-plugin-example/`：插件契约的可运行样例，改插件 API 时同步更新。
- `packages/subagents/`：委派调度、批次编排、归档治理与子 Agent 视图 state。
- `packages/persistence-{idb,sqlite}/`：IndexedDB / SQLite 会话与历史持久化 driver。
- `packages/observability-{idb,sqlite}/`：IndexedDB / SQLite trace driver 与 reader。
- `apps/web/src/traceViewer/`：React TraceViewer 与其 view state。
- `tools/{shell,fs,interaction,planning,skills,agents}/`：六个标准工具域；skills 的 loader、registry
  和内置内容在 `tools/skills`，默认 plan runtime 在 `tools/planning`。
- `tools/standard/`（`@web-agent/tools`）：meta 聚合包，`registerStandardTools` 一次装齐六域。
- `tools/mcp/`：第七个域，**不在**标准包里，由应用层按需装配。
- `docs/`：当前说明与演进蓝图，入口是 `docs/README.md`。

依赖必须维持：

```text
agent-ai ← agent-core ← {tools-*、能力包} ← app
```

`agent-core` 不得反向依赖任何具体 `tools-*` 包，也不依赖 React。

`agent-core/src` 的分区：`runtime/`（主循环、命令与到点分派）、`runtime/core/`（`CoreInstance`、
plugin host、loop hooks、默认插件）、`state/`（atom、writer、persistence contract）、`execution/`
（执行图）、`planning/` 与 `skills/`（契约）、`subagents/`（子 run 机制与委派协议）、`timeline/`、
`observability/`（port 与纯逻辑）、`tools/`（抽象与 registry，不含具体工具）。

## 状态与 UI 边界

默认运行时使用一个 `defaultCore`。每个 `CoreInstance` 私有持有 root/session store、工具与
abort registry、运行时配置、plugin host、观测 port 与 persistence bridge；`createCore()` 创建隔离
实例。`projectSkillsProvider`、`planRuntime`、`delegation` 与观测 port 由装配层按槽注入，持久化
driver 由宿主配置 bridge。默认实例本身不自动安装工具，应用和测试入口负责调用
`registerStandardTools`。

- root store 只放跨会话状态：会话元数据与当前会话 ID。
- 每个 session 有独立 Einfach store，保存 items、run、checkpoint、plan 和瞬态 UI 状态。
- UI 只允许读取 atom、调用 `runtime/commands.ts` 暴露的命令。
- UI 不直接调用 writer、不 setter 业务 atom、不持有 runtime store。
- writer 和 await 后回写必须保留 ghost guard、runId stale guard 与 AbortSignal 检查。
- checkpoint 保存 items 的不可变快照，不能用原地修改破坏历史。

## 运行链路

`sendMessage` 创建 run，经 `modelRun.ts` 的稳定入口进入 `runToolLoop.ts` 主循环：

1. 写入用户消息与 running 状态。
2. 组装 system prompt、上下文、工具摘要和 `request_tool_schema`。
3. 模型按需请求完整工具 schema。
4. `callTiming` 非空的工具由 `timedDispatch.ts` 在相应点位执行并投影为 timeline item；九个核心
   时机为 session/run/turn、压缩和子 Agent 的开始/结束，`<domain>:<event>` 由宿主经受限 API 分派。
5. 模型可见工具经 registry 校验后，通过受限 `ToolContext` 执行；普通结果回填并继续循环，ask-user、
   计划审批或危险工具确认会暂停。
6. 完成后提交 checkpoint，并通过 persistence bridge 落盘。

供应商私有请求和重试留在 `packages/agent-ai/`；子 Agent 已按单体循环、批次编排和辅助职责拆分。
主循环已按 lifecycle、bootstrap、循环周期、checkpoint、模型请求和工具执行拆分；`modelRun.ts`
只保留稳定导出，`runToolLoop.ts` 负责循环编排。

压缩、finish reason、loop guard、迁移这些横切行为是 `runtime/core/plugins/` 里的**插件**，
不是主循环里的分支。要改这类行为先看能不能落在插件 hook 上。

工具不得直接 import store/atom 来获得额外能力。文件、shell、计划、渲染、委派等副作用必须使用
`ToolContext` 暴露的能力，确保 workspace confinement、权限确认、stale guard 和审计仍然生效。
完整工具契约见 `packages/agent-core/src/tools/TOOLS-SPEC.md`；标准工具的**实际清单以各域
registrar 为准**（`tools/<domain>/src/index.ts`），文档里的数量容易过时。

## 持久化与运行环境

- Web：会话/历史和 trace 使用 IndexedDB。
- Tauri：会话/历史和 trace 使用 SQLite，文件/shell/Git 通过 Rust command 执行。
- `server` 工具在非 Tauri 环境中不会暴露给模型。
- `.webAgent-archive/` 保存子 Agent 长期归档与索引，不应提交到 Git。
- workspace 里的 `.webAgent/skills/` 与 `.claude/skills/` 是项目 Skills 目录，会被 project skills
  loader 自动扫描进 L1 清单；它们不是用户配置目录。本仓库自己就有这两个目录，改它们等于改运行时
  行为，不只是改编辑器配置。

## 测试与修改约定

- TypeScript strict 开启；完成修改至少运行相关测试和 `pnpm build`。
- runtime/state 修改优先补充 colocated `*.test.ts(x)`。
- 模型 adapter 的"除 AbortError 外返回 fallback、不向 UI 抛出"是有意契约。
- 新工具放到对应 `tools/<domain>/src/<tool-name>/`，同目录包含实现、说明和测试，
  再由域包 registrar 注册；只加文件不注册 = 模型看不到。
- 用户可见的助手文案保持中文。
- `docs/` 里"当前实现说明"与"演进蓝图"是两类文档：蓝图描述目标形态，不代表 API 已交付，
  引用前必须核对实现和测试。已完成的阶段 PLAN 只保留在 Git 历史中。
- 追调用链、评估改动波及面时可用仓库自带的 CodeGraph 索引（`.codegraph/`，见 skill
  `codegraph`）；纯文本检索仍用 grep。
