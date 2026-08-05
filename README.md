# Web Agent

Web Agent 是一个可在浏览器预览、以 Tauri 桌面端为完整能力目标的聊天 Agent Runtime。
仓库采用 pnpm workspace：React UI、Agent Core、模型适配器和标准工具集分包维护，
桌面端通过 Rust/Tauri 提供真实的 shell、文件、Git 和 SQLite 能力。

## 能力边界

- **Tauri 桌面端**：完整产品形态，可使用 shell、workspace 文件、ripgrep、任务执行、补丁和 Git diff。
- **Web 预览**：复用同一套 React UI 和 Agent Runtime；无法使用 Tauri 的 `server` 工具，
  这些工具会从模型可见清单中自动隐藏。
- **模型接入**：当前支持 DeepSeek 与 GLM；Kimi `kimi-k2.6` 与图片输入已实现，但真实 Key 验收前保持开放门禁关闭。
- **运行时能力**：多会话、checkpoint/revert、lazy tool schema、危险工具确认、结构化计划与评估、
  树形子 Agent、后台执行图、上下文压缩与 provider context cache 统计、持久化和 trace viewer。

## 仓库结构

```text
.
├── apps/
│   ├── web/
│   │   ├── index.html           # Vite HTML 入口
│   │   └── src/                 # React 装配、UI、样式与组件测试
│   └── desktop/                 # Tauri 2 / Rust 桌面桥
├── packages/
│   ├── agent-ai/                # DeepSeek / GLM / Kimi API 适配
│   └── agent-core/              # 状态、运行时、计划、评估、子 Agent、持久化、观测
├── tools/
│   ├── standard/                # 六个工具域的 meta 聚合包
│   ├── shell/                   # shell / task / Git
│   ├── fs/                      # workspace 文件、搜索和补丁
│   ├── interaction/             # ask_user / browser card / artifact
│   ├── planning/                # 结构化计划工具
│   ├── skills/                  # skill 搜索与读取
│   └── agents/                  # delegate / observe / join Agent
├── docs/                        # 当前实现说明与仍在推进的演进蓝图
└── scripts/                     # 子 Agent archive/skill 治理脚本
```

依赖方向保持单向：

```text
packages/agent-ai ← packages/agent-core ← tools/* ← tools/standard ← app
```

Core 不自动安装具体工具。应用入口通过 `registerStandardTools(toolRegistry)` 安装标准工具集；
其他消费方也可以只注册需要的工具域。

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

`.env.example` 仅列出可用变量名；桌面应用不会自动从 `.env.local` 读取密钥。可任选一种方式配置模型 Key：在设置页保存到系统钥匙串，或仅为桌面进程提供环境变量：

```bash
DEEPSEEK_API_KEY=... pnpm tauri dev
# 或者
GLM_API_KEY=... pnpm tauri dev
# Kimi 中国区（仅用于门禁验收）
KIMI_API_KEY=... pnpm tauri dev
```

新会话默认使用 DeepSeek；会话设置中的 `vendor` 决定实际调用的 provider。Kimi 入口还受公开构建变量 `VITE_KIMI_IMAGE_INPUT_ENABLED` 控制，真实中国区 Key 端到端验收前必须保持 `false`。

密钥只由桌面原生层读取并注入受限 provider 传输；它不会保存到浏览器 localStorage 或编译进前端包。Kimi 图片上传、`ms://` 引用与清理语义属于 Kimi adapter；Tauri 只提供端点白名单内的通用 JSON/multipart 传输。静态 Web 部署没有可信模型代理，不能直接调用模型服务。

## 开发命令

```bash
pnpm install

# Web 开发预览
pnpm dev

# 类型检查 + 生产构建
pnpm build

# 前端测试
pnpm test

# Tauri 开发和打包
pnpm tauri dev
pnpm tauri build

# Rust 桥集成测试
cargo test --manifest-path apps/desktop/Cargo.toml
```

运行单个测试：

```bash
pnpm exec vitest run packages/agent-core/src/runtime/modelRun.test.ts
pnpm exec vitest run -t "ask_user"
```

测试文件按串行模式运行。运行时仍存在少量模块级共享状态，在移除这些共享状态前不要重新启用
Vitest 文件并行。

## 构建产物

- Web：`apps/web/dist/`
- Tauri 原始可执行文件：`apps/desktop/target/release/`
- Tauri 安装包：`apps/desktop/target/release/bundle/`

Tauri 通常需要在目标操作系统上构建：Windows 构建 `.exe/.msi`，macOS 构建 `.app/.dmg`，
Linux 构建 `.deb/.rpm/.AppImage`。

## 文档入口

先阅读 [docs/README.md](docs/README.md)。其中区分当前有效文档与仍在推进的演进蓝图；
已完成的阶段性 PLAN 只保留在 Git 历史中。
