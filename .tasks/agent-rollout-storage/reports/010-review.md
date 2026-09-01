# 010 独立审查

结论：**REVIEW_FAIL**

审查口径：仅审查 010 frontmatter `files` 声明的产品/测试文件，并对照任务树、030/060 合同和执行报告。未修改产品代码，未重跑执行者的 Vitest。

## 验收证据

- ✅ 合同入口与文件边界：`packages/agent-core/src/history/index.ts:1-22` 从独立 `history` subpath 导出 target、五类 mutation、record、driver 和 codec；`packages/agent-core/package.json:57-60`、`packages/agent-core/tsup.config.ts:22`、`scripts/check-boundaries.js:75-77` 已同步公开 export、构建 entry 与 boundary allowlist。root `src/index.ts` 仍为 299 行且相对 base 无 diff。
- ✅ target/driver 基本合同：`agentHistoryTarget.ts:1-8` 精确区分 root/child；`rolloutMutation.ts:92-99` 的 driver 只有 `append(target, mutations)`、`reconcile()`、`flush()`，没有 raw path、delete/prune/compact 接口，适合 030 从逻辑 target 映射物理路径。
- ❌ 060 消费合同不完整：现有 `ConversationItem` 的状态层事实包含 `pending?: boolean` 和 `planStageId?: string`（`packages/agent-core/src/state/core.type.ts:48-57`），060 明确要求这两类变化生成同 item id 的 upsert；但 `AgentItemUpsertMutationV1` 仅有 `itemId/itemOrdinal/createdAt/item`（`rolloutMutation.ts:32-39`），codec 也只接受这些字段（`rolloutRecordCodec.ts:185-187`）。因此前后快照只有 pending/plan stage 改变时，060 无法编码变化后的值，投影/重建也无法恢复它；这不满足“root recovery 增量”和后续可重建查询投影的合同。
- ✅ codec 对当前已定义字段是 fail-closed：顶层及嵌套对象使用精确 key 白名单（`rolloutRecordCodec.ts:21-33`），拒绝未知 schema、负/非安全整数 ordinal、非规范 UTC ISO 时间、非法/缺失 target 字段、未知 mutation/status/ModelItem role、多物理行与超大 UTF-8 行（`rolloutRecordCodec.ts:41-55,62-78,101-165,173-215`）。没有 `unknown` record 穿透公开返回类型。
- ✅ 当前 `ModelItem` 四角色结构与 codec 校验一致：对照 `packages/agent-ai/src/modelProtocol.ts:13-61`，system/user/assistant/tool 的必需与可选字段均被逐项覆盖；编码先 stringify 再走同一严格 decoder（`rolloutRecordCodec.ts:218-221`），可保持 JSON 可表示的原始 ModelItem 与 Unicode。
- ✅ 单行与有界数据合同适合 030：公开 `AGENT_ROLLOUT_MAX_LINE_BYTES` 为 1 MiB（`rolloutRecordCodec.ts:6-7`）；decoder 拒绝 CR/LF，encoder 返回不含换行的一条 JSON 文本，030 可在锁内为 batch 统一追加换行并 fsync。
- ✅ 执行者报告的定向验证有对应证据：报告记录 history Vitest 2 files / 8 tests、boundary 与 diff-check 通过；审查未重复运行这些测试。测试源码确实覆盖五类 mutation round-trip、Unicode/tool call、未知 schema、负 ordinal、非法 recordedAt、超大行、多行和深度上限（`rolloutRecordCodec.test.ts:19-60`），child 缺字段另有用例（`agentHistoryTarget.test.ts:5-17`）。
- ❌ 构建验收当前未通过：独立复现 `pnpm --filter @einfach-agent/core build`，tsup 成功产出 `dist/history/index.js`，随后声明构建在 `src/state/persistence/modelMigration.ts:25` 报 TS2322。阻塞确属 010 owner 范围外且在任务 base 已存在：base `d884093...` 已含该行；当前 `packages/agent-ai/dist/deepseek.d.ts:18` 仍声明 `'high' | 'max'`，而 base/source 已要求 `'low' | 'high' | 'max'`，属于依赖 dist 陈旧的基线构建状态，不是本任务 history diff 引入。故报告对阻塞归因准确，但验收标准 4 仍只能记为未通过。
- ✅ 文件组织与行数：新增产品文件分别为 9、100、222、23 行，测试为 19、61 行，均不超过 300 行；target、mutation/driver、codec、public barrel 职责分离，没有 `part1`/`xxx2`/新增大杂烩。`rolloutRecordCodec.ts` 虽为 222 行，但单一职责是 v1 record 的严格编解码。
- ✅ 禁止项：所审范围未实现路径、SQLite、搜索、旧 trace 兼容、删除或压缩逻辑。

## 质量发现

### Critical

1. `item_upsert` 丢失 `pending` 与 `planStageId`，使 060 指定的两类更新不可表达、不可投影、不可从 JSONL 重建。修复应在 mutation 类型、严格 codec 和 round-trip/非法字段测试中同时补齐这两个状态层字段，并明确 absent/false 与 absent/value 的规范表示。

### Important

无额外发现。

### Minor

1. 构建失败确为范围外基线/依赖产物问题，但它意味着公开 subpath 的 `.d.ts` 尚未由完整 build 产出验证。010 修正合同后，应先按仓库拓扑刷新 `@einfach-agent/ai` dist，再重跑 core build，避免把陈旧依赖声明继续当作长期豁免。

## 最终判定

严格 codec、公开 subpath 和 030 所需的单行/大小边界整体成立；但公开 mutation 合同无法承载 060 明确要求追踪的 `ConversationItem` 状态变化，属于下游无法补救的合同层缺陷。故本任务不能验收，回执 **REVIEW_FAIL**。

---

## R1 复审

结论：**REVIEW_PASS**

复审范围仅为原 Critical 的关闭情况，以及 R1 是否新增 Critical/Important；未重跑执行者测试。

- ✅ 类型合同已关闭缺口：`rolloutMutation.ts:32-41` 的 `AgentItemUpsertMutationV1` 现在必填 `pending: boolean` 与 `planStageId: string | null`，060 可把 `ConversationItem` 的 absent 值先规范化为 `false`/`null`，并把后续 pending/plan stage 变化编码成可投影、可重建的 upsert。
- ✅ 严格 codec 与规范化边界一致：`rolloutRecordCodec.ts:190-209` 把两字段列入 `exactKeys` 的 required 集合，分别用严格 boolean 与 nullable non-empty string 校验；codec 不为缺字段隐式制造默认值，producer 负责 absent → `false`/`null`，因此同一语义只有一种 record 编码。`boolean()` 接受 `false`，`nullableString()` 接受 `null`（`rolloutRecordCodec.ts:51-64`）。
- ✅ 测试覆盖与合同一致：五类 mutation round-trip 的 `item_upsert` 已包含 `pending`/`planStageId`（`rolloutRecordCodec.test.ts:19-45`）；两字段缺失均被断言拒绝（`:80-84`），字符串伪 boolean 与 boolean 伪 planStageId 均被断言拒绝（`:86-94`）。规范值 `false`/`null` 也用于测试 record（`:67-76`），与公开类型和 decoder 接受域一致。
- ✅ 无新增 Critical/Important：R1 改动局限于 mutation 字段、对应 codec 分支及定向测试，没有扩大 driver、路径或 I/O 职责。产品文件最大 `rolloutRecordCodec.ts` 244 行，仍低于 300 行；root `src/index.ts` 保持 299 行。

原 Critical 已关闭；原 Minor（范围外基线构建产物问题）不影响本次仅针对 Critical/Important 的复审判定。最终回执 **REVIEW_PASS**。
