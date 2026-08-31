---
id: "030"
title: 暂存 Node runtime
kind: leaf
parent: "200"
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/desktop/.gitignore
  - apps/desktop/binaries/.gitkeep
  - scripts/stage-desktop-node-runtime.mjs
  - scripts/stage-desktop-node-runtime.test.mjs
  - docs/desktop-node-runtime.md
---

# 暂存 Node runtime

## 目标

生成目标匹配的 Node sidecar 文件。

## 上下文

`apps/server/package.json` 声明 `"node": ">=22.13.0"`。Tauri v2 的 `bundle.externalBin` 查找名称加上
target triple 的可执行文件。当前仓库没有 `apps/desktop`；旧桌面端也没有可复用的 Node runtime。

本任务实现一个可复现脚本，参数为 `--target <tauri-target-triple>`，下载固定 Node 发行物、校验
SHA-256、解压并在 `apps/desktop/binaries/einfach-agent-node-<target>` 产生可执行文件。缓存只能放在
gitignore 路径；不得提交 Node 二进制或复制本机 `node_modules`。macOS/Linux 和 Windows 的 archive、
可执行名、权限差异必须显式处理。

## 接口

### 消费

- `pnpm build` 已生成 `apps/server/dist/main.js`；040 将其作为 Node 第一参数。

### 产出

```text
node scripts/stage-desktop-node-runtime.mjs --target <triple>
→ apps/desktop/binaries/einfach-agent-node-<triple>[.exe]
```

040 的 `tauri.conf.json` 必须以 `bundle.externalBin: ["binaries/einfach-agent-node"]` 消费此命名；Tauri
负责按自身 target 加后缀。

## 验收标准

1. `node scripts/stage-desktop-node-runtime.test.mjs` → 覆盖 target 映射、SHA-256 不匹配、缺失 archive 和输出命名。
2. 当前主机 target 跑一次 staging 后，`apps/desktop/binaries/` 只包含忽略的 executable 与 `.gitkeep`；`git status --short` 不出现二进制。
3. `node --version` 对 staged executable 的输出满足 `>=22.13.0`。

## 执行记录（仅编排者回写）

- 2026-08-21：执行与独立审查通过；跨平台映射抽样与失败临时文件清理列为 Minor 遗留，见 `reports/030-review.md`。
