# 090 API 来源发现

已在 `@einfach-agent/tools-browser-api` 增加公开合同：

```ts
interface OptionsSourceInfo { id: string; label?: string; description?: string }
interface ListOptionsSourcesInput { offset?: number; limit?: number }
interface ListOptionsSourcesResult { sources: readonly OptionsSourceInfo[]; nextOffset?: number }
interface ApiToolsHost {
  queryOptions(input: QueryOptionsInput, ctx: ApiCallContext): Promise<QueryOptionsResult>
  listSources?(input: ListOptionsSourcesInput, ctx: ApiCallContext): Promise<ListOptionsSourcesResult>
}
function createListOptionsSourcesTool(host: ApiToolsHost): Tool
```

`createApiToolsHost` 现在实现可选的 `listSources`。每次调用先检查取消状态，再按注册顺序逐一重新计算
`isSourceAllowed(sourceId, sessionId)`，之后才分页；默认 `limit` 为 20，范围为 1–100。发现结果只复制
已注册的 `id` 与最多 500 字符的 `label`、`description`。不会运行 adapter、执行查询或发起网络请求，也
不会公开 URL、headers、credentials 或其他 source 属性。权限回调抛出的内容映射为固定安全错误。

`registerApiTools` 始终注册原有 `query_options`，仅当 `host.listSources` 存在时注册新工具，保留 legacy
host 兼容。新增工具目录包含实现、中文说明和测试；README 说明先发现再查询的调用方式。

验证：

- `pnpm exec vitest run browser-agent/tools/api/src` — R1 后 3 files、26 tests 通过。
- `pnpm --filter @einfach-agent/tools-browser-api build` — 通过。
- `node scripts/check-docs.js` — 559 Markdown files 通过。
- `git diff --check -- browser-agent/tools/api` — 通过。
- 文件行数检查：最大源码文件 `options-host.ts` 为 213 行；新增工具实现 40 行、测试 92 行、说明 7 行。

测试覆盖 registry 内的发现→查询闭环、A/B 会话隔离、权限即时变动、授权后分页、空列表、取消、schema 与
host 直接调用的非法参数、权限异常脱敏、metadata 白名单、来源数组后续变动隔离，以及仅有 `queryOptions`
的 legacy host。

## R1 修正

独立审查发现发现功能意外收紧了既有 source 注册条件。现已恢复 `createApiToolsHost` 原有的非空 trim 与
重复 ID 校验，不再在构造 host 时限制 source ID 长度或检查 `query` 的运行时类型。新增 501 字符 ID 回归：
host 可按旧合同创建，而 `query_options` 仍在原有的输入校验阶段拒绝该 ID。定向复验：
`pnpm exec vitest run browser-agent/tools/api/src`、`pnpm --filter @einfach-agent/tools-browser-api build`、
`node scripts/check-docs.js` 均通过（测试 3 files、26 tests；文档 561 files）。
