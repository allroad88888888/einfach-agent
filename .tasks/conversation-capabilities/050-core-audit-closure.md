---
id: "050"
title: 关闭核心安全与覆盖缺口
kind: leaf
parent: "300"
depends_on: ["040"]
discovered_from: "040"
model: gpt-5.6-sol
status: done
created: 2026-09-08
base: 0fb3afbdf656df7184134075887aa414eb348828
files:
  - packages/agent-core/src/state/sessionCapabilityPolicy.ts
  - packages/agent-core/src/state/sessionCapabilityPolicy.test.ts
  - packages/agent-core/src/state/sessionCapabilityHydration.ts
  - packages/agent-core/src/state/sessionCapabilityHydration.test.ts
  - packages/agent-core/src/state/persistence/hydrate.ts
  - packages/agent-core/src/state/persistence/hydrate.sessionCapabilities.test.ts
  - packages/agent-core/src/runtime/turnToolVisibility.ts
  - packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts
  - packages/agent-core/src/runtime/sessionCapabilityDelegation.test.ts
  - packages/persistence-idb/src/sessionsPersistence.test.ts
  - packages/persistence-sqlite/src/sqliteDriver.test.ts
  - .tasks/conversation-capabilities/reports/050-report.md
---

# 关闭核心安全与覆盖缺口

## 目标

修复 040 发现的 Sessions hydrate 畸形策略 fail-open，并补齐并发首发、锁定生命周期与子代理 Skill 的直接回归。

## 必须实现的语义

- 缺失 `capabilityPolicy` 仍是合法 legacy-unrestricted；字段存在但 version 未知、key/shape 非法、名字非规范、
  `null` 或任意畸形值必须 fail closed，不能退化成 legacy，也不能把其中 allowlist 当真。
- 在 central hydrate 边界增加单一职责 sanitizer。合法 v1 原样保留；非法字段转成明确、可持久化的 v1
  locked-empty 安全策略，UI 只读、业务工具/Skill 全拒绝，控制工具仍按既有协议规则可用。
- `captureRunCapabilitySnapshot` 与纯 allow/version helper 本身也要防御未知运行时对象：即使绕过 hydrate
  直接注入 atom，也不得抛错或放行畸形 allowlist。
- recovery v1 的严格 codec 语义不放宽；recovery 有合法静态 meta 时仍按既有优先级恢复。
- SQLite、IndexedDB 证明合法 v1 policy 能完整 round-trip；sessions-only hydrate 证明非法/未来 policy
  进入内存后变成 locked-empty，合法 legacy 保持缺字段。
- 增加同会话两个并发首发直接测试：只锁一次稳定 allowlist，后续发送只 started/queued，不发生二次扩权。
- 增加 stop、undo/redo（或仓库等价 rollback 路径）后 policy 仍 locked、toggle 仍拒绝的直接测试。
- 增加子代理 Skill 直接测试：profile/child registry 不得暴露或执行 `skill_search`/`skill_read`；若未来 profile
  开放这些控制工具，也必须消费父 run 的 `skills` snapshot，不得扩大。测试不能只靠读源码推断。

## 文件职责

- `sessionCapabilityHydration.ts` 只做持久 SessionMeta 的 capability 字段净化。
- 纯策略文件只做 runtime-safe 判断/安全 sentinel；hydrate 接线仍留在 `hydrate.ts`。
- 测试分别留在策略、hydrate、命令生命周期、delegation 与载体 round-trip 的既有责任面。

## 验收标准

1. 040 恶意 `{version:2,state:'locked',allowedTools:['secret']...}` 复现变为 tool=false、skill=false，且不抛。
2. 合法 v1/legacy/非法/未来/额外 key/非规范 name 经 sanitizer 与 sessions hydrate 的表驱动测试闭合。
3. SQLite/IDB round-trip、recovery 优先与 sessions-only hydrate 相关测试全绿。
4. 并发首发、stop/undo/redo 锁定不回退、child Skill 空子集有直接测试。
5. 相关 Vitest、`pnpm exec tsc -b --pretty false`、`git diff --check`、声明文件 `wc -l` 全绿。
6. 写 `reports/050-report.md`；不得 commit，不得修改任务外文件。

## 执行记录（仅编排者回写）

- 2026-09-08：由 040 的 C-003/C-004/C-009/C-010/C-012 缺口发现。
- 2026-09-08：已派发执行。
- 2026-09-08：执行报告 DONE，独立复核 APPROVED；编排者复跑 7 files / 58 tests、TypeScript 与 diff-check 通过，任务完成。
