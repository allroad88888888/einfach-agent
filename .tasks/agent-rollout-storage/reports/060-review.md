# 060 独立审查

结论：**REVIEW_FAIL**

## Findings

### Important

1. 跨会话输入会把旧会话 item 的 tombstone 写入新会话 target。
   `buildRootRolloutDelta` 无条件以 `current.sessionId` 构造输出 target（实现 74 行），却仍以
   `previous` 的 items 计算删除集合（83、92–96 行）。因此 `previous.sessionId !== current.sessionId`
   时，旧会话缺失的 item 会生成指向新会话的 `item_deleted`。函数签名没有声明“两个 snapshot
   必须同 session”的前置条件，也没有守卫；安全语义应把 target 变化视作首次 backfill，或显式拒绝。
   这会在调用方状态意外跨会话复用时污染另一条 append-only 历史，属于数据正确性问题。

2. `planStageId` 的独立变化没有验收证明。
   唯一相关测试同时把 `pending: true → false` 和 `planStageId: stage-1 → stage-2`（测试 73–79 行）；
   即使实现完全忽略 `planStageId`，该测试仍会因 pending 变化而通过。任务目标明确要求覆盖
   pending/plan stage 变化，需增加只改变 `planStageId` 的用例；最好也把 pending finalization
   保持为独立用例，防止比较字段回归。

### Minor

1. `stableJson` 用无 locale 参数的 `localeCompare` 排键（实现 9–12 行）。它用于相等性比较时在
   单一进程内通常稳定，但其排序规则由运行时 locale/ICU 决定，不是严格的跨环境规范序；若这里
   被视作“稳定序列化”基础，建议改用代码点序比较（`left < right ? -1 : ...`）。当前输出 mutation
   并不直接包含该序列化字符串，因此此项不单独构成功能失败。

## 验收逐条证据

1. **部分满足**：首次 capture 的实现路径固定发出 `session_meta`、`turn_context`、current 顺序的
   全量 `item_upsert`、`run_state`（实现 77–101 行），测试 30–44 行覆盖 Unicode、tool call、字段
   规范化及顺序；等价 capture 空 batch 由测试 46–52 行覆盖。但跨 session 时没有首次 backfill
   隔离，见 Important 1。
2. **部分满足**：append（54–62）、update（64–71）、reorder（82–93）、delete（95–105）均有独立
   用例；pending/plan stage 合并在一个用例，不能独立证明 plan stage 比较，见 Important 2。
3. **满足（静态证据）**：输出阶段顺序由 meta/context（80–81）、current item upsert（85–91）、
   tombstone（92–98）、run state（100–101）固定；`stableJson` 消除普通对象键插入顺序造成的伪更新，
   测试 46–52 行验证；实现没有写入 snapshot，测试 43 行验证 pending normalization 未反写输入。
   Unicode/tool item 在首次回填用例覆盖。
4. **执行报告证据**：执行者报告定向 Vitest 通过（7 tests）；按要求本审查未重跑。报告中的
   `tsc -b` 失败文件 `packages/host-node/src/rollout/jsonlStore.test.ts` 不在本任务 frontmatter
   `files`，且当前为另一并行任务的 untracked owner，确认 concern 属本叶并行范围外；但总门仍需
   后续集成阶段恢复通过。
5. **满足**：实现 103 行、测试 106 行，均低于 300 行；实现只做 recovery delta，测试只验证该
   delta，职责单一。实现仅依赖类型和局部纯辅助函数，无 atom、时钟、singleton 或 persistence
   driver。

## 范围与方法

- 实际产品/测试文件仅审查 frontmatter 指定的两个 owners。
- 未修改产品代码，未重跑执行者测试，未派子 agent。

---

## R1 复审

结论：**REVIEW_PASS**

本轮只核验上轮两项 Important 与一项 Minor；未发现由这些修复引入的新增 Critical/Important。

1. **跨 session fail-fast：已修复。** 实现 74–76 行在创建 `historyTarget`、mutation 数组及任何
   mutation 之前检查 `previous.sessionId !== current.sessionId` 并抛出。测试 54–61 行使用不同
   session 且两侧均有 item，验证拒绝路径；更新后的任务与 index 也明确裁决 coordinator 必须在
   会话切换时清空 previous，行为与合同一致。
2. **pending / planStage 独立证明：已修复。** 测试 82–89 行仅改变 pending，保持 plan stage
   不变；测试 91–98 行仅改变 plan stage，保持 pending 不变。两个字段各自缺失比较时都会有独立
   用例失败，消除了上一轮的测试盲区。
3. **代码点排序：已修复。** `stableJson` 在实现 9–12 行使用 `<` / `>` 的确定代码单元序比较，
   已移除依赖 locale/ICU 的 `localeCompare`。

执行报告记录 R1 定向 Vitest 9 tests、TypeScript、boundaries、state 与 diff check 均通过；按复审
要求未重跑。当前实现 106 行、测试 124 行，仍满足单一职责与 300 行限制。复审未修改产品代码。
