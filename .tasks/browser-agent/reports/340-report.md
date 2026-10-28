# 340 · 会话全历史撤销与恢复配对修复报告

日期：2026-09-20
结论：实现完成，定向验收通过；未提交、未推送、未安装依赖、未操作浏览器或真实模型。

## 实现

- `createSessionHistory` 继续使用 `@einfach/core` 0.4 的公开 `cap`，设为
  `Number.MAX_SAFE_INTEGER`。该值高于 JavaScript 可实现数组长度，因此产品不再按事务数或消息年龄
  淘汰会话账本，也没有复制历史引擎。
- `RecoverySnapshotV1.history` 保存与状态投影同一同步时刻捕获的 `entries/cursor/barrierTxId`。
  `RecoveryWriter` 将二者交给原有 `RecoveryDriver.saveLatest` 做单记录原子提交，消除了先保存快照、
  再异步保存外置日志的崩溃窗口。连续 generation、CAS 重试、reset 与 tombstone 仍走原 writer 队列。
- 新快照优先读内嵌账本；没有内嵌字段的旧快照才按 generation 回退读取 `HistoryLogDriver`。
  新旧两条读路径共用严格账本校验：非空 txId、非空 ops、非空 op key、合法 cursor 与 barrier。
  损坏内嵌账本使整份 snapshot fail-closed，不会悄悄回退到另一代 legacy 日志。
- 新流程停止写外置 history log，但保留旧 driver 接口、旧记录读取和会话删除清理。
  IndexedDB 旧日志读取补回原先遗漏的 `barrierTxId`，避免恢复后绕过真实不可逆屏障。
- 用户内容可达性现在包含 live items、queue 和完整 undo/redo 账本中的 `items`、
  `items:append/patch/remove`、`queuedUserMessages` before/after。普通 stop 清空队列后，历史仍引用的
  provider 内容不会被释放或制造永久屏障。undo 后创建新分支、丢弃 redo 尾时，会释放其中最终不可达
  的内容；删除会话继续按所有剩余会话统一保护共享引用。
- UI 不再把正常产品规则描述成“超出可撤销历史”；缺账仅诊断为旧版本已经淘汰或日志损坏。
  旧版早已丢掉的逆操作无法重建，恢复不会伪造完整 state。

## 验收证据

定向最终命令：

```text
pnpm exec vitest run packages/agent-core/src/state/undoBarrier.test.ts packages/agent-core/src/state/persistence/recoveryDriver.test.ts packages/agent-core/src/state/persistence/historyLogRoundTrip.test.ts packages/agent-core/src/runtime/persistenceBridge.recovery.test.ts packages/agent-core/src/runtime/userContentDisposal.test.ts packages/agent-core/src/state/sessionItemsLog.test.ts packages/persistence-idb/src/indexedDbHistoryLogDriver.test.ts browser-agent/ui/src/chat/ConversationTimeline.test.tsx browser-agent/ui/src/chat/messageHistoryActions.test.tsx browser-agent/agent/src/multiClient.integration.test.ts
```

结果：命令列出 10 个测试文件；Vitest 连同依赖关联测试共执行 12 files / 65 tests，全部通过。覆盖：

- 1,205 笔真实 writer 事务完整保留；最早、中间、最新用户消息均有可撤记录，撤回最早消息精确删除后续。
- 长历史持久化后重建并可撤销；撤回占位/恢复投影跨重建保留。
- 延迟 `saveLatest` 时，第一代快照与第一代账本保持同刻，后续内存写入只进入下一代。
- 不可 JSON 序列化账本返回 error 且不推进 recovery；损坏 cursor/entry/op 被 codec 拒绝。
- 新内嵌账本优先于错代 legacy 日志；真实 barrier 随内嵌账本恢复。
- stop 保留历史引用资源；新分支淘汰 redo 尾后释放最终不可达资源；共享 session 仍受保护。
- browser agent 多 client 隔离回归通过；UI 每消息撤销入口与回填相关回归通过。

相关范围完整测试曾执行：

```text
pnpm exec vitest run packages/agent-core/src packages/persistence-idb/src browser-agent/agent/src browser-agent/ui/src
```

首轮为 261 files / 2,076 tests，其中 2,073 通过；两项是尚未更新为 U14 新合同的
`undoBarrier.test.ts` 旧断言，已更新并在最终命令通过；另一项是 `multiClient.integration.test.ts`
并发运行时遇到动态 import 错误（`defaultCorePlugins is not iterable`），同文件在最终命令 3/3 通过；
本任务未做基线对照，因此不归因为既有问题。
没有用放宽断言或产品预加载掩盖它。

静态与治理命令：

```text
pnpm exec tsc -b --pretty false
pnpm check:state
pnpm check:boundaries
node scripts/check-docs.js
git diff --check
```

均通过。`recoverySnapshot.codec.ts` 最终 295 行；本次没有新增源文件，所有大改普通文件均未超过
300 行（`persistenceBridge.ts` 286 行，新增测试文件也没有超过 300 行）。

## 文档与边界

已更新 core、IndexedDB、browser runtime/UI README 及项目线 01，记录无应用级淘汰政策、原子配对、
legacy 读取边界和历史资源可达性。外部工具副作用仍不伪装回滚；已有真实 barrier 继续阻止越界撤销。

遗留真实边界：旧版本已经 cap 淘汰的 entry、损坏后被 codec 拒绝的 entry，以及外部系统已执行的副作用
都无法由当前状态推导回来。此类会话只恢复可验证状态，不声称拥有完整撤销历史。

## 350 R1 审查收尾

独立审查发现 barrier 仅校验字符串类型会接受空值或悬空 txId，使恢复后的屏障失效。共享
`isPersistedHistoryPayload` 已改为：barrier 存在时必须非空且命中 `entries[].txId`。新内嵌快照在 codec
边界拒绝该损坏记录；legacy 外置日志保留有效状态快照，但拒绝 hydrate 整本无法证明屏障配对的账本。

```text
pnpm exec vitest run packages/agent-core/src/state/persistence/recoveryDriver.test.ts packages/agent-core/src/state/persistence/historyLogRoundTrip.test.ts
pnpm exec tsc -b --pretty false
git diff --check
```

结果：2 files / 13 tests、TypeScript 与 diff 检查全部通过。其中新增闭环以 1,205 条消息形成
1,206 笔事务（含中段 context checkpoint），执行 persist → 全新 core hydrate，核对早/中/末消息均可撤，
再撤回最早消息并确认全部 items 与 checkpoint 一同回退。未重跑 261 文件全范围；该最终闭环归 360。
