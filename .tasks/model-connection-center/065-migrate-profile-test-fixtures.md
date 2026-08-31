---
id: "065"
title: 迁移连接契约测试夹具
kind: leaf
parent: "300"
depends_on:
  - "030"
discovered_from: "060"
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/settings/modelConnectionProfileCommands.test.ts
  - apps/web/src/settings/settingsCenterCommands.test.ts
---

# 迁移连接契约测试夹具

## 目标

让遗留测试夹具使用多模型连接契约。

## 上下文

010 将 public profile 从 `model: string` 迁移到 `models: readonly ConnectionProfileModel[]`；030 已迁移
生产 settings 命令。060 执行 `pnpm exec tsc -b --pretty false` 时只剩三处测试夹具错误：

- `modelConnectionProfileCommands.test.ts` 的数组推断把首个 `source` 过窄为 `'discovered'`，后续
  `'manual'` 模型无法赋值；
- `settingsCenterCommands.test.ts` 的 profile fixture 仍写旧 `model`；
- 同文件的 draft patch 仍写旧 `model`。

本卡只迁移这些 fixture/测试输入：用显式 `ConnectionProfileModel` 数组或必要的宽化使 `source` 保持
`'manual' | 'discovered'`；profile 改为非空 `models`；draft patch 改为 `models`。不得改生产实现、
断言语义、host/transport/UI，也不得为了类型通过将类型改为 `any`、宽泛 string 或断言绕过。

## 接口

### 消费

- 010 的 `ConnectionProfileModel` 与 030 的多模型草稿/save contract。

### 产出

- 可被全仓 TypeScript 构建的遗留测试夹具：060 R1 与 070 消费其通过结果。

## 验收标准

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/settings/settingsCenterCommands.test.ts` → 两个既有测试文件通过，原断言语义未弱化。
2. `pnpm exec tsc -b --pretty false` → 通过。
3. `git diff --check` → 通过；两文件均不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-21：由 060 全仓 tsc 的范围外 fixture 发现创建并派发。
- 2026-08-21：执行完成，等待独立审查。
- 2026-08-21：独立审查通过；fixture 未弱化断言或绕过类型。
