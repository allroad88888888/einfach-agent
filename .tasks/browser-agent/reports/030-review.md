# 030 独立审查

结论：**REJECTED**

审查范围：`.tasks/browser-agent/030-api-tools.md`、`.tasks/browser-agent/index.md`、`reports/030-report.md`、`reports/030-scope.diff` 及其列出的 `browser-agent/tools/api/**` 新增文件。按约束未重跑交付报告中已通过的测试，未修改产品代码。

## Findings

### Important — 没有真实的客户端超时，永不 settle 的请求会永久挂起

`browser-agent/tools/api/src/fetch-options-source.ts:28` 直接等待 `fetcher(...)`，没有超时配置、计时器或内部 `AbortController`；`browser-agent/tools/api/src/options-host.ts:84` 也无截止时间地等待任意 source。`fetch-options-source.ts:55` 只是把服务端已经返回的 HTTP 408/504 分类为 `API_OPTIONS_TIMEOUT`，并不能保障请求自身超时。

复现：注入 `fetch: () => new Promise(() => {})`，用未取消的 `ToolContext.signal` 调用 `query_options`；Promise 永远不结束，也永远不会返回 `API_OPTIONS_TIMEOUT`。这不满足行为要求 4 的“超时”与 C07 的“超时”证据要求，也会让一次工具调用无限占用运行轮次。

### Important — 取消后迟到的成功结果仍会交给调用方

`browser-agent/tools/api/src/options-host.ts:83-84` 只在 source 开始前检查一次 `signal.aborted`，await 返回后没有再次检查。`browser-agent/tools/api/src/fetch-options-source.ts:28-37` 同样依赖 fetch 主动拒绝；如果自定义 source 或注入 fetch 忽略 signal，并在取消后 resolve，代码会照常解析并返回 `{ ok: true }`。现有测试仅覆盖 fetch 抛 `AbortError` 的配合路径（`browser-agent/tools/api/src/query-options/query-options.test.ts:44-57`），没有覆盖迟到 resolve。

复现：source 的 `query` 返回一个外部可 resolve 的 Promise；调用后 abort context，随后以一个合法 option resolve。`queryOptions` 会成功返回该 option。下游可继续把这个已取消调用的候选值用于页面写入，违反行为要求 6“迟到结果不再驱动下一步写表”。

### Important — 公开的 `ApiToolsError.message` 可把适配器秘密原样送进 ToolResult

`browser-agent/tools/api/src/query-options/query-options.ts:50-53` 对任何 `ApiToolsError` 原样返回 `error.message`。该错误类是公开出口，且 host 不限定注册 source 的实现；另外 `browser-agent/tools/api/src/fetch-options-source.ts:38-43` 会保留 mapper 主动抛出的 `ApiToolsError`。因此适配器若用响应文本、URL、认证头或 token 构造这个错误，秘密会直接进入模型可见的 `ToolResult`。报告中的脱敏测试只覆盖包内固定错误消息，不能证明此边界安全。

复现：注册 `query: async () => { throw new ApiToolsError('API_OPTIONS_SERVICE_ERROR', 'Bearer customer-secret') }`，经 registry 调用后结果包含 `error: 'Bearer customer-secret'`。这不满足行为要求 4 和验收标准 2 的错误脱敏要求。工具层应只按 code 映射包内固定安全文案，不能信任 source 提供的 message。

## 验收逐条判定

1. **部分通过**：报告记录 2 files / 11 tests passed；静态检查确认覆盖搜索参数、父字段过滤、分页参数透传、字段映射、未知 source、重复注册、截断，以及两个 session 的差异授权和拒绝方不执行 source。取消迟到 resolve 未覆盖且实现失败。
2. **不通过**：有注入 fetch 的 HTTP 分类、AbortError 和固定错误脱敏断言，但上述公开 `ApiToolsError.message` 可泄密，取消测试也只验证协作式 AbortError。
3. **通过**：测试通过公开 core `ToolRegistry` 独立注册和运行；产品源码未 import UI、extension、DOM 或客户后端。
4. **通过（依据交付记录与静态产物）**：报告记录包 build 通过；README 含确定性内存 fixture 与 HTTP `OptionsSource` 接入例。按审查约束未重跑。
5. **通过**：公开结果为 `label`/`value`，可供 page 消费；测试未 import page 内部文件，跨包 E2E 明确保留给 050。

## C07 判定

- 搜索、父字段过滤、分页、字段映射、结果上限：**通过**。
- source 授权：**通过**。`sessionId` 只来自 `ToolContext`，已注册性和会话授权在 source 执行前检查，拒绝不会触发 source/fetch；工具参数不含 URL、header、method 或凭据。
- HTTP 401/403、429、服务错误、非 JSON/畸形响应分类：**通过**。
- 错误脱敏：**不通过**，适配器抛出的 `ApiToolsError.message` 被信任并公开。
- 取消及迟到结果围栏：**不通过**，只覆盖请求前取消和 AbortError；取消后 resolve 仍成功。
- 超时真实保障：**不通过**，仅分类 HTTP 408/504，没有本地截止时间。
- 空结果与失败区分、无失败缓存：**通过**；实现没有缓存，失败不会转为空成功。
- 默认无限重试与全局浏览器凭据：**通过**；实现无重试，也不读取全局凭据。

修复以上三个 Important 后，应增加三个针对性负例：永不 settle 的 fetch 达到截止时间、忽略 signal 的迟到 resolve 被拒绝、携密 `ApiToolsError` 不进入 ToolResult。
