# 040 独立审查

结论：**REVIEW_FAIL**

审查范围仅限 040 frontmatter 的 4 个 owners；未重跑执行者测试，未修改产品代码，未派子 agent。

## Findings

### Critical

1. 首次 reconcile 没有固定 source 的 history/target identity，同一 JSONL 可被投影到多个 history，且 state 最终只绑定最后一个 history。

   - `projector.ts:133` 只在进入函数时读取一次 state；新 source 的 `state` 始终为 `undefined`。循环中的一致性检查又只在 `state` 存在时执行（147–149 行），首条 record 得到的 `historyId` 没有成为后续 record 的约束。
   - 因而一个新文件可依次包含 `history-A ordinal 0`、`history-B ordinal 1`：ordinal 检查会因使用全文件 `applied` 而通过（151–154 行），两条记录分别写进两个 catalog/events，projection state 则在第二条被更新为 `history-B`（158–164 行）。之后 reconcile 只承认 B，A 已被静默混投且无法由该 source state 正确描述。
   - 即使 historyId 相同，实现也从未验证每条 record 的 `target` 一致；catalog 冲突更新不更新 target 字段（35–44 行），所以 events/items 可包含与 catalog target 冲突的原始证据，查询投影会自相矛盾。
   - 这是 source-of-truth 到投影的身份完整性破坏，且 drop/rebuild 会稳定复现错误结果，不只是诊断缺失。

### Important

1. reconcile 将整个 append-only JSONL 读入内存，历史越长，单次 reconcile 的内存峰值越无界。

   - `projector.ts:1,134` 使用 `readFile(sourcePath)`，之后才从已投影 offset 开始扫描；即使只新增一条记录，也会重新载入完整历史。
   - source 被设计为永久追加且不 compact，因此成本为 O(total source bytes)，不是 O(unprojected bytes) 或固定窗口。超长 history 可造成进程内存压力/OOM，无法满足长 JSONL reconcile 的有界性要求。
   - 应从 `next_byte_offset` 以流式或有界 chunk 读取，并保留跨 chunk 半行；单条 record 仍应有 codec/line-size 上限。

2. catalog 的 `complete` 只会置 1，不会在新 run 开始或进入非终态时恢复为 0。

   - terminal `done/stopped/error` 在 `projector.ts:96–100` 设置 `complete=1`；其他 `run_state` 完全不更新 complete。
   - root history 可经历多轮 run。序列 `done(run-1) → running(run-2)` 后 turns 已显示 run-2 正在运行，但 catalog 仍是 `complete=1`，读侧会把活跃 history 错报为完成。现有测试只覆盖一次 `done`（`projector.test.ts:53,61–63`），没有覆盖终态后的新 run。
   - complete 应由最新适用的 run state 决定（终态为 1，非终态为 0），并保持 ordinal guard，避免旧 record 重放回退状态。

3. rebuild 测试没有证明验收要求的 catalog/items/turns/state 等价，多个关键错误没有回归保护。

   - `projector.test.ts:106–117` rebuild 前只保存 `history_id,title`，重建后只比较这两个字段，再检查 events/turns/state 的行数；该用例没有任何 item，也不比较 turn 内容、catalog target/complete/timestamps/ordinal 或 state offset/next ordinal。
   - 因此 item update/reorder/delete 的最终状态、turn/run 合并字段、complete、source identity 与 offset 即使在 rebuild 后变化，该测试仍可能通过。验收 4 明确要求重建得到相同 catalog、items、turns 与 state，应对各表的完整相关列做 before/after 深比较。

### Minor

无。

## 验收逐条核对

1. **部分通过**：五种 mutation 均有分支；item upsert 可更新 ordinal/JSON/pending/plan stage，delete 保留最后内容并置 tombstone，events 以 `(history_id, rollout_ordinal)` 去重。测试覆盖单 item 的 update/reorder/delete 和同 turn 的 context/run 字段合并；未覆盖 delete 后再 upsert、多个 run/turn，以及 complete 从终态回到活跃态，后者存在 Important finding。
2. **通过（静态证据）**：record 的 catalog/event/业务投影在 offset 前完成（`projector.ts:105–113,155–164`）；崩溃后同 ordinal event `DO NOTHING`，item/turn 用 last-change ordinal 幂等覆盖。执行者报告的 fault hook 位于业务 upsert 后、state 前，测试也检查 event/item 不重复；本审查未重跑。
3. **不通过**：不同 source 各自按 `source_path` 存 offset，半行停在行首并返回 path/offset；但新 source 在单次扫描中不约束同 history/target，见 Critical finding。ordinal 连续性只对整文件计数，不对固定 history identity 计数。
4. **部分通过**：drop 顺序仅删除五张 rollout 表，ensure 可重建，JSONL 未被修改；现有实现可从头重放。但测试未证明 catalog/items/turns/state 的完整等价，见 Important finding 3。
5. **有执行者证据**：报告称定向 Vitest 2 files / 4 tests、`tsc -b`、boundaries、state 均通过；依约未重跑。测试缺少 identity 混入、长文件有界、complete reopening 与完整 rebuild 等价。
6. **通过**：schema 76 行、schema test 41 行、projector 171 行、projector test 127 行；实现与测试按 schema/projector 职责分离，均低于 300 行。

## 修复门槛

- 首条 record 后立即固定 source 的 `historyId` 与完整 target；本次及后续 reconcile 的每条 record 都必须一致，并以该固定 identity 校验 ordinal。禁止 state 在同一 source 内改绑 history。
- 改为从 persisted byte offset 开始的有界流式/chunk reconcile，不整文件载入；正确处理 chunk 边界半行和超长单行。
- 用最新 run state（带 ordinal guard）同时维护 complete 的 0/1 转换，增加 terminal 后新 run 的测试。
- rebuild 前后深比较 catalog、items、turns、events 与 projection state 的相关完整列，并纳入 update/reorder/delete 和 turn/run 合并数据。

---

# R1 复审

结论：**REVIEW_FAIL**

本轮仅静态复审更新后的任务、index、执行报告、原 review 与 040 frontmatter owners；未重跑测试，未修改产品代码。

## Findings

### Critical

无。原 source identity Critical 已关闭，未发现 chunk offset、UTF-8 或并发 append 引入新的 Critical。

### Important

1. 行长上限只在当前 chunk 中没有换行时检查；带换行的超长完整行会先被 decode 甚至投影，绕过上限。

   - `projector.ts:206` 先把新 chunk 拼到 `pending`，207–230 行只要找到换行就立即取得整行、UTF-8 decode 并执行 `projectRecord`；直到内层所有完整行处理完，232–234 行才检查剩余 `pending.length`。
   - 若一条行在之前 chunk 累积到接近 `AGENT_ROLLOUT_MAX_LINE_BYTES`，下一 chunk 同时带来超限字节和换行，`newline` 会大于上限，但实现不会在 `decodeAgentRolloutRecord` 前比较 `newline`。合法但编码长度超过上限的 JSON record 因而可被投影；非法内容也会走 codec 错误而不是明确的受控 line-size corruption。
   - 当前测试 `projector.test.ts:121–133` 只写入无换行的 `max + 1` 个 `x`，恰好走外层剩余 buffer 检查，不能捕获带换行场景。
   - 修复应在处理每个 newline 前先校验 `newline <= AGENT_ROLLOUT_MAX_LINE_BYTES`（边界是否包含换行须与 store/codec 常量语义一致），再 decode/project，并增加超长、换行终止且跨 chunk 的测试。

### Minor

无。

## 原 findings 回归

1. **首次/跨次 history + target identity：关闭。** 新 source 首条记录立即成为 `identity`，之后每条都经 `assertIdentity` 比较 historyId 与 root/child 完整 target（`projector.ts:143–158,211–212`）。已有 state 通过 catalog 恢复 identity（160–175、197 行）；state UPSERT 也只在 history 相同时推进（220–225 行）。测试覆盖同次混 history 与后续 reconcile 漂移 target（`projector.test.ts:90–119`）。
2. **offset 起点有界 chunk read：部分关闭。** 从 persisted offset 打开并按固定 chunk 读取（`projector.ts:180–205`），`offset` 始终指向 pending 行首，完整行以 byte newline 推进（219、227–230 行），只在完整 byte line 后做 UTF-8 decode，因此多字节字符跨 chunk 不会被拆坏。打开时取得 size 快照（189–203 行），并发 append 的新尾留到下一次 reconcile，不会让本次 offset 越过未读数据；半行返回原行首 offset（239–241 行）。内存由最大行加 chunk 限制，但带换行的超长行未在 decode 前拒绝，见 Important finding。
3. **complete terminal ↔ running：关闭。** 每个 run_state 都将 terminal 映射为 1、其他状态映射为 0，并用 catalog last ordinal guard 防止旧重放回退（`projector.ts:112–116`）；测试覆盖 `done → running` 后 `complete=0`（`projector.test.ts:68–77`）。
4. **rebuild 深比五表：关闭。** fixture 包含 item update/reorder/delete、turn context 与 run state 合并（`projector.test.ts:159–168`）；drop 前后通过 `SELECT *` 对 catalog/items/turns/events/state 五表完整排序快照深比较（40–47、181–187 行）。

## R1 修复门槛

- 在任何完整行 decode/project 前执行 line byte-length 上限检查，并覆盖“超长 + newline + 跨 chunk”测试；不得仅检查处理完完整行后的 leftover buffer。

---

# R2 复审

结论：**REVIEW_PASS**

本轮只静态核验 R1 残留的 newline-terminated 超长行问题；未重跑测试，未修改产品代码。

## 核验证据

- **decode/project/state 前拒绝：通过。** `projector.ts:207–213` 取得 newline 的 byte index 后，先以 `newline > AGENT_ROLLOUT_MAX_LINE_BYTES` 抛出带 source path/offset 的错误，之后才构造 line 并调用 `decodeAgentRolloutRecord`。identity、ordinal、`projectRecord` 与 projection state advance 均位于检查之后（214–228 行），所以 `max + 1` byte 完整行不会产生业务投影或推进 offset。
- **跨 chunk 边界：通过。** `projector.test.ts:121–132` 写入精确 `AGENT_ROLLOUT_MAX_LINE_BYTES + 1` 个 byte 后追加 newline，并配置 4097-byte chunk；该行必然跨越多个 chunk，最终 newline index 为 `max + 1`，断言命中明确的 line-size 错误。
- **五表零写：通过。** 同一测试在 reject 后逐一查询 catalog、events、items、turns、projection state，全部断言 count 为 0（`projector.test.ts:133–137`）。schema ensure 只建表，不写行，因此该断言直接证明拒绝发生在 decode 后续 projection/state 路径之前。
- **上限边界保持正确。** 条件使用 `>`，允许恰好 `max` byte 的 record，拒绝 `max + 1`；newline 本身不计入 JSON record byte 长，与现有常量的 line payload 语义一致。检查基于 Buffer 的 byte index，不受 UTF-8 字符数影响。

## Findings

### Critical

无。

### Important

无。R1 唯一残留 finding 已关闭，未发现这处修复引入新的 Critical/Important。

### Minor

无。
