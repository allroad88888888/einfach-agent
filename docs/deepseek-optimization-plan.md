# DeepSeek 专项优化规划

> 基线日期：2026-07-24。依据 DeepSeek V4 官方文档、`deepseek-ai` GitHub 组织资料，
> 以及当前工作区实现审查。原始资料同步入口见
> [`research/deepseek/README.md`](../research/deepseek/README.md)。

## 结论

当前分支已经完成 DeepSeek Agent 集成最重的底座和第一批成功率优化：V4 Pro/Flash
模型名、旧模型迁移、1M 上下文建模、200K 成本软上限、上下文缓存观测、思考内容随工具轮
回填、最多 128 个 function tools、工具 schema 懒加载、稳定 opaque `user_id`、资源不足
恢复，以及结构化 Pro/Flash 子任务路由。下一步重点是用真实 API 和任务 eval 验证收益，
再决定 strict tool calls、缓存布局和专项输出能力，暂不扩大为通用 provider 重构。

最先处理的兼容问题是 `reasoning_effort`。官方 OpenAI Chat Completions API 当前只接受
`high | max`；`low`、`medium` 会被映射为 `high`，`xhigh` 会被映射为 `max`。本轮已经
收紧类型域、加入历史值迁移，并在 DeepSeek adapter 层净化 thinking 模式不支持的采样参数。

## 本轮落地状态（2026-07-24）

- 已同步中英文 API Docs、GitHub 组织仓库元数据和两个 Agent/Integration 项目索引。
- 已完成 DeepSeek `high | max` 类型收口，以及 `low/medium → high`、`xhigh → max` 的
  持久化迁移；GLM 的取值域不受影响。
- 已在流式和非流式入口统一净化 thinking 模式下的 `temperature`、`top_p`、
  `presence_penalty`、`frequency_penalty`，并补齐 tool-call `reasoning_content` 回填测试。
- 已建立 16 组合的离线协议矩阵和显式 opt-in 的真实 API smoke；离线测试已通过。
- 已生成并持久化 `wa_` 前缀的随机 installation id，仅在 DeepSeek 请求中作为 `user_id`
  发送；请求预览、cache profile 和日志脱敏边界已覆盖，存储不可写时会话内仍保持稳定。
- 已为主 Agent 增加一次性的 `insufficient_system_resource` 协议恢复；只在当前 run
  未取消、没有正文/reasoning/raw tool calls 时重放，并记录 retry/recovered/exhausted。
- 已落地可审计的子 Agent 路由：只有结构化标记的低风险根级 retrieval/extraction 使用
  Flash；嵌套、失败、危险能力、跨模块、验收和 evaluator 使用 Pro。安全的 Flash 请求
  可在执行任何工具之前升级一次到 Pro。
- 尚未使用真实 API Key 执行 live smoke；400/422 的 DeepSeek 专项诊断仍属于后续工作。

## 官方能力与当前覆盖

| DeepSeek V4 能力/约束 | 当前状态 | 判断 |
| --- | --- | --- |
| `deepseek-v4-pro` / `deepseek-v4-flash` | 官方模型已接入；主 Agent 使用 Pro，低风险根子任务可用 Flash | 已覆盖结构化路由，待 live A/B |
| 旧 `deepseek-chat` / `deepseek-reasoner` 在 2026-07-24 15:59 UTC 退役 | 已有持久化迁移 | 已覆盖，需加真实 API 冒烟 |
| 1M context / 384K max output | context 已按 1M；默认只预留 8K 输出 | 部分覆盖，需按任务配置输出预算 |
| thinking 默认开启；支持 `high | max` | 已完成 thinking 回填、effort 类型与历史迁移 | 已覆盖 |
| thinking + tool call 后必须完整回传 `reasoning_content` | 主/子 Agent 均保存并回填 | 已覆盖，需协议回归测试 |
| 单次最多 128 个 function tools | 已限制为 `request_tool_schema` + 127 个可见工具 | 已覆盖 |
| strict tool calls 走 `/beta` 且要求全部工具 `strict: true` | 未支持 | P1，小流量试验 |
| 自动 context cache + hit/miss usage | 已采集并观测 | 已覆盖，可继续优化前缀稳定性 |
| `user_id` 用于安全、KV cache、调度隔离 | 已发送 installation-scoped opaque id；非 DeepSeek 不发送 | P1 已完成，服务端隔离效果待 live 验证 |
| 429、500、503 与 `insufficient_system_resource` | HTTP 保留 adapter 重试；主 Agent 资源不足协议重放一次；Flash 子任务可升级一次 | P1 已完成安全子集 |
| 非流式空行、流式 SSE `: keep-alive` | 当前解析路径可兼容 | 已覆盖，补测试即可 |
| JSON Output / Prefix Completion / FIM | 未接入 | P2，按真实场景选择性接入 |
| `/models` 模型发现 | 模型名硬编码 | P2，用于设置页校验与下线预警 |
| OpenAI 与 Anthropic 两套接口 | 当前使用 OpenAI 格式 | 保持现状；Anthropic 仅做互操作测试 |

## 优化工作包

### P0：V4 协议正确性与退役日收口（代码与离线矩阵已完成）

1. 把 DeepSeek effort 类型收口为 `high | max`，迁移历史中的 `low/medium → high`；
   UI 与默认值同步。不要把 GLM 的取值域混入 DeepSeek。
2. 在 DeepSeek 请求归一化层做到：
   - thinking 开启时不发送会被忽略的 `temperature`、`top_p`、presence/frequency penalty；
   - thinking 关闭时才允许采样参数；
   - tool-call 续轮强校验上一条 assistant 的完整 `reasoning_content` 是否仍在。
3. 对 Pro/Flash、thinking on/off、stream/non-stream、tool call 做最小真实 API 冒烟矩阵；
   尤其验证旧模型名在退役后的实际错误和迁移路径。
4. 增加 400/422 的可诊断错误分类：明确区分 model 已下线、effort 不合法、
   reasoning 内容漏回填、工具 schema 不兼容。

验收：

- 类型层无法构造 `reasoning_effort: low|medium`；
- 16 组离线协议冒烟全通过，真实 API 矩阵在提供 Key 后执行；
- tool-call 续轮没有因 `reasoning_content` 缺失产生的 400；
- 旧会话恢复后不再向服务端发送旧模型名。

### P1：DeepSeek Agent 成功率与隔离（核心代码已完成）

1. 已增加隐私安全的稳定 `user_id`：
   - 使用本地生成的随机 installation id 或业务侧不可逆 opaque id；
   - 不包含邮箱、路径、姓名等隐私；
   - 同一安装跨轮、跨工作区稳定；不同浏览器 profile/安装实例自然隔离；
   - 缺失或非法历史值会修复，持久化不可用时使用当前 storage wrapper 的内存 shadow；
   - adapter 只接受最多 512 字节的 `[A-Za-z0-9_-]+`，非法值直接丢弃。
2. 已增加 provider-aware 恢复策略的安全子集：
   - HTTP 网络错误、429 和 5xx 继续由 adapter 负责，runtime 不重复实现 HTTP 重试；
   - `finish_reason=insufficient_system_resource`：仅在当前 run、未取消、尚无正文、
     reasoning 或原始 tool calls 时自动重放一次；
   - 子 Agent 的 Flash 请求可在任何工具执行前升级一次 Pro；执行过任意工具后 fail-closed，
     防止同名工具覆写或“产生副作用后抛错”导致重复执行；
   - 400/401/402/422 不做盲目重试。
3. 待做：strict tool calls feature flag：
   - 单独使用 `https://api.deepseek.com/beta`；
   - 启动时检查所有可见工具 schema 是否属于官方支持的 JSON Schema 子集；
   - 先在只读工具和 10% eval 流量启用，对比参数解析失败率、400 率和任务成功率；
   - 不要直接全量切换，因为当前工具 schema 与 beta 子集的兼容性尚未验证。
4. 待做：缓存命中请求布局优化：
   - system、稳定工具定义、skill 固定正文保持稳定顺序；
   - 每轮变化的状态、游标、时间信息尽量后置；
   - 用现有 hit/miss 指标输出每种请求 profile 的命中率、首 token 延迟和输入成本。

验收：

- 本地已验证 id 的生成、修复、实例隔离、请求边界和脱敏；KV cache 服务端隔离待 live 验证；
- 资源不足协议重放和 Flash→Pro 次数已可观测；429/503 的成功率基线待 live eval；
- strict 试验组工具参数失败率相对基线下降，且 400 率不升高；
- 长会话缓存命中率、P50/P95 首 token 延迟和每成功任务成本有基线对照。

### P1：Pro / Flash 任务路由（核心代码已完成，待 A/B）

保持“主 Agent 默认 Pro、子 Agent 可 Flash”的安全基线，在其上增加显式策略，而不是按字符串
或 prompt 长度拍脑袋：

| 任务特征 | 首选 | 升级条件 |
| --- | --- | --- |
| 结构化标记为低风险的根级 retrieval / extraction | Flash + high | 任何工具执行前遇到可恢复 provider 故障时升级一次 |
| 跨模块修改、架构决策、复杂调试、最终验收 | Pro + max | 不自动降级 |
| 嵌套子任务、历史失败、evaluator、危险能力 | Pro + max | 保持 Pro |
| 主 Agent 规划、风险操作决策、未分类任务 | Pro + max | 保持 Pro |

路由器只使用可观测的结构化特征：父路径、任务类别、历史失败、风险级别、跨模块标记、
是否最终验收、mode 和已确认危险能力。每次决定记录 `route_reason` 和 `fallback_count`。
自定义 DeepSeek 模型及非 DeepSeek provider 保留父模型配置并走保守策略，不会静默替换为
官方 Pro/Flash SKU。

当前 `modelTier: pro | flash` 表示子任务策略 lane；非 DeepSeek provider 的实际 model 始终
以归档的 `model` 字段为准。把 lane 与 provider-neutral model identity 拆开列入 P2，避免
在 GLM 等 provider 的观测界面中把保守 lane 误解为 DeepSeek Pro。

验收：

- 与“全 Pro”基线相比，任务成功率下降不超过 1 个百分点；
- 每成功任务输入+输出费用降低至少 25%；
- Flash→Pro 升级后的挽回率可观测，且无无限重试。

### P2：DeepSeek 专项功能（3～5 天，按 eval 收益排队）

1. `/models`：设置页动态校验可用模型；保留硬编码 fallback，避免发现接口异常阻塞运行。
2. JSON Output：仅用于计划快照、结构化评估等“必须输出 JSON 且不适合 tool call”的路径；
   prompt 明确包含 JSON 和样例，并处理官方说明的空 content 情况。
3. Chat Prefix Completion：只在需要强制回答前缀/格式时试验，不放进通用 tool loop。
4. FIM：用于局部代码补全/补洞，不取代 Agent 的读—改—测工具链；thinking 模式下不启用。
5. Anthropic API 互操作：作为兼容测试或未来接入 Claude 生态的备选，不与现有 OpenAI 格式
   同时维护两套核心 runtime。
6. 路由观测模型中立化：把 `routeLane` 与实际 `vendor/model` 分离，归档和 replay 不再用
   `pro | flash` 表达非 DeepSeek 模型身份。

## DeepSeek Agent Eval

没有 eval，就无法判断“针对 DeepSeek 优化”究竟是在提效还是只是在加参数。建议先建一套
20～40 个可重复任务的小型基准：

- 工具选择：正确发现并加载 schema、并行/串行工具调用、坏参数自愈；
- 代码任务：单文件修复、跨包修改、测试失败诊断、长输出截断恢复；
- 长上下文：50K/200K/500K 三档，检查事实保持、缓存命中和压缩边界；
- 子 Agent：Flash 分工、证据回收、Pro 升级、预算耗尽；
- 故障注入：429、503、流中断、`insufficient_system_resource`、旧模型名、错误 effort；
- 安全：危险工具确认、跨用户 cache 隔离、日志脱敏。

每个任务至少记录：

```text
task_success
tool_call_success / schema_error / tool_recovery_turns
model / thinking / effort / route_reason / fallback_count
input_tokens / cache_hit_tokens / output_tokens / estimated_cost
time_to_first_token / wall_time / model_calls
http_status / finish_reason / retry_count
```

发布门槛以“每成功任务成本”为核心，不只看单 token 单价：

- 成功率不得低于当前基线；
- P95 任务时延不恶化超过 10%；
- 400/422 工具协议错误率低于 0.5%；
- 无重复副作用工具调用；
- 任务成本下降达到路由试验预设目标。

## 推荐实施顺序

```text
P0 协议修正 + 离线冒烟（完成）
  → user_id / 安全恢复 / 结构化路由（完成）
  → 真实 API smoke + 固化 eval 基线
  → Pro/Flash 路由 A/B 与成本/成功率门槛
  → strict tool calls 小流量试验
  → JSON / Prefix / FIM 按基准收益选择
```

当前实现阶段已完成 P0、eval 骨架和 P1 安全子集。发布前的关键缺口不是继续增加启发式，
而是使用真实 Key 执行协议 smoke，并跑任务级 Pro/Flash A/B，确认成功率、时延、缓存命中
和“每成功任务成本”达到上述门槛。

## 官方资料入口

- API Docs: <https://api-docs.deepseek.com/>
- V4 发布说明: <https://api-docs.deepseek.com/news/news260424/>
- Models & Pricing: <https://api-docs.deepseek.com/quick_start/pricing/>
- Thinking Mode: <https://api-docs.deepseek.com/guides/thinking_mode/>
- Tool Calls: <https://api-docs.deepseek.com/guides/tool_calls/>
- Context Caching: <https://api-docs.deepseek.com/guides/kv_cache/>
- Rate Limit & Isolation: <https://api-docs.deepseek.com/quick_start/rate_limit/>
- Chat API: <https://api-docs.deepseek.com/api/create-chat-completion/>
- GitHub organization: <https://github.com/deepseek-ai>
- Agent projects: <https://github.com/deepseek-ai/awesome-deepseek-agent>
- Integration projects: <https://github.com/deepseek-ai/awesome-deepseek-integration>
