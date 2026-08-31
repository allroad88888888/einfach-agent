---
id: "040"
title: 装配 Tauri 薄壳
kind: leaf
parent: "200"
depends_on:
  - "020"
  - "030"
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/desktop/Cargo.toml
  - apps/desktop/Cargo.lock
  - apps/desktop/build.rs
  - apps/desktop/capabilities/default.json
  - apps/desktop/icons/**
  - apps/desktop/src/main.rs
  - apps/desktop/src/lib.rs
  - apps/desktop/src/server_sidecar.rs
  - apps/desktop/tauri.conf.json
  - package.json
  - pnpm-lock.yaml
---

# 装配 Tauri 薄壳

## 目标

让 Tauri Webview 加载 Node server URL。

## 上下文

020 提供 `--ready-json` 与 `ServerReadyFrame`。030 提供 target-triple 对应的
`apps/desktop/binaries/einfach-agent-node-<triple>[.exe]`。Node 要执行打包资源中的
`server/main.js` 并接收 `--ready-json --host 127.0.0.1 --port 0`。

旧 `e52c31d^:apps/desktop/tauri.conf.json` 可作为窗口大小、应用标识、图标的历史参考；不得还原旧
`lib.rs` 的 Rust invoke commands 或 sql/dialog/log 插件。当前根 `pnpm build` 先构建 Web 再构建 server，
后者通过 `apps/server/scripts/embed-web-dist.mjs` 把同一 Web dist 放在 `apps/server/dist/public`。

## 接口

### 消费

- `ServerReadyFrame`：020 产物。Rust 只接受 `kind === "einfach-agent-server-ready"` 且 `version === 1` 的一行 JSON。
- Node sidecar：030 产物。启动名固定为 `einfach-agent-node`，server script 资源路径为 `server/main.js`。

### 产出

```text
pnpm desktop:dev
pnpm desktop:build
```

`desktop:dev` 必须先构建 Web/server 并 stage 当前 target Node，再起 Tauri；`desktop:build` 同样保证资源齐全。
Tauri bundle 包含 `server/**` 资源和 `binaries/einfach-agent-node` externalBin。Rust `server_sidecar.rs` 导出：

```rust
pub struct ReadyServer { pub url: url::Url }
pub fn parse_ready_server_line(line: &str) -> Result<ReadyServer, SidecarError>
```

`lib.rs` 只能创建窗口、启动/停止 child；没有 `#[tauri::command]`、没有 `invoke_handler`。

## 验收标准

1. `cargo test --manifest-path apps/desktop/Cargo.toml --locked` → ready JSON 验证、超时、失败 cleanup、窗口创建失败 cleanup 与 token 脱敏测试全部通过。
2. `pnpm desktop:build` → 当前平台 Tauri bundle 成功，且包内有 `server/main.js` 和 target 对应 Node sidecar。
3. `rg -n "tauri::command|invoke_handler|tauri-plugin-(sql|dialog|log)" apps/desktop` → 无匹配。

## 执行记录（仅编排者回写）

- 2026-08-21：R1 复审通过，三项 Important 关闭；报告见 `reports/040-report.md`、`reports/040-review.md`。
