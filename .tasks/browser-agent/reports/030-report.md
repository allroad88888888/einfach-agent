# 030 接口数据工具包交付报告

状态：DONE

## 公开接口

包名为 `@einfach-agent/tools-browser-api`，根出口为：

```ts
interface QueryOption { label: string; value: string }
interface QueryOptionsInput {
  sourceId: string
  query?: string
  cursor?: string
  parameters?: Readonly<Record<string, string | number | boolean>>
}
interface QueryOptionsResult {
  options: readonly QueryOption[]
  nextCursor?: string
  truncated?: boolean
}
type ApiCallContext = Pick<ToolContext, 'sessionId' | 'signal'>
interface OptionsSource {
  id: string
  query(input: Omit<QueryOptionsInput, 'sourceId'>, ctx: ApiCallContext): Promise<QueryOptionsResult>
}
interface ApiToolsHost {
  queryOptions(input: QueryOptionsInput, ctx: ApiCallContext): Promise<QueryOptionsResult>
}
interface ApiToolsHostOptions {
  isSourceAllowed(sourceId: string, sessionId: string): boolean
  timeoutMs?: number
}
function createApiToolsHost(
  sources: readonly OptionsSource[],
  options: ApiToolsHostOptions,
): ApiToolsHost
function registerApiTools(registry: ToolRegistry, host: ApiToolsHost): void
function createQueryOptionsTool(host: ApiToolsHost): Tool

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
interface HttpQueryRequest { url: string; init?: RequestInit }
interface FetchOptionsSourceConfig {
  id: string
  request(input: Omit<QueryOptionsInput, 'sourceId'>): HttpQueryRequest
  mapResponse(payload: unknown): QueryOptionsResult
  fetch?: FetchLike
}
function createFetchOptionsSource(config: FetchOptionsSourceConfig): OptionsSource
type ApiToolsErrorCode =
  | 'API_OPTIONS_INVALID_INPUT' | 'API_OPTIONS_UNKNOWN_SOURCE'
  | 'API_OPTIONS_FORBIDDEN' | 'API_OPTIONS_INVALID_RESPONSE'
  | 'API_OPTIONS_CANCELLED' | 'API_OPTIONS_TIMEOUT'
  | 'API_OPTIONS_UNAUTHORIZED' | 'API_OPTIONS_RATE_LIMITED'
  | 'API_OPTIONS_SERVICE_ERROR' | 'API_OPTIONS_NETWORK_ERROR'
class ApiToolsError extends Error {
  constructor(code: ApiToolsErrorCode, message: string, retryable?: boolean)
}
const DEFAULT_QUERY_TIMEOUT_MS: 10000
const MAX_QUERY_TIMEOUT_MS: 120000
```

`QueryOptionsResult.truncated` is an additive signal that the host applied the hard
100-option cap. `ApiToolsError` and its stable categories are also exported for source
adapters that need a deliberately classified safe error.

R1 adds the host-only `timeoutMs` option. It defaults to 10 seconds, accepts only positive
safe integers through 120 seconds, and cannot be supplied by model tool arguments.

## 实现、测试和文档

- `options-host.ts` owns source registration, input validation, trusted per-session
  authorization before source execution, label/value normalization, and the 100-option cap.
- `query-lifecycle.ts` owns the full source deadline. It creates a derived abort signal,
  races source/fetch/body work against cancellation and timeout, cleans up its timer/listener,
  and discards a late fulfillment from a non-cooperative adapter.
- `api-error.ts` owns stable error codes. The tool maps those codes to fixed safe messages;
  adapter-supplied `ApiToolsError.message` is never returned in a `ToolResult`.
- `fetch-options-source.ts` is the host-owned HTTP adapter. It forwards cancellation and
  classifies authorization, timeout, rate-limit, service, JSON, mapping, and network errors
  without exposing headers or bodies.
- `query-options/query-options.ts`, its guide, and its test form the required single-tool
  directory. The browser `query_options` tool accepts no credentials, URL, headers, method,
  or executable expression.
- `README.md` provides a deterministic local source fixture plus a real-system HTTP mapper
  example. The build emits JS and declaration files through the explicit root export.

## 验收命令与结果

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 定向功能、核心注册和安全负例 | `pnpm exec vitest run browser-agent/tools/api` | 2 files, 17 tests passed |
| 独立 TypeScript 类型检查 | `pnpm exec tsc -p browser-agent/tools/api/tsconfig.json --noEmit` | passed |
| 包构建和声明出口 | `pnpm --filter @einfach-agent/tools-browser-api build` | passed; 1 JS entry plus 6 `.d.ts` files |
| Markdown 链接/旧路径门禁 | `node scripts/check-docs.js` | passed; 526 Markdown files |
| 本任务差异格式 | `git diff --check -- browser-agent/tools/api` | passed |
| 新增/大改源文件行数 | `find browser-agent/tools/api/src -type f -name '*.ts' -exec wc -l {} +` | 9 files, 565 total; largest implementation 141 lines |

## C07 证据

`options-host.test.ts` covers keyword search, parent-field parameters, cursor pagination,
unknown source, authorization that differs by session, denied-source no-query behavior,
duplicate IDs, malformed normalized candidates, and deterministic truncation. Its source spy
proves that the rejected session does not execute the source.

`query-options/query-options.test.ts` registers the package into a standalone core
`ToolRegistry`, uses an injected deterministic fetch response to map `{ display, id }` into
`{ label, value }`, and covers HTTP 401, 429, 500, and 504 classification. It also covers
invalid JSON, malformed mapped data, cancellation, and asserts that a credential and raw
response body are absent from the returned `ToolResult`. The injected fetch assertion proves
the trusted `ToolContext.signal` is bridged to `RequestInit.signal`.

R1 adds a never-settling source deadline test, a cancellation-after-start test whose source
later resolves successfully, a never-settling fetch deadline test, and cancellation while a
non-cooperative `response.json()` remains pending. All return the stable cancellation/timeout
code and the derived adapter signal is aborted. A source that throws an `ApiToolsError` whose
message contains a bearer token and URL is returned as the fixed service-error message only.

## 未验证项

- No real customer API, business credential, customer DOM, or page package was used. Those are
  intentionally out of scope; adapter behavior is verified with deterministic local fixtures.
- Cross-package page filling is reserved for task 050, so these tests do not import page
  internals.
- The full workspace gates and packed-consumer gate were not run by this scoped task; package
  build, declarations, standalone registry execution, docs, and task diff checks were run.
