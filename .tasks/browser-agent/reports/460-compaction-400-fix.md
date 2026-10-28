# 460 自动压缩后模型请求 400（2026-09-21）

## 现场证据

- 实际会话“项目问题核对”，最后用户消息“优先级 选最高”；点击工具成功后出现 compact 回执，下一次模型请求返回 400。
- 只读恢复快照：155 个历史条目，checkpoint 覆盖前 154 个，剩余项是 `timed:compact:*:compact_context` 回执。模型为 `deepseek-flash`，通过 `openai-compat` 连接既有 `api.deepseek.com` 端点。
- 压缩前的真实 assistant 工具调用均带 `reasoning_content`；压缩后的协议投影为孤儿 timed 回执合成 assistant，但缺少该字段。通用 adapter 原样发送；DeepSeek 专用 adapter 原有补字段逻辑，因此此前只测专用 adapter 没发现问题。

## 线上最小对照

通过扩展侧栏 DevTools，使用已有连接向同一模型服务发送两条小请求：固定的测试 checkpoint、合成调用和统计回执，max_tokens=64；不发送业务内容、不执行网页工具、不写会话历史。凭据仅在请求闭包中使用，未输出或写入文件。

| 合成 assistant | HTTP | 结果 |
|---|---|---|
| 缺少 reasoning_content | 400 | The `reasoning_content` in the thinking mode must be passed back to the API. |
| reasoning_content 为空字符串 | 200 | finish_reason=stop |

[DeepSeek 官方思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)也明确说明携带 tools 时需要回传该字段。

## 修复

- `packages/agent-core/src/runtime/timedToolResultProjection.ts`：运行时自己生成的 assistant 明确携带空 `reasoning_content`。它没有模型推理过程，因此为空是准确状态；真实模型消息原样保留。
- 合成项仍只在模型请求投影中生成，不写入 timeline，不修改 checkpoint 或 undo 历史。已有压缩会话下次请求自动应用修复，无需清历史或迁移。
- 新增 `browser-agent/agent/src/client.compaction.integration.test.ts`：走实际 browser-agent 装配、通用兼容 transport、压缩工具及 IndexedDB；严格模拟缺字段 400，验证压缩后继续、原始历史不丢、合成项不持久化，以及重建 client 后继续成功。

## 验证

- 新增回归在修复前复现相同 400，修复后通过。
- 7 文件 / 42 测试通过，包含 compaction、timed projection、缓存归因、timed 中断恢复和 client 配置回归。
- `tsc --noEmit -p tsconfig.app.json`、core build、extension build、boundaries、state invariants、`git diff --check` 通过。扩展消费 core 的 dist，已按依赖顺序重建并检查最终 bundle 中的合成消息字段。
- 已刷新实际 Chrome 中的插件侧栏；浏览器读取的新包确认 patched=true，原会话标题与末条用户消息仍在，无初始化错误。未重跑用户业务动作。
- 本次仅修复 400；450 中的 DOM 观察与重复调用问题仍是单独待办。
