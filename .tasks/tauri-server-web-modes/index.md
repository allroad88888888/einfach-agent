# Tauri 薄壳与三种 Web 发行模式

创建：2026-08-21

基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`

状态：已完成

## 目标边界

```text
纯 Web 完整版 ──────── apps/web/dist ──────── static runtime
浏览器 + Node server ── apps/server/dist/public ─ server runtime
Tauri 桌面版 ───────── Node sidecar + 同一 server ─ server runtime
```

三者共用 `apps/web` 的 React UI、Lingui catalog、业务协议、Vite 构建和页面组件。server build 已由
`apps/server/scripts/embed-web-dist.mjs` 将同一份 `apps/web/dist` 复制至 `apps/server/dist/public`。

它们不能共用所有运行时适配器：

| 面 | `static`（纯 Web） | `server`（浏览器 / Tauri） |
| --- | --- | --- |
| 本机工具 | 无 bridge，不暴露文件、Shell、Git、MCP stdio | `/api/invoke/:command` → `packages/host-node` |
| 持久化 | IndexedDB | HTTP SQL executor → 本机 SQLite |
| 模型凭据 | 浏览器 localStorage BYOK | server 管理，前端不读回 Key |
| 模型请求 | 浏览器直连 provider | `/api/model/request` |

因此 Tauri **复用 `server`，不新增 `HostKind`**。`apps/web/src/host/resolveHost.ts` 必须仍是
`'server' | 'static'`；任何 Web 源不得 import `@tauri-apps/*` 或调用 Rust `invoke`。Tauri 只启动
Node sidecar，读取一次 ready URL，打开该 URL 的 Webview，负责 child 退出。

## 历史裁决

- `e52c31d`（2026-08-19，`refactor: remove the desktop app and its host state`）删除旧 `apps/desktop`：
  249 文件、26,714 行。该提交是有意重构，不按“误删”恢复。
- 删除前的 Tauri 已加载 `../web/dist`，但 Rust 还实现了 MCP、模型、Shell、工作区和 SQLite 业务宿主。
  裁决：恢复桌面产品，不恢复 Rust 业务宿主。
- 裁决：桌面包内携带 Node `>=22.13.0` 运行时 — server 的 engines 已要求此版本，终端用户不应预装 Node；
  代价是每个 target 都要有经校验的 runtime 资源和更大的安装包。

## 全局约束

- 编排者只写本目录、审查和调度；所有产品与测试代码由执行 agent 修改。
- 工作区已有用户在途改动，禁止 reset、checkout、暂存、提交、覆盖无关文件；任务 diff 仅按各叶 `files` 审查。
- 所有普通源文件单一职责且不超过 300 行；i18n 资源除外。业务/UI 状态仅使用 Einfach，不新增 React 本地状态或其他状态库。
- token 只允许经 Tauri child stdout 的 ready frame 交给同一进程；不得写日志、事件、磁盘、测试快照或错误消息。
- Tauri 无 `#[tauri::command]` 与 `invoke_handler`；不恢复旧 Rust MCP/模型/工作区/SQLite 实现。
- 未获授权不得发布、push、上传 artifact 或使用签名密钥。每个执行 agent 不得派子 agent、不得 commit。
- 执行报告仅写 `reports/NNN-report.md`；独立审查仅写 `reports/NNN-review.md`。

## 任务树

- 100 运行时契约 (`group`)
  - [010](010-web-mode-contract.md) 固化 Web 两态契约 (`leaf`，依赖：无)
  - [020](020-server-ready-frame.md) 产出 server ready frame (`leaf`，依赖：无)
- 200 桌面封装 (`group`)
  - [030](030-node-runtime-stager.md) 暂存 Node runtime (`leaf`，依赖：无)
  - [040](040-tauri-thin-shell.md) 装配 Tauri 薄壳 (`leaf`，依赖：020、030)
- 300 验证与发行 (`group`)
  - [050](050-desktop-mode-smoke.md) 验证三种运行模式 (`leaf`，依赖：010、040)
  - [052](052-static-guard-binding-semantics.md) 收紧静态守卫绑定语义 (`leaf`，依赖：040，发现自：050)
  - [055](055-root-test-integration.md) 接入根测试基础设施 (`leaf`，依赖：040，发现自：050)
  - [060](060-desktop-release-matrix.md) 建立桌面发布矩阵 (`leaf`，依赖：040、052、055)
  - [065](065-release-documentation-reconciliation.md) 对齐桌面发布现状文档 (`leaf`，依赖：060，发现自：060)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 固化 Web 两态契约 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 020 | 产出 server ready frame | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 030 | 暂存 Node runtime | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 040 | 装配 Tauri 薄壳 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 050 | 验证三种运行模式 | gpt-5.6-sol | failed | 2026-08-21 | |
| 052 | 收紧静态守卫绑定语义 | gpt-5.6-sol | done | 2026-08-31 | 2026-08-31 |
| 055 | 接入根测试基础设施 | gpt-5.6-terra | done | 2026-08-31 | 2026-08-31 |
| 060 | 建立桌面发布矩阵 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-31 |
| 065 | 对齐桌面发布现状文档 | gpt-5.6-terra | done | 2026-08-31 | 2026-08-31 |

## 就绪集与模型分配

确认后首先并行派发 010（跨模块契约，Sol）、020（server 协议，Sol）、030（可复现 staging，Terra）。
040 消费 020/030；050 消费 010/040；060 消费 040/050。macOS Apple Silicon 已裁决；060 的 unsigned preview 或正式签名策略在它就绪时单独裁决。最多三个执行 agent 同时运行，另留一个并发槽给独立 reviewer。

## 验收总门

1. `pnpm build`、`pnpm check:boundaries`、`pnpm check:state` 通过。
2. 静态 Web 仍解析为 `static`，不启动 sidecar、不登记本机 bridge。
3. 浏览器 server 模式与 Tauri Webview 都解析为 `server`，使用同一 `/api/health`、`/api/invoke` 和 server 管理的凭据路径。
4. `pnpm desktop:dev`、当前平台 `pnpm desktop:build` 通过；关闭窗口或启动失败均停止 Node child。
5. 生产 Web 源没有 `@tauri-apps/`、`HostKind` 的 `tauri` 成员、`invoke(` 或恢复的 Rust 业务命令。

## 遗留与发现

- 首发仅为 macOS Apple Silicon（`aarch64-apple-darwin`）；Windows、Linux、Intel macOS 不在本轮范围。060 只建立这个 target 的预览/正式发布路径，签名策略仍不得猜测。
- 任务外全量 `pnpm test` 现被用户已删除的 `apps/web/src/agentNew/ui/UndoBar.tsx` 对应 invariant 测试阻塞；执行者不得顺手修复，最终报告需单独列出。
- 030 审查的 Minor：非 Apple target 映射仅抽样测试，sidecar 在复制/改名失败时可能留下被忽略的临时文件；不阻塞 Apple Silicon 首发，留待跨平台扩展时处理。
- 040 审查的 Minor：开发/构建命令固定 Apple Silicon target（符合首发范围），`com.webagent.app` 仍触发 identifier 格式 warning；两者不阻塞本轮，但首发前需裁决 identifier 保留或迁移。

## 决策与变更

- 裁决: Tauri 只消费 `server` runtime — 复用现有 Node host 防止 Rust/Node 能力漂移；错了的代价是桌面专有能力必须先进入 Node server，再由三种 server 客户端共享。
- 裁决: 重建任务树为 `tauri-server-web-modes` — 前一棵未派发且没有报告，缺少本规范要求的 frontmatter、接口和审查账本；错了的代价是旧的未执行规划不再作为续跑依据。
- 裁决: 首发 target 固定为 `aarch64-apple-darwin` — 用户明确只发 macOS Apple Silicon；错了的代价是其他平台用户必须等待后续目标 runtime、测试与签名工作。
- 裁决: 010 的静态守卫扫描可执行依赖而非任意历史注释，测试要求现有覆盖而非机械新增断言 — 两处范围外注释不构成 Web runtime 依赖，且桥/持久化已有直接用例；错了的代价是语法变体可能绕过守卫，故 050 仍以运行 smoke 补证。
- 2026-08-21：020、030 通过独立审查并完成；030 的 Minor 已记入遗留。
- 2026-08-21：040 的依赖完成，已派发执行。
- 2026-08-21：010 按修订后的可执行依赖守卫完成复审；三项验收通过。
- 2026-08-21：040 执行完成，进入独立审查；Cargo lock 固定与历史 bundle identifier 记为待裁决。
- 2026-08-21：040 首轮审查拒绝：窗口创建失败 cleanup 与 Cargo.lock 为 Important。裁决: R1 在同一薄壳任务修复并将 lock 纳入 files — 两项直接影响首发进程安全和可复现构建；错了的代价是推迟 050/060。
- 2026-08-21：040 R1 完成，等待独立复审真实 child 终止观察与 `--locked` 构建。
- 2026-08-21：040 R1 复审通过，三项 Important 关闭；050 的依赖完成，已派发执行。
- 2026-08-21：050 执行完成，进入独立审查。
- 2026-08-21：050 首轮审查拒绝：静态能力守卫有常见语法绕过，Git porcelain 不能证明 dirty/untracked/ignored 文件内容不变。裁决: R1 在 050 修复 — 两项直接决定 smoke 是否可作为首发安全证据；错了的代价是推迟 060。
- 2026-08-21：050 R1 完成，等待独立复审 AST/词法守卫、失败脱敏和内容 hash manifest。
- 2026-08-21：050 R1 复审拒绝：计算属性 Tauri root、Rust char literal 和 panic 输出仍可绕过守卫。裁决: R2 在同一任务修复 — 这些是静态边界的直接绕过；错了的代价是再次复审或将守卫拆成专用叶。
- 2026-08-21：050 R2 完成，等待独立复审计算属性、未知动态模块、Rust char/panic 与退出输出边界。
- 2026-08-21：050 R2 复审拒绝：透明表达式包装、computed require 和可信 plugin import 参数绑定仍可绕过。裁决: R3 换新 Sol agent 并授权拆 Web AST helper — 已完成两轮修复，继续原地追加将撞 300 行上限；错了的代价是任务标记 failed、060 blocked。
- 2026-08-21：050 R3 完成，等待最终独立审查；R3 若仍有 Important 则按修复上限标记失败。
- 2026-08-21：050 最终复审拒绝：常量求值器忽略 mutation 与词法 binding，可漏过非静态 import 和 computed require alias。三轮修复上限已用尽，标记 failed；060 因依赖 failed 标记 blocked。
- 裁决: 050 保留 failed 历史，由 052 接管单一根因 — 原叶三轮上限不可重置，新的绑定语义可独立验收；
  错了的代价是任务号增加，但不会伪造第四轮成功。
- 裁决: 055 单独处理根测试发现面 — Node `node:test` 专项与 Rust-only `src` 都是新增桌面成员对全仓门禁的
  接入问题，不属于 AST 能力边界；错了的代价是多一个叶，但避免 052 同时承担两层职责。
- 2026-08-31：用户要求继续推进并授权编排者在审查通过后分批 commit；执行/reviewer agent 仍不得提交。
- 2026-08-31：055 首次执行因任务漏列 `sourceFiles.js` 返回 BLOCKED；编排者补精确 owner 后同模型续跑，
  未发生猜测性产品改动。
- 2026-08-31：052 首轮审查拒绝解构与迭代 assignment target 漏判；原 Sol 执行者进入限定 R1。
- 2026-08-31：055 执行及独立审查通过；编排者复跑 9 个扫描面自测、state、diff 与行数门全绿。
- 2026-08-31：052 R1 独立复审通过；编排者复跑 static guard 4/4、wrapper 7/7 与行数门，060 解锁派发。
- 2026-08-31：核对 060 时发现三份当前文档仍宣称桌面端与 workflow 不存在；登记 065 对齐现状，历史 issue 账本不回写。
- 2026-08-31：060 经两轮限定修复后独立复审通过；编排者复跑 YAML、target/secret/publish 策略、diff 与行数门通过，065 解锁。
- 2026-08-31：065 独立审查通过，根文档门通过 317 个 Markdown；Tauri 树完成，进入全树集成审计。
