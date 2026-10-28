# 350 · 会话全历史撤销独立审查

结论：**CHANGES REQUESTED**

审查范围：`340-full-session-undo.md` 的 U10–U14、`340-report.md`、`340-verification.md`、`340-scope.diff` 与 `340-delta.diff`。按任务要求只读产品代码，未操作浏览器，未重跑报告中的绿色测试。

## 验收

- ✅ U10：`createSessionHistory` 通过 `@einfach/core` 的公开 `cap` API 使用 `Number.MAX_SAFE_INTEGER`，没有新增产品条数或消息年龄窗口；仍复用既有 history、`SESSION_SLOTS` 与增量 items applier。报告给出 1,205 笔真实 writer 事务及早/中/末消息可撤记录证据。
- ❌ U11：快照与日志已改为同刻捕获并由同一 `saveLatest` 原子保存，legacy generation 配对、CAS 队列、删除清理与序列化失败路径总体成立；但内嵌账本对损坏 barrier 的校验不足，会在恢复后静默绕过真实不可逆边界，见下方 Important。
- ✅ U12：撤回仍通过完整事务日志回放，不是消息数组切片；既有运行停止、迟到回写及显式 session 隔离路径未被替换。报告中的 core、多 client 与长历史恢复证据支持该项。
- ✅ U13：正常历史不再显示按期限过期文案；旧版已丢日志与损坏日志的边界表述准确。每条消息 undo、成功回填聚焦、失败保草稿及无 redo/占位回归由既有 UI 回归覆盖。
- ✅ U14：普通 stop 的可达性已包含 live items、queue 及完整 undo/redo entries；分支截断释放最终不可达内容，会话删除仍以其余 session 引用为保护集合。旧 IDB decoder 也保留了 `barrierTxId` 字段。

## Important

1. **损坏或不一致的 `barrierTxId` 会被接受，并在恢复后把真实不可逆屏障静默变成无效屏障。** 触发条件是恢复记录的 `history.barrierTxId` 为 `""` 或任意不属于 `history.entries[].txId` 的字符串（包括损坏记录、部分迁移记录，或 barrier 与 entries 错配）。`isPersistedHistoryPayload` 目前只检查它是字符串（`packages/agent-core/src/state/persistence/historyLogDriver.ts:59-66`），随后 hydrate 成功便原样写入 atom（`packages/agent-core/src/state/persistence/hydrate.ts:243-246`）。命令与 UI 查找不到该 txId 时把 `barrierIndex < 0` 当作没有屏障（`packages/agent-core/src/state/undoBarrier.ts:52-59`、`packages/agent-core/src/state/sessionTurnHistory.ts:61-68`），因此用户可越过原本受保护的外部副作用。这个问题同时影响新内嵌快照的 codec 和 legacy 外置日志读取，因为二者共用该校验。请让 payload 校验在 barrier 存在时要求非空且精确命中一条 entry（并补内嵌与 legacy 两条损坏输入回归）；无法证明配对的 barrier 应 fail-closed，不能 hydrate 后按“无屏障”运行。

除该项外，本轮 delta 未发现需要扩大到 52page 等前序任务的缺陷，也未发现新包、重写 history 引擎或普通新增文件超限。
