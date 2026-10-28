# 140 R1 独立复审

结论：**PASSED**。

本次仅复审原 Important、R1 窄 diff 与变更引入风险，没有重复执行已通过测试。`completion_requires` 的 120/130 尚未 done，因此本结论只表示 140 叶自身通过，不外推上游最终验收。

## 原 Important 复核

原问题已修复。`browser-agent/ui/tests/network-preview.integration.test.ts:34-36` 通过公开配置入口保存带固定 credential 的 connection、Agent 并创建会话；`browser-agent/ui/tests/network-preview.integration.test.ts:49-51` 在业务 capture 活跃期间调用 `client.core.sendMessage`，等待指定 session 到达 `done`，并断言生产 transport 确实向预期 endpoint 发出一次请求且携带预期 Authorization。该证据消除了原先 mock fetch 未执行导致的恒通过问题。

随后测试读取 capture 中每条记录的 request 与 response 详情（`browser-agent/ui/tests/network-preview.integration.test.ts:52-58`），并分别拒绝模型 endpoint、credential 和模型响应标记（`browser-agent/ui/tests/network-preview.integration.test.ts:59-61`）。这覆盖了业务 Window recorder 与模型 transport 的隔离边界，且未依赖只检查列表摘要。

`waitForRun` 对 error/stopped/interrupted 明确失败，并有有限超时（`browser-agent/ui/tests/network-preview.integration.test.ts:108-116`）；未发现 R1 引入的新问题。

## CUA 证据复核

`reports/140-browser-check.md` 记录了真实本地 Vite HTTP 下可见的对话前初始化请求、响应正文、后续 fetch/XHR 演示结果，以及配置页 19 个工具名称。报告明确限定为纯 Web iframe 检查，并说明不是 MV3 `document_start` 真实扩展抓包实测，范围表述准确。

## 验证证据

- R1 报告记录定向 3 files / 19 tests、完整 browser-agent 38 files / 127 tests、根 TypeScript 与 diff check 全部通过。
- `reports/140-parent-test.log` 记录编排侧再次运行该测试文件：1 file / 2 tests passed。
- 按复审要求，本次未重复运行测试。
