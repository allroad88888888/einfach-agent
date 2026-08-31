# 040 独立审查：装配 Tauri 薄壳

## 结论

**REJECTED**。三条显式验收标准均有执行报告中的通过证据，且薄壳边界、固定资源路径与 sidecar 参数总体正确；但当前实现存在一个可导致 Node child 残留的初始化失败路径，同时首发桌面应用没有提交 `Cargo.lock`，无法固定 Rust 依赖解析。这两项均属于 Important，需在发布前处理。

本审查只使用任务文件、执行报告及指定范围 diff；未重跑执行报告已声明的测试或构建。

## 验收标准逐条判定

1. ✅ `cargo test --manifest-path apps/desktop/Cargo.toml`

   - 执行报告记录 `5 passed, 0 failed`，覆盖合法/非法 ready frame、超时 cleanup、启动失败 cleanup 与 token 脱敏。
   - diff 证据：`apps/desktop/src/server_sidecar.rs:42-56` 严格校验 `kind`、`version`、HTTP scheme 与 loopback host；`:111-150` 实现超时和失败 cleanup；`:157-212` 包含对应 5 个测试。
   - 按要求未重跑该命令。测试覆盖强度的问题另列 Important，不改变“报告声称命令已通过”的事实。

2. ✅ `pnpm desktop:build`

   - 执行报告记录 Web/server/host-node/Node staging、Rust release build及 Apple Silicon macOS `.app` bundle 均成功，并检查了包内 `server/main.js`、可执行 sidecar 和 `@einfach-agent/host-node` 运行依赖。
   - diff 证据：`package.json:24-25` 提供 `desktop:dev`/`desktop:build`；`apps/desktop/tauri.conf.json:7-16` 在 dev/build 前构建并 stage 资源；`:24-32` 声明 `server/` 资源、host-node 资源和固定 externalBin。
   - 当前报告验证的平台是 `aarch64-apple-darwin`。执行报告声称任务树已裁决首发仅支持该 target，但该裁决不在本审查给定的任务文件/diff 内，故其他平台支持范围为 **⚠️无法核实**，不记为 ❌。

3. ✅ 禁止业务 Tauri invoke 与旧插件

   - 执行报告记录指定 `rg` 命令无匹配。
   - diff 中没有 `#[tauri::command]`、`invoke_handler` 或 `tauri-plugin-(sql|dialog|log)`；`apps/desktop/src/lib.rs:24-53` 只装配 shell plugin、sidecar 生命周期与 Webview 窗口。
   - capability 只授予 `core:default`（`apps/desktop/capabilities/default.json:1-7`），没有授予 shell 命令能力给页面。

## 质量发现

### Critical

无。

### Important

1. **窗口创建失败会绕过 child cleanup，存在残留 Node 进程的路径。**

   `apps/desktop/src/lib.rs:28-35` 先成功启动 sidecar，再把 `RunningServer` 移入 `ManagedServer`，之后才执行可能失败的 `WebviewWindowBuilder::build()?`。一旦窗口构建失败，setup 返回错误并在外层 `expect` 终止；`ManagedServer`/`RunningServer` 没有 `Drop` cleanup，现有显式 `stop()` 只会在 `app.run` 收到退出/关窗事件时调用（`:41-52`），而该失败发生在进入 `app.run` 之前。执行报告验证的是 ready 前失败和正常退出，没有覆盖 ready 成功后窗口创建失败。应在窗口创建成功后再交接 child，或为持有者提供可靠的 RAII cleanup，并增加该失败路径的回归测试。

2. **缺少 `apps/desktop/Cargo.lock` 构成首发阻断风险。**

   指定范围中该文件确实不存在。`apps/desktop/Cargo.toml:12-21` 的 Cargo 版本写法均为可浮动的兼容范围（包括写成 `2.11.4` 的 Tauri 依赖，Cargo 语义仍是 caret range），因此每次无锁构建都可能解析到不同的直接/传递依赖。对交付二进制的桌面应用，这会破坏可复现构建、使已验证产物与后续发布产物不等价，并扩大供应链变更面。任务文件当前未授权 `Cargo.lock`，因此应新增/扩展受控任务把它纳入版本库；在首发构建前不能只作为一般后续建议搁置。

3. **cleanup 测试没有验证真实 child 被终止。**

   `apps/desktop/src/server_sidecar.rs:180-202` 只用 `AtomicBool` 证明通用 `cleanup_on_failure` 会调用传入 closure；没有观测 `CommandChild::kill()`、进程退出，亦未覆盖上述窗口创建失败路径。执行报告的手工 dev/bundle 正常退出检查提供了一部分运行态证据，但不能防止失败路径回归。此项与发现 1 共同构成生命周期验收的覆盖缺口。

### Minor

1. **通用命令名实际硬编码为单一平台。**

   `package.json:25` 和 `apps/desktop/tauri.conf.json:8,13` 均固定 `aarch64-apple-darwin`。如果首发范围确实只含 Apple Silicon，这不是本叶的功能失败；但命令在非该 target 的开发机上不会按“当前 target”工作。建议把平台限制写入任务/开发文档，或后续从 host target 推导 staging/build target。

2. **bundle identifier 警告尚未裁决。**

   `apps/desktop/tauri.conf.json:5` 使用 `com.webagent.app`，执行报告确认 Tauri 警告 identifier 以 `.app` 结尾。保留历史应用身份可能有升级兼容理由，因此不阻断本叶；首发前仍应明确记录保留或迁移决定。

## 特别审查结论

- **Rust 是否只管生命周期：** 是。Rust 代码只负责解析 ready frame、启动/停止 sidecar、持有 child 和创建 Webview；未发现业务逻辑宿主。初始化失败 cleanup 例外见 Important 1。
- **Tauri 是否无业务 invoke：** 是。无 command、invoke handler 或 sql/dialog/log plugin；capability 未给页面 shell 权限。
- **资源路径/sidecar 是否安全：** 基本是。脚本固定从 `resource_dir/server/main.js` 解析并先检查 `is_file()`（`server_sidecar.rs:69-77`）；sidecar 使用固定名 `einfach-agent-node`，参数以 `OsString` 数组传递而非 shell 拼接（`:79-90`）；ready URL 仅允许 HTTP loopback（`:42-55`）。执行报告还验证了 bundle 内资源位置与可执行文件。未发现路径遍历或任意命令注入。
- **`Cargo.lock` 缺失是否构成首发风险：** 是，而且是发布前应解决的 Important 风险，理由见 Important 2。

## 无法核实项

- ⚠️ Intel macOS、Windows、Linux 的构建与运行未验证；报告说明首发范围只含 `aarch64-apple-darwin`，但本审查材料中没有该范围裁决的原始任务证据。
- ⚠️ Web 页面内 `/api/health`、`/api/invoke` 端到端行为、签名/notarization/DMG/上传不在本叶 diff 与已执行验收范围内，不计为 ❌。

---

## R1 独立复审（2026-08-21）

### 结论

**APPROVED**。首轮三项 Important 均已修复并有范围 diff 与执行报告互相印证；未发现新的 Critical 或 Important 问题。本复审按要求未重跑报告已经声明的测试或构建。

### 首轮 Important 逐条复核

1. ✅ **窗口创建失败时的 RAII cleanup 已闭合。**

   - `server_sidecar.rs:57-71` 的 `ChildGuard` 持有真实 `CommandChild`，其 `Drop` 调用 `kill()`；`RunningServer` 从 ready 成功起持续持有该 guard（`:73-76,120-131`）。
   - `RunningServer::handoff_after` 先执行可能失败的 `create`，仅在成功后才把 `self` 交给 `ManagedServer`（`:78-87`）。`lib.rs:29-38` 把 `WebviewWindowBuilder::build()` 放在 `create` 中、把状态存储放在成功后的 handoff 中。因此窗口构建返回错误时，`?` 提前返回并 drop 尚未交接的 `RunningServer`，child 会被终止。
   - `window_creation_failure_terminates_the_real_child`（`server_sidecar.rs:245-260`）验证失败时 handoff 不会执行，并从真实 child 的事件流观察 termination。

2. ✅ **`Cargo.lock` 已纳入，`--locked` 有通过证据。**

   - 当前任务 `files` 已显式包含 `apps/desktop/Cargo.lock`；范围内存在完整的 Cargo v4 lockfile（4723 行，生成文件例外不受普通源文件行数上限约束），并锁定桌面 crate 的完整依赖图。
   - 执行报告记录 `cargo test --manifest-path apps/desktop/Cargo.toml --locked` 为 `6 passed, 0 failed, 1 ignored`，同时记录 `cargo metadata ... --locked` 与 `cargo clippy ... --locked` 通过。按复审要求未重复执行这些命令。
   - 文件当前与其他新增桌面文件一样显示为 untracked；在本次 worktree diff 审查语境下，这不等于缺失，但最终提交必须确保把它一并纳入。

3. ✅ **真实 `CommandChild` 的终止观测覆盖三条失败路径。**

   - `spawn_plugin_child`（`server_sidecar.rs:167-181`）通过 `tauri-plugin-shell` 启动真实长驻测试进程；已不再使用 `AtomicBool` 或 cleanup closure 替身。
   - `assert_child_terminated`（`:183-195`）在真实 child receiver 上等待 `CommandEvent::Terminated`，事件流若无 termination 即关闭也会失败。
   - 超时（`:226-233`）、ready 前失败（`:235-243`）、窗口创建失败（`:245-260`）三条路径均调用该断言。窗口测试用可控失败 closure 驱动生产 `handoff_after` 的同一错误分支；它没有启动真实 Webview，但对 child ownership/cleanup 的回归覆盖成立。

### 验收标准复核

1. ✅ `cargo test --manifest-path apps/desktop/Cargo.toml --locked`：执行报告记录通过，并覆盖任务要求的 ready JSON、超时、失败 cleanup、窗口创建失败 cleanup 与 token 脱敏。
2. ✅ `pnpm desktop:build`：执行报告记录 Apple Silicon macOS bundle 构建通过，并检查了 `server/main.js`、可执行 Node sidecar 与 externalized host-node 运行依赖。
3. ✅ 禁止业务 invoke/旧插件：范围 diff 中没有 `tauri::command`、`invoke_handler` 或 `tauri-plugin-(sql|dialog|log)`；`lib.rs` 仅装配窗口和 child 生命周期。

### 质量发现

#### Critical

无。

#### Important

无。首轮三项均已关闭。

#### Minor

1. `desktop:dev`、`desktop:build` 与两条 Tauri prepare command 仍硬编码 `aarch64-apple-darwin`。这与报告所述当前首发平台一致，不阻断本叶；若后续扩展 Intel macOS、Windows 或 Linux，需要改为按 host/target 推导。
2. `com.webagent.app` 仍触发 identifier 以 `.app` 结尾的非阻断 warning。保留历史应用身份可能有升级兼容理由，仍建议发行前单独裁决。

### 文件职责与行数

- ✅ 新增普通源文件均低于 300 行：`lib.rs` 57 行、`main.rs` 5 行、`server_sidecar.rs` 272 行、`build.rs` 3 行。
- ✅ `server_sidecar.rs` 聚焦 sidecar ready 协议与 child 生命周期，未发现互不相关职责；`Cargo.lock`、`pnpm-lock.yaml` 属自动生成锁文件例外。

### ⚠️ 无法核实项

- ⚠️ 本复审遵照要求未重跑 `cargo test --locked`、`pnpm desktop:build`、clippy、metadata 或运行态 smoke；这些结论依赖执行报告，复审独立核实的是实现与测试代码是否支持报告所述结论。
- ⚠️ Intel macOS、Windows、Linux 未验证；当前给定任务材料只提供 Apple Silicon macOS 的构建/运行证据。
- ⚠️ Web 页面内 `/api/health`、`/api/invoke` 端到端交互，以及签名、notarization、DMG、上传不在本叶已验证范围内。

APPROVED 首轮三项 Important 已全部关闭，当前实现满足 040 薄壳验收。
