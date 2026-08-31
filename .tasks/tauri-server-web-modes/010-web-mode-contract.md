---
id: "010"
title: 固化 Web 两态契约
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
  - apps/web/src/host/resolveHost.ts
  - apps/web/src/host/resolveHost.test.ts
  - apps/web/src/host/hostCommandBridge.ts
  - apps/web/src/host/hostCommandBridge.test.ts
  - apps/web/src/host/hostModelCredentialHost.ts
  - apps/web/src/host/hostModelCredentialHost.test.ts
  - apps/web/src/persistence/persistenceDrivers.ts
  - apps/web/src/persistence/persistenceDrivers.test.ts
---

# 固化 Web 两态契约

## 目标

使纯 Web 继续解析为 `static`。

## 上下文

`apps/web/src/host/resolveHost.ts` 当前导出：

```ts
export type HostKind = 'server' | 'static'
export type ResolvedHost =
  | { readonly kind: 'server'; readonly platform: HostPlatform }
  | { readonly kind: 'static'; readonly reason: StaticHostReason }
export async function resolveHost(options?: ResolveHostOptions): Promise<ResolvedHost>
```

`server` 由 `GET /api/health` 的 `platform` 握手识别；探测失败、超时、非健康或无效载荷都必须留在
`static`。`hostCommandBridge.ts` 只为 `server` 调 `configureHostInvoke`；`static` 不得注册空 bridge。
`hostModelCredentialHost.ts` 的生产 static 分支使用 `createBrowserModelCredentialHost()`；
`persistenceDrivers.ts` 的 static 分支使用 IndexedDB，server 使用 HTTP SQL executor。

Tauri 不改此联合类型：它加载 Node server URL 后自然进入现有 `server` 分支。执行者应补足可证明上述
不变量的测试或最小保护性重构；不可将 Tauri 名字、全局变量或依赖加入 Web 运行时代码。

## 接口

### 消费

- `ResolvedHost`：来自本任务 `resolveHost.ts`，050 用现有 `resolveHost()` 验证静态与 Tauri sidecar URL 的不同结果。

### 产出

- `HostKind = 'server' | 'static'`：供 040、050 消费；它是不可扩展为 `tauri` 的编译期边界。

## 验收标准

1. `pnpm exec vitest run apps/web/src/host/resolveHost.test.ts apps/web/src/host/hostCommandBridge.test.ts apps/web/src/host/hostModelCredentialHost.test.ts apps/web/src/persistence/persistenceDrivers.test.ts` → 全部通过，覆盖 static 无 bridge、server 有 bridge、两种持久化/凭据路径。
2. `rg -n "from ['\"]@tauri-apps/|import\(['\"]@tauri-apps/|HostKind\s*=.*['\"]tauri['\"]|kind:\s*['\"]tauri['\"]" apps/web/src --glob '*.{ts,tsx}'` → 无匹配。
3. `pnpm exec tsc -b` → 通过。

## 执行记录（仅编排者回写）

- 2026-08-21：执行完成；首轮审查拒绝了“新增断言”表述和注释误伤扫描。编排裁决后重新审查通过，见 `reports/010-review.md`。
