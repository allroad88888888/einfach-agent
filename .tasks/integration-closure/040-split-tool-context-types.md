---
id: "040"
title: 按职责拆分工具上下文类型
kind: leaf
parent: "200"
depends_on: ["010", "020"]
discovered_from: "030"
model: gpt-5.6-sol
status: done
created: 2026-08-31
done: 2026-08-31
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/agent-core/src/tools/types.ts
  - packages/agent-core/src/tools/shellCommandTypes.ts
  - packages/agent-core/src/tools/visionToolTypes.ts
---

# 按职责拆分工具上下文类型

## 目标

把本次视觉能力新增后达到 352 行的 `tools/types.ts` 按领域类型职责拆回 300 行以内，同时保持公开类型路径兼容。

## 上下文

基线文件已为 309 行，但本次新增 43 行视觉类型，不属于“路过存量超限的小改”。按 one-file-one-thing
规则，将 Shell 命令值对象与视觉能力值对象分别拆到具名模块；`tools/types.ts` 继续承担工具总契约并 re-export，
现有 consumer 不应改 import 路径。禁止 `utils.ts`、part/数字后缀或只转发的假拆分。

## 验收标准

1. `types.ts`、`shellCommandTypes.ts`、`visionToolTypes.ts` 各自可用一句不含“和/以及”的话描述职责，均 ≤300 行。
2. `types.ts` 继续 re-export 原有 Shell 与 Vision 类型，现有 consumer 无需改动。
3. `pnpm exec tsc -b --pretty false`、agent-core 相关测试、state/boundary 与 `git diff --check` 通过。
4. 只做类型模块拆分，不改变运行时行为、schema 或协议字段。

## 执行记录（仅编排者回写）

- 2026-08-31：030 将 352 行文件列为存量超限；编排者依据本次 +43 行幅度与硬规则升级为必须拆分的发现叶。
- 2026-08-31：拆为 299/31/39 行，独立审查 APPROVED；编排者复跑 tsc 与 3 文件 29 测试通过。
