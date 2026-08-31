---
id: "050"
title: 验证三种运行模式
kind: leaf
parent: "300"
depends_on:
  - "010"
  - "040"
discovered_from: null
model: gpt-5.6-sol
status: failed
superseded_by: "052"
created: 2026-08-21
done: null
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/desktop/tests/threeModeSmoke.test.mjs
  - apps/desktop/tests/desktopStaticGuard.test.mjs
  - apps/desktop/tests/webCapabilityStaticAnalysis.mjs
  - scripts/check-desktop-wrapper.mjs
---

# 验证三种运行模式

## 目标

证明 Tauri 使用 server runtime。

## 上下文

010 保证 Web 仍只有 `server | static`。040 会打包 Node server sidecar。测试不得依赖真实 provider、
用户 home、签名密钥、已安装的全局 Node 或外网；可用临时目录和 `--port 0`。

纯 Web 不能启动 child，且 `resolveHost()` 面对不存在 `/api/health` 时必须成为 `static`。浏览器 server
与 Tauri child server 均要让 `/api/health` 返回已有的 server health payload，随后解析为 `server`。
测试还要静态禁止 Web source 从 Tauri API 或 rust `invoke` 获得业务能力。

`apps/web/src/plugins/pluginImportModule.ts` 是唯一允许运行时 `import(url)` 的生产入口：当前实现为
`const evaluate = options.evaluate ?? ((url: string) => import(/* @vite-ignore */ url))`。守卫须只放行该
箭头函数的**直接** `import(url)`，并验证 `url` 是该箭头函数的参数；其他不可静态求值的 `import()`、
任何 `require`/`require.resolve` 及其计算属性/别名全部拒绝。若 R3 增加规则会使现有 297 行守卫超限，
把 Web AST 分析提到 `webCapabilityStaticAnalysis.mjs`；`desktopStaticGuard.test.mjs` 保留 test/fixture 编排。

## 接口

### 消费

- `resolveHost(options)`：010 保证的 Web host 判定。
- `pnpm desktop:build` 的 bundle/resources：040 产物。

### 产出

```text
node scripts/check-desktop-wrapper.mjs
```

该命令退出码 0 只在三态证据完整时成立，供 060 的 CI 使用。

## 验收标准

1. `node apps/desktop/tests/threeModeSmoke.test.mjs` → 纯 Web 为 static，Node server 和 Tauri sidecar 均为 server，child 退出后端口不可用。
2. `node apps/desktop/tests/desktopStaticGuard.test.mjs` → AST 覆盖静态/动态 import、require、side-effect import 与 Tauri invoke 的成员/别名调用；Web 无 Tauri/Rust 业务通路，桌面错误/输出不保留 ready token。
3. `node scripts/check-desktop-wrapper.mjs` → 通过，且对 tracked、untracked 与 ignored 范围文件的字节快照均不变。

## 执行记录（仅编排者回写）

- 2026-08-21：R3 最终复审仍发现常量表不区分 mutation/词法 binding；三轮修复上限已用尽，任务失败，见 `reports/050-review.md`。
