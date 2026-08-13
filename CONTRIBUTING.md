# 贡献指南

欢迎给 Einfach Agent 提 PR。本指南面向第一次贡献者，覆盖环境准备、开发流程、提交前门禁、
commit 约定和代码红线。项目现状以根目录 [README.md](README.md) 和 [CLAUDE.md](CLAUDE.md)
为准，本文档只做流程性补充，两边冲突时以那两份为准。

## 环境准备

- Node.js ≥ 20.19，或 ≥ 22.12。
- 包管理器固定使用 **pnpm**（仓库是 pnpm workspace，`packages/*` 和 `tools/*` 之间用
  `workspace:*` 互相引用）。**不要用 `npm install`**，它不认 `workspace:*`，会装出一份
  错误的依赖树。
- Rust/Tauri 只有在需要跑桌面端（`pnpm tauri dev`/`pnpm tauri build`、
  `cargo test --manifest-path apps/desktop/Cargo.toml`）时才需要：Rust stable ≥ 1.77.2，
  以及对应平台的系统依赖（macOS 是 Xcode Command Line Tools，Windows 是 C++ Build Tools
  和 WebView2 Runtime，Linux 是 WebKitGTK 等，详见 README 的「环境要求」一节）。只改
  TypeScript/React 代码不需要装 Rust 工具链。

```bash
pnpm install
```

## 开发流程

```bash
# Web 预览（浏览器里跑同一套 React UI + Agent Runtime）
pnpm dev

# 桌面端开发（需要 Rust 工具链）
pnpm tauri dev
```

跑单个测试文件或按用例名过滤，比跑全量测试快很多，改动局部时优先用这个：

```bash
pnpm exec vitest run packages/agent-core/src/runtime/modelRun.test.ts
pnpm exec vitest run -t "ask_user"
```

workspace 包不单独编译，`vite.config.ts` 的 alias 和 `tsconfig.app.json` 的 `paths` 直接把
`@web-agent/*` 指到各包 `src`，改包代码无需先 build。但新增或改名一个包时，这两处 alias
必须同步改，否则类型检查和运行时会分别报错，参见 CLAUDE.md「构建与解析模型」一节。

## 提交前门禁

按顺序自查，和 CI（`.github/workflows/ci.yml`）保持一致：

1. `node scripts/check-docs.js` —— **只要改了任意 `.md` 文件就必须跑**。校验所有 Markdown
   的相对链接必须真实存在，并禁止引用迁移前的旧源码路径（连在文档里写出那个字面量路径都会
   失败），规则见脚本内的 `legacySourcePathPattern`。
2. `node scripts/check-boundaries.js` —— 校验 `packages/agent-core` 不反向依赖 React、工具域
   包或其他能力包，是 CI 里的第二道门禁。
3. `pnpm test` —— Vitest 全量跑一遍。
4. `pnpm build` —— `tsc -b` 类型检查加 Vite 生产构建。仓库**没有 lint 脚本**，这是唯一的
   静态门禁，类型错误必须在这一步暴露。
5. 改了 `apps/desktop/` 下的 Rust 代码，额外跑：

   ```bash
   cargo test --manifest-path apps/desktop/Cargo.toml
   ```

CI 实际跑的是 `check-docs → check-boundaries → pnpm test → pnpm build`，外加三平台的
`cargo test` 和 `pnpm tauri build --no-bundle --ci`；本地至少把前四步过一遍再提 PR。

## Commit 约定

采用 conventional commit，**单行主题、小写祈使句、不写 body**。格式：

```text
<type>(<scope>): <subject>
```

真实历史示例（`git log --oneline` 可查）：

```text
feat(mcp): connect transparently when a placeholder tool is called
refactor(mcp): stop duplicating placeholder tool names in connect copy
fix(ai): backfill reasoning_content on tool-call turns for deepseek thinking aliases
```

`type` 常见取值：`feat`、`fix`、`refactor`、`docs`、`test`。`scope` 通常是改动落地的包或
子系统（如 `mcp`、`ai`、`scripts`），不写 body 意味着「为什么改」要在主题句里说清楚，而不是
另起一段解释。

## 代码红线

- **文件行数**：普通文件 ≤300 行，复杂文件（强内聚的单一算法/状态机核心）≤500 行，物理行数
  以 `wc -l` 为准。上限是天花板不是目标，拆分按职责拆，不允许 `xxx2.ts`、`part1` 或塞进
  `utils.ts` 大杂烩。
- **一个文件一件事**：一个业务点或一个抽象，说不清楚该文件是干嘛的就该拆。
- **依赖方向单向**：`agent-ai ← agent-core ← {tools-*、能力包} ← app`。`packages/agent-core`
  不得依赖 React 或任何具体 `tools-*` 包，这条由 `scripts/check-boundaries.js` 强制检查。
- **工具副作用必须走 `ToolContext`**：工具不能直接 import store/atom 拿额外能力，文件、
  shell、计划、渲染、委派等副作用必须使用 `ToolContext` 暴露的能力，才能保证 workspace
  confinement、权限确认、stale guard 和审计生效。完整契约见
  [packages/agent-core/src/tools/TOOLS-SPEC.md](packages/agent-core/src/tools/TOOLS-SPEC.md)。

## 新增工具

新工具放在对应域目录 `tools/<domain>/src/<tool-name>/`（如 `tools/shell/src/run-task/`），
同目录放实现、说明和测试，再由该域包的 registrar（`tools/<domain>/src/index.ts`）注册。
**只加文件不注册，模型是看不到这个工具的**。标准工具的实际清单以各域 registrar 为准，不要
以文档里的数量描述为准，那类描述容易过期。

## 更多背景

- 运行链路、状态与 UI 边界、持久化与运行环境等细节见仓库根 [CLAUDE.md](CLAUDE.md)。
- 专题设计文档入口见 [docs/README.md](docs/README.md)，区分「当前实现说明」和「演进蓝图」，
  蓝图描述目标形态、不代表已交付，引用前请核对实现和测试。
