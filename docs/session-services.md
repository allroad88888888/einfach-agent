# 会话常驻服务

Node 宿主提供 `start_service`、`get_service_status`、`read_service_logs`、`stop_service`。工具只接收当前 runtime 注入的会话身份，不能用参数切换会话。启动与停止沿用危险工具确认，启动命令的 critical 判据与 shell 一致，Auto 不绕过 critical 保护；启动不向子 agent 委派。直接文件内容写入仍须使用文件工具。

`start_service` 返回 serviceId 与进程状态，只说明 spawn 成功，不保证网络端口或应用 readiness。通过状态与日志检查就绪。服务在 Node 宿主内持有，不持久化 PID，不跨宿主重启恢复。Windows 明确拒绝启动，因为尚无经过验证的进程树清理实现。

日志合并 stdout/stderr，UTF-8 按流解码后保留最近 65536 个 UTF-16 字符。读取从 cursor=0 开始，下一次使用 nextCursor；baseCursor 表示仍保留的起点，truncated 表示游标之前的数据已回收。每次默认读取 16384 字符，最小 2、硬上限 65536；边界不会拆开 UTF-16 代理对。日志不会自动附加命令或环境变量，但进程自身输出可能含敏感信息。只读取所属会话的服务。

每会话最多 8 个 starting/running 服务，宿主最多保留 128 条记录；满额时先按 FIFO 回收已完成清理的终态记录，仍满则明确拒绝新启动。成功/失败退出保留 exitCode、signal 与尾部日志，直到记录回收或会话结束。停止保留 stopped 与 stopReason。启动失败不占用配额。

删除会话（包括删除其工作区）会异步发送 `end_service_session`，宿主收到后先撤销后续启动，再等待在途启动结束并停止全部服务。原有同步 removeSession 接口不等待清理完成，失败会记录控制台错误。切换会话、模型轮次结束、取消轮次、浏览器关闭均不删除会话。断网或请求丢失时无法保证删除请求送达；服务会继续运行，直到成功发送停止/结束请求或宿主关闭。此实现不提供断网租约。

宿主为已结束会话保留最多 100000 条 tombstone，防止乱序或迟到 HTTP 启动让会话复活。达到上限后明确拒绝新服务并提示重启宿主；重启会停止所有现有服务并清空历史，不静默回收 tombstone。持有同一宿主 API token 的客户端具有该宿主权限，sessionId 隔离是 runtime 所属会话的操作隔离，不是多租户身份认证。

CLI 正常完成/失败的 finally drain，以及 CLI/server 的 SIGTERM、SIGINT、SIGHUP shutdown 会并发关闭服务。Unix 按进程组发送 SIGTERM，150ms 后 SIGKILL，再有界等待根进程退出并关闭日志管道；根进程先退出时也清理其进程组。普通 process.exit 的同步兜底直接 SIGKILL。不得使用 setsid、daemonize 等主动逃离进程组的方式。宿主 SIGKILL、断电或逃离进程组的后代无法由进程内代码保证清理。
