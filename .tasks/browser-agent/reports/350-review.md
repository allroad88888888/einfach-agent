# 350 · 会话全历史撤销独立审查

结论：**PASS（R1）**

审查范围：`340-full-session-undo.md` 的 U10–U14、`340-report.md`、`340-verification.md`、`340-scope.diff` 与 `340-delta.diff`。按任务要求只读产品代码，未操作浏览器，未重跑报告中的绿色测试。

## 验收

- ✅ U10：`createSessionHistory` 通过 `@einfach/core` 的公开 `cap` API 使用 `Number.MAX_SAFE_INTEGER`，没有新增产品条数或消息年龄窗口；仍复用既有 history、`SESSION_SLOTS` 与增量 items applier。报告给出 1,205 笔真实 writer 事务及早/中/末消息可撤记录证据。
- ✅ U11：快照与日志同刻捕获并由同一 `saveLatest` 原子保存，legacy generation 配对、CAS 队列、删除清理与序列化失败路径成立。R1 还补出了真实长历史闭环：1,205 条消息与一个中段 checkpoint 形成 1,206 笔事务，执行 `persistRecovery` 后用全新 core `hydrate`，核对早/中/末消息均可撤，再撤回最早消息并确认 items 与 checkpoint 一同回退。该断言确实跨越持久化与重建，不再以纯内存的 1,205 笔测试代替。
- ✅ U12：撤回仍通过完整事务日志回放，不是消息数组切片；既有运行停止、迟到回写及显式 session 隔离路径未被替换。报告中的 core、多 client 与长历史恢复证据支持该项。
- ✅ U13：正常历史不再显示按期限过期文案；旧版已丢日志与损坏日志的边界表述准确。每条消息 undo、成功回填聚焦、失败保草稿及无 redo/占位回归由既有 UI 回归覆盖。
- ✅ U14：普通 stop 的可达性已包含 live items、queue 及完整 undo/redo entries；分支截断释放最终不可达内容，会话删除仍以其余 session 引用为保护集合。旧 IDB decoder 也保留了 `barrierTxId` 字段。

## R1 复核

原 Important 已修复。共享 `isPersistedHistoryPayload` 现在要求 `barrierTxId` 非空且命中 `entries[].txId`。内嵌快照的 codec 测试覆盖空 barrier 与悬空 barrier 并拒绝整份损坏 snapshot；legacy 测试构造同 generation 但悬空 barrier 的外置日志，恢复有效状态投影但保持空 history，未把无法证明配对的账本铺入运行态。两条读取路径均已 fail-closed。

本复审按任务要求未重跑已绿色测试。scope 中 360 对两项 browser agent 集成测试终态等待的并行变化不计入 340 结论；340 的精确 delta 未发现 Critical、Important 或 Minor 遗留，也未发现需要扩大到 52page 等前序任务的缺陷、新包、history 引擎重写或普通新增文件超限。
