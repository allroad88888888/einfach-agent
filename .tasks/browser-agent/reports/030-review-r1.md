# 030 R1 独立复审

结论：**PASSED**

复审范围：`.tasks/browser-agent/030-api-tools.md`、`.tasks/browser-agent/index.md`、更新后的 `reports/030-report.md`、`reports/030-scope-r1.diff` 及当前 `browser-agent/tools/api/**`。按要求未重跑报告已证明的测试，未修改产品代码。

## Findings

### Minor — 同步取消后，已排队的 source 微任务仍会启动

`browser-agent/tools/api/src/query-lifecycle.ts:33-36` 注册取消监听后，通过 `Promise.resolve().then(...)` 延后调用 source。调用方取得 `queryOptions()` 返回的 pending Promise 后若立即同步 abort，`cancel` 会先把 `finished` 置为 true 并中止派生 signal，但已经排队的第 34 行微任务仍会调用一次 `query(...)`。该调用拿到的是 `aborted === true` 的 signal，其结果或异常也会被 `finish` 丢弃，因此不会成为成功 ToolResult 或驱动页面写入；内置 fetch 在原生取消语义下也不会完成请求。

对不配合 signal 的自定义 source，这仍可能产生一次取消后的只读查询或准备工作。可在第 34 行调用 query 前检查 `controller.signal.aborted` 来避免启动。鉴于本包合同限定为只查询、授权已在此前完成、迟到结果有围栏，此项不阻断 R1。

## 原三个 Important 关闭判定

1. **真实超时：已关闭。** `browser-agent/tools/api/src/options-host.ts:56,73-77` 对完整 source 生命周期使用宿主配置的 deadline，默认 10 秒且限制为最大 120 秒；`browser-agent/tools/api/src/query-lifecycle.ts:27-31` 到时返回 `API_OPTIONS_TIMEOUT` 并 abort 派生 signal。报告记录永不 settle 的 source 与 fetch 负例通过。
2. **取消后的迟到结果：已关闭。** `browser-agent/tools/api/src/query-lifecycle.ts:15-21,23-37` 使用单次 `finish` 围栏；取消先 abort adapter signal，再拒绝外层 Promise，之后 source 的 resolve/reject 无法改写结果。报告记录迟到成功和 body `json()` 永不 settle 的取消负例通过。
3. **错误脱敏：已关闭。** `browser-agent/tools/api/src/query-options/query-options.ts:51-77` 不再透传 `ApiToolsError.message`，仅按稳定 code 返回包内固定文案；未知错误和运行期无效 code 回落到固定 network error。报告记录携带 bearer token 与私有 URL 的 source 错误负例通过。

## deadline、body 与清理核对

- `runQueryWithDeadline` 的 timer 和上游 abort listener 都在首次完成路径中清理（`query-lifecycle.ts:16-21`），成功、失败、取消、超时均收敛到该路径。
- 取消/超时在 settle 前执行 `controller.abort()`（`query-lifecycle.ts:23-29`），内置 adapter 将派生 signal 传给 fetch（`fetch-options-source.ts:28`）。原生 fetch 在读取响应 body 时也受该 signal 控制；即使注入的 `response.json()` 不配合，外层 deadline race 仍按时拒绝并丢弃迟到 body 结果。
- source/fetch 的迟到 rejection 已由第 34-37 行的 rejection handler 消费，不形成未处理 Promise rejection。

## 验收与 C07 判定

- 搜索、父字段过滤、分页、字段映射、未知 source、重复注册、截断、双 session 授权差异及拒绝不触发 source：**通过**。
- 可信 `ToolContext.sessionId` 授权、工具参数不接收 URL/header/method/凭据：**通过**。
- HTTP 401/403、429、服务错误、非 JSON/畸形响应、空结果与失败区分：**通过**。
- 真实 deadline、取消、迟到结果围栏、body 读取取消、timer/listener 清理：**通过**，保留上述 Minor 的“取消后微任务仍启动一次”。
- ToolResult 错误脱敏：**通过**；认证头、API key、原始响应和 adapter message 均无公开路径。
- 无失败缓存、无默认重试、不读取全局浏览器凭据：**通过**。
- 独立 core 注册、包构建与声明出口、README 接入例、与 page 包边界：**通过（依据报告及静态检查）**。

R1 已满足任务验收与 C07；上述 Minor 可在后续维护中收紧取消前的启动检查。
