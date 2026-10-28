# 140 R1 修复报告

## 修复

独立审查指出原模型 credential 隔离断言没有触发模型 transport，因此不能证明业务 iframe 的 network host 与模型请求隔离。R1 仅修改 `browser-agent/ui/tests/network-preview.integration.test.ts`：

- 使用固定假 endpoint、模型名和 `fixture-model-credential` 保存真实 connection 与 Agent。
- 在业务 iframe 的 capture 活跃期间创建会话并调用 `client.core.sendMessage`，通过生产 Browser Agent transport 执行一次 mock 模型请求。
- mock fetch 记录实际 URL 和 Authorization；测试明确断言调用一次 `https://model.fixture.invalid/v1/chat/completions`，且收到 `Bearer fixture-model-credential`，证明 transport 确实执行。
- 按指定 session 的 `runAtom` 等待 `done`；错误、停止、中断或超时均使测试失败，没有固定等待后直接放行。
- 对业务 capture 中每条请求同时执行 `get_network_request` 和 `get_network_response`，断言完整捕获数据不含模型 endpoint、Authorization credential 或模型响应标记。

没有修改产品源码、fixture 生产装配、锁文件或 README，也没有 install 或真实 provider 请求。

## 验证

- 定向复验：`npx pnpm@10.17.1 exec vitest run browser-agent/ui/tests/network-preview.integration.test.ts browser-agent/ui/tests/tool-preview.integration.test.ts scripts/check-boundaries.test.js` → 3 files / 19 tests 通过。
- 完整 browser-agent：`npx pnpm@10.17.1 exec vitest run browser-agent` → 38 files / 127 tests 通过。
- 根 TypeScript：`npx pnpm@10.17.1 exec tsc -b --pretty false` → 通过。
- `git diff --check` → 通过；修改后的测试 117 行，符合 one-file-one-thing 上限。

编排 CUA 证据 `reports/140-browser-check.md` 已确认真实本地 Vite HTTP 的对话前初始化请求、fetch/XHR 演示与 19 项工具可见。该证据仍只代表纯 Web iframe，不表述为真实 MV3 扩展抓包实测。
