---
id: "040"
title: 审计跨层覆盖与回归门
kind: leaf
parent: "300"
depends_on: ["020", "030"]
model: gpt-5.6-sol
status: done
created: 2026-09-08
base: 0fb3afbdf656df7184134075887aa414eb348828
files:
  - .tasks/conversation-capabilities/reports/040-report.md
---

# 审计跨层覆盖与回归门

## 目标

作为独立审计叶，不改产品代码，逐项证明覆盖矩阵 C-001 至 C-015 已由代码、测试和机械门闭合。

## 审计方法

- 阅读 index、010/020/030 task、report、review 与完整工作区 diff；不要依赖执行者的结论。
- 对每个覆盖项列出生产文件与行号、测试文件与具体 case。没有直接证据的项标为 GAP，不能用“看起来会工作”代替。
- 特别追踪所有绕过路径：提示 manifest、lazy schema、顶层 tool dispatch、递归 `callTool`、Skill 直接读、
  built-in/project/user 名字、子代理、legacy、恢复、并发首发、插件/host/workspace 上界。
- 检查新增/大改文件单一职责和物理行数；检查未声明修改、stash/main 边界与固定文案 i18n。
- 复跑相关定向测试以及全仓 `pnpm test`、`pnpm build`、`pnpm check:state`、
  `pnpm check:boundaries`、`git diff --check`。禁止真实模型或外部服务。

## 输出要求

- 只写 `reports/040-report.md`，结论必须是 `DONE` 或 `BLOCKED`。
- 报告含覆盖矩阵逐项证据、机械门原始摘要、行数表、未声明 diff、风险与建议。
- 任一安全绕过、持久化不兼容、UI 可改但命令未锁、缺失主要状态或红色机械门都必须 `BLOCKED`，
  并给出可直接转成新叶任务的最小修复范围；不得自己改产品代码。

## 验收标准

1. C-001 至 C-015 每项有直接证据或明确 GAP。
2. 所有指定机械门有实际运行结果，不引用旧报告代替。
3. 报告写入 `reports/040-report.md`；不得 commit。

## 执行记录（仅编排者回写）

- 2026-09-08：依赖 020、030，当前阻塞。
- 2026-09-08：020、030 均已验收，解除阻塞。
- 2026-09-08：已派发独立审计。
- 2026-09-08：审计结论 BLOCKED，发现 050/060 修复叶与 070 最终复核叶；详见 `reports/040-report.md`。
- 2026-09-08：阻断项由 050/060 修复，并经 070 最终审计全部验证通过，闭环完成。
