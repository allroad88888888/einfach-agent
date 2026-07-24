# DeepSeek Agent eval

这是一个独立于 UI、设置和 Agent Runtime 的最小协议冒烟骨架。它直接复用
`@web-agent/ai` 的 DeepSeek adapter，用同一套 runner 覆盖：

- `deepseek-v4-pro` / `deepseek-v4-flash`
- thinking enabled / disabled
- stream / non-stream
- 普通回答 / 两轮 tool call

四个维度做笛卡尔积，共 16 个 case。默认测试只使用本地 fake transport，不读取 API Key，
不会访问网络。

## 离线验证

```bash
pnpm exec vitest run evals/deepseek-agent/runner.test.ts
pnpm exec tsc -p evals/deepseek-agent/tsconfig.json
```

离线用例会校验请求矩阵、stream 解析、工具结果回填、thinking 模式下
`reasoning_content` 的完整回传、503 重试，以及统一指标结构。

## 真实 API 冒烟（显式 opt-in）

真实矩阵会产生最多 24 次 chat completion 请求：8 个普通 case 各一次，8 个工具 case
各两次。它有真实费用，并且可能耗时较长。

```bash
DEEPSEEK_LIVE_SMOKE=1 \
DEEPSEEK_API_KEY='...' \
pnpm exec vitest run evals/deepseek-agent/live.smoke.test.ts
```

可选环境变量：

- `DEEPSEEK_BASE_URL`：覆盖 API base URL。
- `DEEPSEEK_SMOKE_CASE_TIMEOUT_MS`：单 case 超时，默认 180000。
- `DEEPSEEK_SMOKE_RESULT_PATH`：覆盖 JSONL 输出路径。

默认结果写入 `evals/deepseek-agent/results/<timestamp>.jsonl`，该目录已被 Git 忽略。
每个 case 记录：

- `success`、`model`、`response_model`
- `thinking`、`effort`、`stream`、`tool_call`
- `latency_ms`、`request_count`、`stream_delta_count`
- `http_status`、`http_statuses`
- `finish_reason`、`finish_reasons`
- `retry_count`、`retry_reasons`
- 输入、输出、总 token 与 cache hit/miss
- 脱敏后的错误名称和消息

记录不包含 API Key、Authorization header、prompt 或模型输出正文。
