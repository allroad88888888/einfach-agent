# DeepSeek Agent eval

这套 eval 直接复用 `@web-agent/ai` 的 DeepSeek adapter，分为三层：

1. 离线协议矩阵：不读取 API Key、不访问网络；
2. 真实 API 协议 smoke：验证请求形状和工具续轮；
3. 真实任务级 A/B：比较全 Pro、全 Flash 和结构化影子路由。

真实结果默认写入 `evals/deepseek-agent/results/`，该目录被 Git 忽略。记录不包含 API Key、
Authorization header、prompt、工具参数或模型输出正文。

## 离线验证

```bash
pnpm exec vitest run \
  evals/deepseek-agent/runner.test.ts \
  evals/deepseek-agent/task-runner.test.ts \
  evals/deepseek-agent/task-report.test.ts \
  evals/deepseek-agent/task-cost.test.ts

pnpm exec tsc -p evals/deepseek-agent/tsconfig.json --noEmit
```

协议 runner 覆盖：

- `deepseek-v4-pro` / `deepseek-v4-flash`
- thinking enabled / disabled
- `high` / 针对性的 `max`
- stream / non-stream
- 普通回答 / 两轮 tool call
- thinking 请求不发送显式 `tool_choice`
- 工具续轮保留 `reasoning_content`
- assistant `content: null → ""` 的请求副本规范化
- SSE `response_model`、503 重试和统一指标

任务 runner 使用 10 个确定性任务和只读 synthetic tools，覆盖检索、版本解析、时间归一化、
安全分级、变更计划、JSON 结构化输出、分阶段 canary、实现、验收及值提取。

## 真实 API 协议 smoke

完整矩阵包含 16 个笛卡尔积 case，另加两个 `max` 的针对性 case，共 18 个。工具 case
需要两轮请求，因此一次完整执行最多产生 27 次 chat completion 请求。

```bash
DEEPSEEK_LIVE_SMOKE=1 \
DEEPSEEK_API_KEY='...' \
pnpm exec vitest run evals/deepseek-agent/live.smoke.test.ts
```

可选环境变量：

- `DEEPSEEK_BASE_URL`：覆盖 API base URL。
- `DEEPSEEK_SMOKE_CASE_TIMEOUT_MS`：单 case 超时，默认 180000。
- `DEEPSEEK_SMOKE_RESULT_PATH`：覆盖 JSONL 输出路径。

每个 case 记录：

- `success`、请求 `model`、服务端 `response_model`
- `thinking`、`effort`、`stream`、`tool_call`
- `latency_ms`、`request_count`、`stream_delta_count`
- `http_statuses`、`finish_reasons`
- `retry_count`、`retry_reasons`
- 输入、输出、总 token 与 cache hit/miss
- 不含正文的请求形状布尔证据和脱敏错误

### 2026-07-24 协议基线

- 首轮 12/16；4 个 thinking + tool case 被 API 以 400 拒绝：
  `Thinking mode does not support this tool_choice`。
- adapter 修复并加固观测后：**18/18 成功**，所有 `response_model` 均有值。
- 覆盖 Pro `max` 非流式工具续轮、Flash `max` 流式普通回答。
- 汇总：8,037 total tokens、5,376 cache-hit、1,676 cache-miss。
- 脱敏结果：
  `results/2026-07-24T09-50-27.962Z.jsonl`。

## 真实任务级 Pro/Flash A/B

```bash
DEEPSEEK_TASK_AB=1 \
DEEPSEEK_API_KEY='...' \
DEEPSEEK_TASK_REPEATS=3 \
pnpm exec vitest run evals/deepseek-agent/task.live.test.ts
```

可选环境变量：

- `DEEPSEEK_TASK_REPEATS`：每个任务、每种 model 的重复次数，默认 3。
- `DEEPSEEK_TASK_RESULT_PATH`：覆盖 JSONL 输出路径。
- `DEEPSEEK_TASK_CASE_TIMEOUT_MS`：单次运行超时。
- `DEEPSEEK_BASE_URL`：覆盖 API base URL。

runner 先为每个任务执行 Pro 和 Flash；report 再按
`computeDeepSeekSubagentRoute` 的结构化决定生成 shadow 指标，不会为影子路由重复调用 API。
成本按官方价格和完整 usage 精确计算：

| 模型 | Cache hit 输入 | Cache miss 输入 | 输出 |
| --- | ---: | ---: | ---: |
| Flash | $0.028 / 1M | $0.14 / 1M | $0.28 / 1M |
| Pro | $0.03625 / 1M | $0.435 / 1M | $0.87 / 1M |

缺少 cache 明细或服务端 model identity 时标记为保守上界，不伪造精确费用，也不会产生
`NaN`。

发布门槛：

- 成功率相对全 Pro 下降不超过 1 个百分点；
- P95 不超过全 Pro 的 1.10 倍；
- tool protocol error 不超过 0.5%；
- 每成功任务成本下降至少 25%；
- paired regression、hard/protocol failure 和重复副作用均为 0；
- 总成本节省必须为正。

### 2026-07-24 任务基线

10 tasks × 3 repeats × 2 models = 60 次真实运行、30 个配对：

| 指标 | 全 Pro | 全 Flash | 结构化影子路由 |
| --- | ---: | ---: | ---: |
| 通过 | 29/30 | 26/30 | 29/30 |
| 平均得分 | 98.50 | 89.33 | 97.50 |
| P95 | 17,573 ms | 12,293 ms | 17,573 ms |
| 总成本 | $0.007472720 | $0.002764182 | $0.006624259 |
| 每成功任务成本 | $0.000257680 | $0.000106315 | $0.000228423 |

影子路由的质量、安全、协议和时延门槛均通过；每成功任务成本只下降 11.35%，低于 25%，
所以 **release gate 失败**。适合 Flash 的 T01/T09/T10 子队列本身 9/9 通过，成本下降约
60.46%，但不能用这个有利子集替代全量发布判断。

脱敏结果：
`results/2026-07-24T10-14-25.664Z.task-ab.jsonl`。

`task.live.test.ts` 会在 gate 失败时非零退出。即使所有请求本身都成功，也不应把这一结果
当成测试故障或绕过断言；它表示当前策略还不能发布。
