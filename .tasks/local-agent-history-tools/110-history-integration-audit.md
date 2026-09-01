---
id: "110"
title: 完成跨 agent 集成审计
kind: leaf
parent: "5000"
depends_on: ["070"]
discovered_from: null
model: gpt-5.6-sol
status: cancelled
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/history/historyQuery.global.integration.test.ts
  - packages/host-node/src/history/historyLegacy.integration.test.ts
  - packages/host-node/src/history/historySearch.integration.test.ts
  - apps/cli/src/historyCapability.integration.test.ts
  - apps/web/src/persistence/serverAgentHistoryCapability.integration.test.ts
  - packages/agent-core/src/subagents/runtime.agentHistory.integration.test.ts
  - tools/agents/src/historyTools.integration.test.ts
---

# 完成跨 agent 集成审计

已并入 070 的独立端到端复审，避免为同一交付再开启一个测试叶。

## 目标

只新增分场景黑盒测试，证明交付的是“任意 agent 查询任意本机 canonical history”。

## 场景

1. 真实临时 app-data/SQLite 写入多个 conversation 的 root/child；global list/items/read 跨原 workspace。
2. root/child running 与 done/stopped/error 的 status/complete；root update/reorder/delete/tombstone。
3. Unicode 20k read chunk、page 100k 截断、正常 keyset 与 append 后 stale cursor。
4. recovery-only legacy root；当前 locator 的旧 child assistant/tool trace；坏行 warning；canonical target 优先。
5. FTS all/target/roles/rank/snippet，event upsert/delete，bounded lag，probe fail，drop/rebuild。
6. source corruption fail-closed；projection/search-index failure 分类；legacy warning不能掩盖 canonical fatal。
7. Server HTTP 四 command、CLI direct shared driver/provider、static unavailable。
8. root 与 delegate_only/workspace_read/workspace_verify child 实际执行四工具读取 root/sibling/descendant，无 ACL fixture。
9. registry 只注册一次、四项 replay-safe；删除五表+FTS 后只靠 JSONL 重建，查询深等价。

测试必须经过公共 capability/host/tool/runtime 边界与真实临时文件/SQLite；不得 mock 私有 projector/query SQL，
不得用 sleep 等待索引或锁。单文件超过 300 前按上面场景职责拆，不能创建 part1/part2。

## 验收

1. index C01–C15 每行在 report 中指向具体测试名；缺口必须 FAIL，不能引用口头说明。
2. 本叶定向 suite 连跑三次，无 timestamp/lock/FTS flaky。
3. `pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state`、相关 workspace tests、`git diff --check` 通过。
4. 扫描 production history/tool 路径，无 `permission|approval|historyScope|ancestor` 访问限制；否定文档和既有危险工具逻辑不算命中。
5. 所有本树新增/大改普通文件 `wc -l <=300`；独立 reviewer 报告列 FTS row counts/watermarks、JSONL checksum、
   canonical/legacy 命中数与未覆盖风险。

## 失败路由

- 合同/文本/cursor 类型 → 020；canonical list/items/read → 030；legacy → 040；FTS → 050。
- warning 合并/routes → 060；Web/CLI/ToolContext → 070；tool schema/registry → 080；child gate → 090。
- 本叶禁止修产品代码；发现缺陷写报告并由编排者重开 owner 叶。
