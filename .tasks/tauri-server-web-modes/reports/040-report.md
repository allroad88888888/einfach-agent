# 040 装配 Tauri 薄壳执行报告

## 改动摘要

- 新建 Tauri v2 桌面 crate、构建入口、最小 capability、应用配置与历史应用图标。
- `server_sidecar.rs` 使用固定 externalBin 名 `einfach-agent-node` 启动 Node，参数为打包资源 `server/main.js --ready-json --host 127.0.0.1 --port 0`。
- ready frame 仅接受 `kind = einfach-agent-server-ready`、`version = 1`、合法 HTTP loopback URL；错误不包含原始 stdout，因此不会回显 token。
- sidecar 从 spawn 成功起即由 RAII guard 持有，在 ready 超时、frame 非法、提前退出、窗口创建失败、窗口关闭和应用退出时终止；Webview 仅在 ready 成功后打开该 URL。
- `lib.rs` 只装配 shell plugin、child 生命周期与动态 Webview；未加入 Rust invoke command 或业务宿主。
- Tauri bundle 映射 `apps/server/dist` 为 `server/`，并把 server 的 external 运行依赖 `@einfach-agent/host-node` 构建、映射到 `server/node_modules`；externalBin 为 `binaries/einfach-agent-node`。
- 根脚本新增 `desktop:dev`、`desktop:build` 与 `@tauri-apps/cli`。`desktop:dev` 使用 `beforeDevCommand.wait = true` 且关闭 watcher，确保 server、host-node 与 Node runtime 准备完成后只启动一组 desktop/child。
- `pnpm-lock.yaml` 已随新增 Tauri CLI 依赖更新；`apps/desktop/Cargo.lock` 已纳入首发并由 `--locked` 验证；保留工作区原有 Lingui 等在途改动。
- 所有新增普通源文件均低于 300 行；最大文件 `server_sidecar.rs` 为 272 行。

## 逐条验收命令与结果

1. `cargo test --manifest-path apps/desktop/Cargo.toml --locked`
   - 通过：6 passed，0 failed，1 ignored（ignored 项是供真实 child 测试启动的长驻 fixture）。
   - 覆盖：合法 ready frame、错误 kind/version/远端 URL、token 脱敏。
   - cleanup 回归直接用 `tauri-plugin-shell` 启动真实 `CommandChild`；超时、ready 前失败、窗口创建失败三条路径均从实际 child 事件流观察到 `CommandEvent::Terminated`，不是 AtomicBool/闭包替身。

2. `pnpm desktop:build`
   - 通过：Web、server、host-node、Node runtime staging、Rust release build 与 macOS `.app` bundle 全部成功。
   - 产物：`apps/desktop/target/aarch64-apple-darwin/release/bundle/macos/Einfach Agent.app`（验收后已用 `cargo clean` 清理，可由命令重建）。
   - Tauri 给出非阻断 warning：bundle identifier `com.webagent.app` 以 `.app` 结尾。

3. 包内容检查：
   - `test -f '.../Einfach Agent.app/Contents/Resources/server/main.js'`：通过。
   - `test -x '.../Einfach Agent.app/Contents/MacOS/einfach-agent-node'`：通过。
   - `test -f '.../Contents/Resources/server/node_modules/@einfach-agent/host-node/dist/index.js'`：通过。

4. `rg -n "tauri::command|invoke_handler|tauri-plugin-(sql|dialog|log)" apps/desktop`
   - 通过：无匹配。

5. `pnpm desktop:dev`
   - 通过：准备命令完成后启动 `target/debug/einfach-agent-desktop`，并且只存在一组 desktop 进程和一组带固定参数的 Node child。
   - 通过 Ctrl-C 结束开发进程后再次 `pgrep`，desktop 与 Node 均无残留。

6. 打包运行态检查：
   - 直接启动 `.app/Contents/MacOS/einfach-agent-desktop` 后，确认 Node child 的 PPID 为 desktop PID，参数为打包 `server/main.js --ready-json --host 127.0.0.1 --port 0`。
   - 通过 macOS 正常 quit 退出应用后，desktop 与 Node child 均无残留。

7. 格式、边界与锁文件检查：
   - `cargo fmt --manifest-path apps/desktop/Cargo.toml -- --check`：通过。
   - `cargo clippy --manifest-path apps/desktop/Cargo.toml --locked --all-targets -- -D warnings`：通过。
   - `cargo metadata --manifest-path apps/desktop/Cargo.toml --locked --no-deps --format-version 1`：通过。
   - `git diff --check -- package.json pnpm-lock.yaml`：通过。
   - `pnpm install --lockfile-only --frozen-lockfile`：通过。
   - `wc -l`：`lib.rs` 57、`main.rs` 5、`server_sidecar.rs` 272，均低于 300 行。

## R1 审查修复对应

1. 窗口创建失败 cleanup：`RunningServer::handoff_after` 先执行窗口创建，成功后才把 RAII guard 交给 `ManagedServer`；窗口构建返回错误时局部 `RunningServer` 立即 drop 并 kill child。
2. Cargo lock：任务 files 扩展后生成并保留 `apps/desktop/Cargo.lock`；验收测试与 metadata 均用 `--locked`。
3. cleanup 观测强度：删除仅证明 closure 被调用的 AtomicBool 测试，改为实际 `CommandChild` + `CommandEvent::Terminated` 观测；release app 正常 handoff/quit 也再次实测无残留进程。

## 未验证项

- 未在本叶执行 Web 页面内的 `/api/health`、`/api/invoke` 端到端交互 smoke；这是后续 050 的职责。
- 未验证签名、notarization、DMG 或发布上传；本轮只构建 unsigned macOS Apple Silicon `.app`。
- 未验证 Intel macOS、Windows 或 Linux target；任务树已裁决首发仅 `aarch64-apple-darwin`。
- 未执行全量 `pnpm test`；index 已记录其被范围外删除的 `UndoBar.tsx` invariant 测试阻塞。

## 范围外发现

- Vite 构建仍报告既有的大 chunk 与动态/静态重复 import warning，未影响构建，未在本叶处理。
- Tauri 警告历史 identifier `com.webagent.app` 以 `.app` 结尾；修改 identifier 可能影响应用身份/升级路径，未擅自改变。
- server 的 tsup 产物会 externalize `@einfach-agent/host-node`。首次运行态检查因此在 ready 前退出；已在本叶允许的 `tauri.conf.json` 内通过构建并打包该运行依赖解决，没有修改 server/host-node 源码。

## 疑虑

- `desktop:dev` 为避免 staging externalBin 触发 Tauri watcher 重启并遗留被强杀的 child，当前明确使用 `--no-watch`。开发时修改 Rust 代码需手动重启命令。

## 建议后续动作

1. 050 对 static、browser server、Tauri 三种模式执行 `/api/health` 与关键 bridge smoke，并复核窗口关闭后的 child 清理。
2. 发行前单独裁决是否从 `com.webagent.app` 迁移到不以 `.app` 结尾的 identifier，并评估升级兼容性。
3. 后续如需 Rust 热重载，设计不会重写被 watcher 监控 externalBin 的 dev staging 流程，再移除 `--no-watch`。
