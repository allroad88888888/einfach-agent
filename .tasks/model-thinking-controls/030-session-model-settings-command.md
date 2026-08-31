---
id: "030"
title: 持久化当前会话模型设置
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
  - packages/agent-core/src/runtime/commands/modelSettingsCommands.ts
  - packages/agent-core/src/runtime/commands/modelSettingsCommands.test.ts
  - packages/agent-core/src/runtime/commands.ts
  - packages/agent-core/src/index.ts
---

# 持久化当前会话模型设置

## 目标

原子更新当前会话的模型设置。

## 上下文

`SessionMeta.settings` 已是恢复快照的一部分，`persistSessions()` 会写 IndexedDB/SQLite；缺少的只是 UI
可调用的 mutation command。`sessionCommands.ts` 已负责 CRUD 且 147 行，本用例放独立
`modelSettingsCommands.ts`，不把另一项职责塞回 CRUD。

新增绑定 CoreInstance 的 `setActiveSessionModelSettings(next)`，返回可判定结果，例如
`updated|unchanged|missing|busy`：

- 无 active session → missing，不写盘；
- 结构等价 → unchanged，不改 updatedAt、不写盘；
- 当前 session 的 run 处于 running、awaiting_tool 或任一等待/中断恢复状态 → busy，不修改；
- 可修改时一次替换完整 `ModelSettings`、更新 updatedAt、调用 `persistSessions()` → updated。

命令层保持 provider-neutral，不校验 DeepSeek/GLM 字面量；045 负责交互转换，020 负责 wire 防线。不得
修改 `defaultCore.config.defaultModelSettings`，不得把设置写进 session agent store 或 UI store。

## 接口

### 产出

- `setActiveSessionModelSettings()` 与结果类型：050 消费。
- 会话独立性、busy 拒绝、no-op 和持久化测试：060 消费。

## 验收标准

1. `pnpm exec vitest run packages/agent-core/src/runtime/commands/modelSettingsCommands.test.ts` → success/no-op/missing/busy、updatedAt、persist 调用次数和两个会话隔离全部通过。
2. 测试包含 vendorSettings.connectionId/reasoning_effort 的完整保留，证明命令不丢 opaque bag。
3. `pnpm --filter @einfach-agent/core build && pnpm check:state && pnpm check:boundaries && git diff --check` → 通过。
4. 新命令与测试各自不超过 300 行；不扩写已接近上限的 CRUD 测试文件。

## 执行记录（仅编排者回写）

- 2026-08-21：执行者验收全部通过；独立审查 APPROVE，无 findings。
