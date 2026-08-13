# Einfach Agent

**装配式 Agent Runtime 开发者框架。** 一个可插拔内核——工具契约、插件、观测、持久化、
子 Agent 委派全部按槽位注入——驱动 Web 预览、Tauri 桌面端、headless CLI 三个宿主；
DeepSeek / GLM 等模型是一等公民，而不是事后适配。

> einfach 是德语的"简单"：内核只管该管的，其余全部换得掉。

![CLI 宿主一次真实 run](docs/launch/assets/cli-demo.gif)

## Quickstart

前置条件：Node.js **≥ 20.19 或 ≥ 22.12**；包管理器固定用 **pnpm**（仓库靠 `workspace:*`
互链，`npm install` 会装出错误的依赖树）。桌面端另需 Rust stable ≥ 1.77.2，见[环境要求](#环境要求)。

```bash
# 1. 拉取仓库
git clone https://github.com/allroad88888888/einfach-agent.git && cd einfach-agent

# 2. 安装并链接全部 workspace 包
pnpm install

# 3. 配置模型 Key：写入 ~/.webAgent/config.json，或在桌面设置页填写（见「配置模型」）

# 4. 起一个宿主
pnpm dev            # 浏览器预览
pnpm tauri dev      # Tauri 桌面端（完整能力）

# 5. 或者一条命令跑一次真实 run（headless；CLI 宿主无本机文件工具，示例用内置 skills）
pnpm cli -p "搜索并读取 planning skill，用三句话总结这个项目的计划机制"
```

## 能力边界

- **Tauri 桌面端**：完整产品形态，可使用 shell、workspace 文件、ripgrep、任务执行、补丁和 Git diff。
- **Web 预览**：复用同一套 React UI 和 Agent Runtime；无法使用 Tauri 的 `server` 工具，
  这些工具会从模型可见清单中自动隐藏。
- **headless CLI**：无 UI 驱动真实 run，用于 dogfood、自动化和编码 Agent 自测；`-v` 把 trace
  与性能诊断打到 stderr。
- **模型接入**：当前支持 DeepSeek 与 GLM；Kimi `kimi-k2.6` 与图片输入已实现，但真实 Key 验收前保持开放门禁关闭。
- **运行时能力**：多会话、checkpoint/revert、lazy tool schema、危险工具确认、结构化计划与评估、
  树形子 Agent、后台执行图、上下文压缩与 provider context cache 统计、持久化和 trace viewer。

## 装配式内核

`packages/agent-core` 只提供机制，不提供实现。`createCore()` 造出的每个实例私有持有
store、工具 registry、abort registry、插件宿主和观测出口，能在同一进程里跑两份互不干扰：

| 槽位 | 注入什么 |
| --- | --- |
| `registerTools` | 工具集。不传则该实例**没有任何工具**；应用侧调 `registerStandardTools` 装齐六域 |
| `plugins` | 循环插件。压缩、finish reason、loop guard、迁移都是插件，不是主循环里的 if |
| `observability` | trace 出口（IndexedDB / SQLite / stderr / 静默） |
| `projectSkillsProvider`、`skillRegistry` | 项目 Skills 扫描与内置 skill 清单 |
| `planRuntime` | 结构化计划运行时 |
| `delegation` | 子 Agent 委派运行时；不注入就没有子 Agent |
| `config` | apiKey、vendor 等运行时配置 |

会话/历史持久化不走构造参数，由宿主通过 persistence bridge 配置 driver。

依赖方向单向，且**不靠自觉**：

```text
packages/agent-ai ← packages/agent-core ← {tools-*、能力包} ← app
```

`node scripts/check-boundaries.js` 在 CI 里排在测试之前，静态扫描 import 语句，一旦 core 引入
React、任何 `@web-agent/tools-*` 或持久化/观测/子 Agent 能力包就直接失败。

## 一个内核，三个宿主

同一个内核，三处装配入口各自选实现：

- **Web 预览** —— `apps/web/src/main.tsx`：标准工具 + IndexedDB 持久化/trace + React UI + MCP 应用层。
- **Tauri 桌面端** —— 复用同一份 Web 装配，由 `apps/desktop/` 的 Rust 桥换上 SQLite 持久化、
  真实 shell/文件/Git 和原生模型代理。
- **headless CLI** —— `apps/cli/src/runtime.ts`：同一套标准工具，内存 history driver、
  stderr trace，无 React。

![桌面端计划审批](docs/launch/assets/plan-approval.png)

## 环境要求

- Node.js ≥ 20.19，或 ≥ 22.12
- pnpm（仓库使用 `workspace:*`，不要使用 npm 安装依赖）
- 构建 Tauri 时还需要 Rust stable ≥ 1.77.2 和对应平台的系统依赖

Tauri 平台依赖：

- macOS：Xcode Command Line Tools
- Windows：Microsoft C++ Build Tools 和 WebView2 Runtime
- Linux：Tauri 2 所需的 WebKitGTK、编译工具链及系统库

详见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

## 配置模型

`.env.example` 中的密钥变量仅供本机 Web 开发中继使用；桌面应用不会从 `.env.local` 或进程环境读取模型密钥。请在桌面设置页配置所需模型 Key，密钥默认写入 `~/.webAgent/config.json`。新默认文件不存在时，应用才会安全复制旧 `~/.web-agent/config.json`；新文件优先，旧文件会保留。旧版系统钥匙串条目不会被读取或迁移，需要在设置页重新输入。

CLI 宿主读同一份 `~/.webAgent/config.json`，也可用 `--config <文件>` 指定其他路径。

`WEB_AGENT_CONFIG_DIR` 只选择桌面配置目录，例如 `$HOME/.webAgent`，不是模型 Key 来源；设置覆盖目录时不会迁移旧配置。多实例、目录要求与迁移细节见[配置目录说明](docs/config-directory-override.md)。

新会话默认使用 DeepSeek；会话设置中的 `vendor` 决定实际调用的 provider。Kimi 入口还受公开构建变量 `VITE_KIMI_IMAGE_INPUT_ENABLED` 控制，真实中国区 Key 端到端验收前必须保持 `false`。

密钥只由桌面原生层读取并注入受限 provider 传输；它不会保存到浏览器 localStorage 或编译进前端包。Unix 平台的新建配置目录为 `0700`、配置文件为 `0600`；既有覆盖目录必须通过私有权限检查。文件内容是明文，勿提交、共享或复制到不受信任的位置。Kimi 图片上传、`ms://` 引用与清理语义属于 Kimi adapter；Tauri 只提供端点白名单内的通用 JSON/multipart 传输。静态 Web 部署没有可信模型代理，不能直接调用模型服务。

## 开发命令

```bash
pnpm install

# Web 开发预览
pnpm dev

# headless CLI 宿主：-p 跑一轮后退出，无 -p 进入 REPL；-h 看全部选项
pnpm cli -p "<prompt>"
pnpm cli -h

# 类型检查 + 生产构建
pnpm build

# 前端测试
pnpm test

# 装配边界与文档链接门禁（CI 里排在测试之前）
node scripts/check-boundaries.js
node scripts/check-docs.js

# Tauri 开发和打包
pnpm tauri dev
pnpm tauri build

# Rust 桥集成测试
cargo test --manifest-path apps/desktop/Cargo.toml
```

`pnpm build` 过程中打印的 chunk 体积、chunk 拆分和动态导入相关警告是预期噪音，
不代表构建失败——以命令退出码为准。

运行单个测试：

```bash
pnpm exec vitest run packages/agent-core/src/runtime/modelRun.test.ts
pnpm exec vitest run -t "ask_user"
```

测试文件并行运行，靠 `vite.config.ts` 的 `isolate: true` 隔离：每个文件有独立 worker，
`defaultCore` / `toolRegistry` 这类模块级单例在每个 worker 里各有一份，
`apps/web/src/test/setup.ts` 在 worker 内注册标准工具，并只在用例之间重置 `defaultCore` 的
root/session store。跨文件不会互相污染，因此不需要串行。需要更强隔离的测试应显式调用
`createCore()` 或 `createCoreInstance()` 建独立实例，而不是退回文件串行。

## 仓库结构

```text
.
├── apps/
│   ├── web/
│   │   ├── index.html           # Vite HTML 入口
│   │   └── src/                 # React 装配、UI、样式与组件测试
│   ├── cli/                     # headless CLI 宿主（dogfood 与自动化驱动真实 run）
│   └── desktop/                 # Tauri 2 / Rust 桌面桥
├── packages/
│   ├── agent-ai/                # DeepSeek / GLM / Kimi API 适配
│   ├── agent-core/              # 装配式内核：状态、运行时、工具契约、plugin/观测/持久化 contract
│   ├── agent-react/             # React 插件安装面与 timeline renderer registry
│   ├── subagents/               # 委派调度、批次、归档治理与视图 state
│   ├── persistence-idb/         # IndexedDB 会话/历史持久化 driver
│   ├── persistence-sqlite/      # SQLite 会话/历史持久化 driver
│   ├── observability-idb/       # IndexedDB trace driver 与 reader
│   └── observability-sqlite/    # SQLite trace driver 与 reader
├── tools/
│   ├── standard/                # 六个工具域的 meta 聚合包
│   ├── shell/                   # shell / task / Git
│   ├── fs/                      # workspace 文件、搜索和补丁
│   ├── interaction/             # ask_user / browser card / artifact
│   ├── planning/                # 结构化计划工具
│   ├── skills/                  # skill 搜索与读取
│   ├── agents/                  # delegate / observe / join Agent
│   └── mcp/                     # 第七域，不在标准包里，由应用层按需装配
├── docs/                        # 当前实现说明与仍在推进的演进蓝图
└── scripts/                     # 门禁脚本与子 Agent archive/skill 治理
```

Core 不自动安装具体工具或能力实现。应用入口安装标准工具集，并向 `createCore`/默认实例装配
project skills、plan、delegation、持久化与观测所需的能力；其他消费方也可以只注册需要的工具域。

## 构建产物

- Web：`apps/web/dist/`
- Tauri 原始可执行文件：`apps/desktop/target/release/`
- Tauri 安装包：`apps/desktop/target/release/bundle/`

Tauri 通常需要在目标操作系统上构建：Windows 构建 `.exe/.msi`，macOS 构建 `.app/.dmg`，
Linux 构建 `.deb/.rpm/.AppImage`。

## 深入设计

想知道内核为什么长这样，以及踩过哪些坑：

- [一个内核，三个宿主：装配式 Agent Runtime 设计](docs/launch/articles/assembly-kernel.md)
- [给工具加生命周期：CallTiming 机制](docs/launch/articles/call-timing.md)
- [子 Agent 治理：replay、容量与归档](docs/launch/articles/subagent-governance.md)
- [用 CLI 宿主 dogfood，十分钟抓出一个线上 400](docs/launch/articles/dogfood-400.md)
- [DeepSeek V4 thinking 协议踩坑实录](docs/launch/articles/deepseek-v4-pitfalls.md)

## 文档与参与

- 完整文档导航见 [docs/README.md](docs/README.md)：区分当前有效说明与仍在推进的演进蓝图；
  已完成的阶段性 PLAN 只保留在 Git 历史中。
- 提 PR 前先读 [CONTRIBUTING.md](CONTRIBUTING.md)：环境准备、提交前门禁、commit 约定和代码红线。
- 仓库内编码 Agent 的工作约定见 [CLAUDE.md](CLAUDE.md)。

## License

[MIT](LICENSE)
