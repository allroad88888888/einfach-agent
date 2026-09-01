---
id: "100"
title: 审计并发、崩溃与回填
kind: leaf
parent: "5000"
depends_on: ["080", "090"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 1
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/rollout/rolloutRecovery.integration.test.ts
  - packages/agent-core/src/runtime/agentRollout.integration.test.ts
---

# 审计并发、崩溃与回填

## 目标

以只新增集成测试的方式审计整棵树，重点攻击跨进程并发、故障窗口、旧会话回填与删除语义。

## 审计场景

1. 两个独立 node process 模拟 server/CLI，对同一 root history 各写多批，验证 JSONL 连续且投影等价。
2. 在 source fsync 后、projection 前终止；新进程 reconcile 后 items/events/state 不重不漏。
3. 删除全部 projection tables；offline rebuild 后与故障前业务投影相同。
4. 从只有 SQLite recovery snapshot 的旧 root 启动；首次 capture 回填，第二次启动不重复。
5. root update/reorder/delete 与 child system/user/assistant/tool/synthesis 在重启后保持顺序和 tombstone。
6. session recovery delete 与 undo generation 变化不触碰 rollout 文件。
7. static no-driver 执行路径仍通过，不生成虚假的 `complete:true` rollout。

## 验收标准

1. 新集成测试不用实现内部私有函数的 mock，必须经过 driver/coordinator 公共边界和真实临时文件。
2. 覆盖矩阵 C01–C13 均能指向本叶或前序叶的具体测试；缺口写入 review，不能口头放过。
3. 定向 tests 连跑三次无 flaky lock/timestamp 依赖。
4. `pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state`、相关 workspace tests 全通过。
5. `find` + `wc -l` 证明本树新增/大改普通文件均满足 300 行规则；复杂文件例外必须逐项有理由。
6. 独立 reviewer 报告写 `reports/100-review.md`，列出 JSONL checksum、projection row counts 与未覆盖风险。

## 禁止项

- 本叶不修产品代码；发现缺陷就报告并把对应前序叶重开。
- 不以 sleep 碰运气等待锁，测试必须使用可观察 barrier/child-process IPC。
