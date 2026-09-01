---
id: "110"
title: 同步最终回归契约
kind: leaf
parent: "5000"
depends_on: ["100"]
discovered_from: "final-full-suite"
model: gpt-5.6-terra
status: done
repair_round: 1
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - scripts/check-boundaries.test.js
  - packages/host-node/src/commandNames.ts
  - packages/host-node/src/commandNames.test.ts
---

# 同步最终回归契约

## 目标

修正全仓测试在 rollout 新公共面与 host command 注册后暴露的两个陈旧精确计数契约，不修改产品代码。

## 验收标准

1. boundary 自测准确反映 `@einfach-agent/core/history` 加入后十条公共 subpath 白名单，并仍证明白名单外路径失败。
2. host command 自测准确反映两个 rollout command 加入后的 42 条唯一命令，并在说明中列清新增职责。
3. `pnpm exec vitest run scripts/check-boundaries.test.js packages/host-node/src/commandNames.test.ts` 通过。
4. `pnpm check:boundaries`、`git diff --check` 通过，两个 owner 均不超过 300 行。

## 禁止项

- 不放宽任何边界规则，不删减命令唯一性断言。
- 不修改 owner 之外的产品或测试文件。
