# 005 R1 独立复审

## 回执

**APPROVED**

R1 已关闭首审唯一 Important：legacy items/search v1 cursor 现在按 target 语义而非 target 属性插入顺序绑定 filters。未发现新的 Critical、Important 或 Minor。

## Findings

### Critical

无。

### Important

无。

### Minor

无。

## 原 Important 关闭证据

### 1. old/current filters 的 target 在比较两侧均被语义 canonicalize

- `stable()` 保留既有 filters 展开和 roles 去重排序，但会用 `decodeAgentHistoryTarget(value.target)` 覆盖 target（`packages/host-node/src/history/historyServiceCursor.ts:13-18`）。共享 decoder 对 root 固定重建 `{ kind, conversationId }`，对 child 固定重建 `{ kind, conversationId, runId, agentPath }`，因此 target 内部的原始属性插入顺序不再进入 cursor identity。
- 解码比较仍是 `stable(value.filters) !== stable(filters)`（`historyServiceCursor.ts:32-35`），所以 parsed pre-upgrade filters 与 current expected filters 都经过同一条 canonicalization；修复不是只规范化新请求一侧。
- canonicalization 只消除 target 属性顺序差异。target 的 kind/字段值仍由 exact shared decoder 校验；query、includeDeleted 等其他 filter 值仍保留在 JSON 比较中；roles 的 set/sort 语义与 base 一致。实际 changed filters 仍会被拒绝。

### 2. v1 envelope 与拒绝边界保持

- encoder 仍生成 `{ v: 1, kind, filters, offset }` 并使用 base64url（`historyServiceCursor.ts:20-22`），没有改 cursor 版本或外围形状。
- decoder 仍先执行 100,000 字符上限，再要求 canonical base64url；随后要求 envelope exact keys、`v === 1`、请求 kind 相同、offset 为非负 safe integer（`historyServiceCursor.ts:24-35`）。失败仍统一包装为 `AGENT_HISTORY_INVALID_CURSOR`（`historyServiceCursor.ts:37-38`）。
- 因此 base64、v1/envelope、kind、offset 和真正 changed filters 的拒绝行为没有被本次修复放宽。

### 3. pre-upgrade payload 回归测试有效

- 测试 helper 直接执行 `Buffer.from(JSON.stringify({ v: 1, kind, filters, offset })).toString('base64url')`（`packages/host-node/src/history/historyServiceCursor.test.ts:4-6`），没有调用 current `encodeHistoryServiceCursor`，能够真实保留手工指定的旧属性顺序。
- items/root 用例把旧 target 写成 `conversationId,kind`，current target 写成 `kind,conversationId`，并断言旧 payload 解出 offset 3（`historyServiceCursor.test.ts:19-25`）。
- search/child 用例把旧 target 写成 `agentPath,runId,conversationId,kind`，current target 写成 canonical 顺序，并断言旧 payload 解出 offset 4（`historyServiceCursor.test.ts:27-33`）。两种 target 分支和两个实际会分页的 legacy surface 均已覆盖。
- 原有测试继续覆盖 current encoder round-trip、kind/roles filter 变化拒绝和 oversized cursor 拒绝（`historyServiceCursor.test.ts:7-17`）。报告记录定向测试 5/5、范围完整测试 215/215；本复审按要求未重跑测试。

## 复审边界

- 仅核对首审唯一 Important 及 R1 对 `historyServiceCursor.ts` / test 的修复，没有重新展开已通过的其余 005 契约。
- 未修改产品代码或任务文档；仅覆盖本审查报告。
- 两个修复文件分别为 40/35 行，仍各自只负责 legacy cursor codec 与对应测试场景，无文件行数或职责问题。

## 结论

旧 cursor 的 target 字段顺序现在在比较双方被消除，同时 v1 envelope 与各项拒绝边界保持。原 Important 已完整关闭，可以批准。
