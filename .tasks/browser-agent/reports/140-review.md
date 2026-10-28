# 140 独立审查

结论：**REJECTED**。

审查范围为 `140-network-preview.md`、`reports/140-report.md`、`reports/140-scope.diff` 及当前实现。`completion_requires` 中 120/130 尚未标记 done，因此本结论只评价 140 自身，不外推上游实现已经最终验收。根 CUA 仍由编排收口；本次未伪造浏览器实测结论。

## Important

1. **“模型 credential 未进入业务 Window”的自动化断言没有实际触发模型请求，属于恒通过证据。** `browser-agent/ui/tests/network-preview.integration.test.ts:17-25` 创建 client，并把标记字符串只放在模型 `fetch` 的返回正文里；整个测试随后只直接运行六个 network 工具以及业务 iframe 的 `loadCities`/XHR（`browser-agent/ui/tests/network-preview.integration.test.ts:27-45`），从未创建会话或调用 `sendMessage`，所以该模型 fetch 根本不会执行。`JSON.stringify(active)` 不含标记的断言（`browser-agent/ui/tests/network-preview.integration.test.ts:41`）在模型流量从未发生时无法证明隔离。报告将其概括为不会读到模拟模型 credential，证据强于实际覆盖。应在 recorder 活跃期间真实触发一次使用该 mock transport 的模型请求（最好同时记录调用次数），再证明业务 iframe capture 中既没有该请求/响应标记，也没有模型 Authorization 值；或用等价的、确实经过生产 transport 装配的定向测试证明边界。

## 已核实且无新增发现

- `createFixtureBusiness` 在写入业务文档及初始化 cities fetch 前安装 recorder；后建 network host 和 Agent，顺序满足对话前请求要求。
- 演示通过真实 registry 执行 start（buffered）→ list/getResponse → 新 fetch/XHR → wait/list/getRequest/getResponse → stop；Vite middleware 提供本地真实 HTTP 路由，没有手工填充请求记录。
- `includeBuffered:false`、另一 iframe 隔离、stop 后不新增记录均有定向覆盖。
- catalog 断言为 19 项；UI 生产源码没有引入具体 network 工具包，依赖仅在 UI `devDependencies`。
- embedded 示例使用公开 network 包且不依赖 React/Chrome；README 说明注入时点、TTL/容量、fetch/XHR 与未覆盖边界。
- lock diff 为 25 行新增，内容限 workspace importer/link；未见版本升级。
- 报告准确把真实 MV3/CUA 标为 pending，未宣称已通过。

## 定向复验

`npx pnpm@10.17.1 exec vitest run browser-agent/ui/tests/network-preview.integration.test.ts browser-agent/ui/tests/tool-preview.integration.test.ts scripts/check-boundaries.test.js`

结果：3 files / 19 tests passed。
