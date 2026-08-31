---
id: "020"
title: 产出 server ready frame
kind: leaf
parent: "100"
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/server/src/mainCliOptions.ts
  - apps/server/src/mainCliOptions.test.ts
  - apps/server/src/mainReadyFrame.ts
  - apps/server/src/mainReadyFrame.test.ts
  - apps/server/src/mainRunServer.ts
  - apps/server/src/mainRunServer.test.ts
---

# 产出 server ready frame

## 目标

使 Node server 用一帧 JSON 报告监听 URL。

## 上下文

`runServerCli()` 位于 `apps/server/src/mainRunServer.ts`：它生成 auth token、调用
`listenWithPortRetry()`、拼出 `http://<host>:<port>/?token=<token>`，当前再用
`formatStartupMessage()` 写给人看的中文文本。Tauri 不能解析该文本。

`parseServerCliOptions()` 位于 `mainCliOptions.ts`，已有 `--port`、`--host`、`--no-open`。本任务新增
`--ready-json`。它隐含 `open:false`，且在 listen 成功后 stdout 只写一行 ready frame；其他诊断留在 stderr。

## 接口

### 消费

- `runServerCli({ argv })`：现有入口；040 的 Node child 以
  `--ready-json --host 127.0.0.1 --port 0` 启动 server。

### 产出

```ts
export const SERVER_READY_KIND = 'einfach-agent-server-ready'
export const SERVER_READY_VERSION = 1
export interface ServerReadyFrame {
  readonly kind: typeof SERVER_READY_KIND
  readonly version: typeof SERVER_READY_VERSION
  readonly url: string
}
export function formatServerReadyFrame(frame: ServerReadyFrame): string
```

`formatServerReadyFrame()` 返回 `JSON.stringify(frame) + '\n'`。`url` 是唯一带 query token 的字段；不得额外
导出或打印 token。

## 验收标准

1. `pnpm exec vitest run apps/server/src/mainCliOptions.test.ts apps/server/src/mainReadyFrame.test.ts apps/server/src/mainRunServer.test.ts` → 全部通过，覆盖 flag、单行 JSON、不开浏览器、旧模式保持原输出。
2. `pnpm --filter @einfach-agent/server build` → 通过。
3. 新/改文件逐个 `wc -l` → 普通源文件均不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-21：执行与独立审查通过；报告与审查见 `reports/020-report.md`、`reports/020-review.md`。
