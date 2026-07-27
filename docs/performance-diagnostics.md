# Tauri 卡顿诊断日志

这套日志用于定位长对话、plan 更新和大文件写入时 WebView “完全不动”的具体阶段。
诊断只记录耗时、队列深度、数量、字符/字节数、结果和关联 ID；不记录文件内容、prompt，
绝对路径会被替换为长度占位符。

## 复现与取证

1. 启动 Tauri 桌面端，打开出现问题的长对话。
2. 触发 plan 创建或长文件写入，记下界面开始和恢复的大致时间。
3. 不要先清数据或重启应用。打开同一前端地址并追加 `?view=traces`，点击“刷新”。
4. 先搜索 `perf.`，再按 `operationId`、`sessionId` 或 `runId` 搜索同一次操作。
5. 文件写入还需要检查 Rust 日志。macOS 默认位于
   `~/Library/Logs/com.webagent.app/web-agent.log`；搜索 `web_agent::perf`，再用前端日志中的
   `operationId` 对齐 `operation_id`。

桌面日志按 5 MiB 轮转，保留当前文件和最近 3 个历史文件。WebView console 同时输出
`[web-agent:perf]`；超过各自阈值的记录使用 warning，失败使用 error。

## 如何判断卡在哪里

| 现象 | 关键日志和字段 | 结论 |
| --- | --- | --- |
| plan 提交时同步卡住 | `perf.plan.commit` 的 `sessionAtomUpdateMs`、`rootMetadataUpdateMs` | Einfach 订阅传播或同步派生计算过重 |
| plan 面板恢复后才出现慢记录 | `perf.ui.plan_execution_index`、`perf.ui.react_commit` | 长会话索引重算或 React commit 阻塞 WebView |
| 整个 WebView 的定时器停摆 | `perf.ui.event_loop_stall`、`perf.ui.long_task` | 冻结确实发生在 WebView 主线程；用时间戳与相邻 span 对齐 |
| plan 保存越积越慢 | `perf.persistence.sessions.write` 的 `queueDepthAtEnqueue`、`queueWaitMs` | 全量 session snapshot 写入产生队列积压 |
| SQLite 前就卡住 | `perf.persistence.sqlite.sessions` 的 `serializeMs`、`jsonChars` | `JSON.stringify(SessionMeta[])` 在 WebView 主线程过重 |
| SQLite 等待很久 | 同一日志的 `dbReadyMs`、`executeMs` | 数据库初始化、锁等待或实际执行过慢 |
| IPC 调用一发出就卡 | `perf.workspace.write.ipc` 的 `invokeDispatchMs` | 大 payload 的 Tauri 参数封送阻塞 WebView |
| IPC 等待很久 | 同一日志的 `hostWaitMs` | 转到相同 operation ID 的 Rust 分段日志继续判断 |
| Rust 文件阶段慢 | `workspace_write.phase` 的 `phase`、`phase_ms` | `exclusive_lock`、`journal_prepare`、`file_write` 或 `journal_finalize` 中的具体阶段 |
| Rust patch 阶段慢 | `workspace_patch.phase` 的 `phase`、`phase_ms` | 路径解析、operation staging、journal、文件提交或 finalize 中的具体阶段 |
| 变更日志阶段慢 | `workspace_journal.write` 的 `serialize_ms`、`file_write_ms`、`rename_ms` | journal JSON 构建、文件写入或原子替换过慢 |

一次 plan 更新的 `perf.plan.commit`、`perf.persistence.sessions.write` 和
`perf.persistence.sqlite.sessions` 共用同一个 `operationId`。一次文件写入的 WebView
`operationId` 与 Rust `operation_id` 也相同，因此不需要依赖相近时间猜测关联关系。

## 诊断点清单

- UI：事件循环停顿、Long Task、AppShell/PlanPanel React commit、plan 执行条目索引。
- 状态与队列：plan atom/root metadata 更新、session/checkpoint/workspace 持久化队列。
- SQLite：初始化、JSON 序列化、SQL 执行、旧数据清理、payload 大小。
- Tauri IPC：同步派发、host 等待、响应归一化、payload 大小。
- Rust：workspace 校验、目录准备、排他锁、archive compact、patch staging、journal 准备、
  文件提交和 journal finalize。
