# 卡顿诊断日志

这套日志用于定位长对话、plan 更新和大文件写入时界面“完全不动”的具体阶段。
诊断只记录耗时、队列深度、数量、字符/字节数、结果和关联 ID；不记录文件内容、prompt，
绝对路径会被替换为长度占位符。

> **只有前端一半。** 桌面端随 T1 退出后，本文原来的「Rust 分段日志」那一半没有等价物：
> `packages/host-node` **没有**搬 Rust 侧那套 `web_agent::perf` 阶段日志（裁决记在
> `packages/host-node/src/workspace/patch/pipeline.ts` 与 `workspace/change/entryStore.ts` 的文件头），
> `apps/server` 也不写性能日志。于是「IPC 之后到底慢在哪」目前**问不出来**：能看到的只有前端记的
> 「这次宿主调用一共等了多久」，看不到锁、journal、落盘各占多少。这是一处真实的诊断缺口，
> 不是本文没写。

## 复现与取证

1. `pnpm serve` 起本机服务，在浏览器打开出现问题的长对话。
2. 触发 plan 创建或长文件写入，记下界面开始和恢复的大致时间。
3. 不要先清数据或重启应用。打开同一前端地址并追加 `?view=traces`，点击“刷新”。
4. 先搜索 `perf.`，再按 `operationId`、`sessionId` 或 `runId` 搜索同一次操作。

浏览器 console 同时输出 `[web-agent:perf]`；超过各自阈值的记录使用 warning，失败使用 error。

## 如何判断卡在哪里

| 现象 | 关键日志和字段 | 结论 |
| --- | --- | --- |
| plan 提交时同步卡住 | `perf.plan.commit` 的 `sessionAtomUpdateMs`、`rootMetadataUpdateMs` | Einfach 订阅传播或同步派生计算过重 |
| plan 面板恢复后才出现慢记录 | `perf.ui.plan_execution_index`、`perf.ui.react_commit` | 长会话索引重算或 React commit 阻塞主线程 |
| 整个页面的定时器停摆 | `perf.ui.event_loop_stall`、`perf.ui.long_task` | 冻结确实发生在浏览器主线程；用时间戳与相邻 span 对齐 |
| plan 保存越积越慢 | `perf.persistence.sessions.write` 的 `queueDepthAtEnqueue`、`queueWaitMs` | 全量 session snapshot 写入产生队列积压 |
| SQLite 前就卡住 | `perf.persistence.sqlite.sessions` 的 `serializeMs`、`jsonChars` | `JSON.stringify(SessionMeta[])` 在主线程过重 |
| SQLite 等待很久 | 同一日志的 `dbReadyMs`、`executeMs` | 数据库初始化、锁等待或实际执行过慢 |
| 宿主调用一发出就卡 | `perf.workspace.write.ipc` 的 `invokeDispatchMs` | 大 payload 的序列化/派发阻塞主线程 |
| 宿主调用等待很久 | 同一日志的 `hostWaitMs` | 时间花在本机 Node 后端里。**到此为止**——宿主侧没有分段日志可以继续追（见文首）；只能改用 `run_shell_command` 之类的外部手段复现，或先给 host-node 补一个诊断出口 |

一次 plan 更新的 `perf.plan.commit`、`perf.persistence.sessions.write` 和
`perf.persistence.sqlite.sessions` 共用同一个 `operationId`。文件写入的 `operationId` 仍会随入参
递给宿主，但宿主**只是收下不用**（同一处文件头写明），所以它现在只在前端一侧起关联作用。

## 诊断点清单

- UI：首屏绘制、事件循环停顿、Long Task、AppShell/PlanPanel React commit、plan 执行条目索引。
- 状态与队列：plan atom/root metadata 更新、session/workspace/recovery 持久化队列。
- SQLite：初始化、JSON 序列化、SQL 执行、旧数据清理、payload 大小。
- 宿主调用：同步派发、host 等待、响应归一化、payload 大小（`workspace.write.ipc` /
  `workspace.patch.ipc`）。
- **宿主内部：没有。** 锁、journal 准备、文件提交、archive compact 这些阶段目前不产生任何日志。
