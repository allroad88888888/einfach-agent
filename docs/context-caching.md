# Context Caching

> 状态：已实现
>
> 协议版本：`agent-runtime-prefix-v2`
>
> 适用范围：主 Agent、子 Agent、evaluator、distill 和模型 usage 观测

## 核心契约

DeepSeek 和 GLM 的上下文缓存都由 provider 自动完成。本项目不创建、保存或发送 `cache_id`，
也不实现本地 KV cache。

每次模型请求必须发送完整的有效内容：

```text
完整 system
+ compaction 后的完整有效历史
+ 本轮动态控制消息
+ 本轮完整可见 tools
```

缓存是 best-effort 性能优化，不参与正确性判断。不得为了提高命中率：

- 只发送未缓存的后缀；
- 删除消息、工具结果或 reasoning 内容；
- 跳过上下文压缩；
- 猜测 provider 的 TTL、最小缓存长度或 cache key；
- 把 provider 没有返回的指标记为 `0`。

## Provider usage

| Provider | 命中字段 | 未命中字段 | 流式处理 |
| --- | --- | --- | --- |
| DeepSeek | `prompt_cache_hit_tokens` | `prompt_cache_miss_tokens` | 请求加入 `stream_options.include_usage: true`，继续读取 usage-only 尾包 |
| GLM | `prompt_tokens_details.cached_tokens` | 无；仅在 total 合法时派生 | usage 位于最后一个普通 SSE chunk |

`packages/agent-ai` 将 provider 字段归一化为：

```ts
interface CacheUsage {
  hitTokens?: number
  missTokens?: number
  missSource: 'provider' | 'derived' | 'unknown'
  writeTokens?: number
  totalInputTokens?: number
}
```

归一化遵循以下规则：

- 缺失字段保持 `undefined`，不补零。
- GLM 只有在 `totalInputTokens >= hitTokens` 时才派生 miss。
- hit、miss、total 相互矛盾时丢弃整组缓存指标。
- provider 没有返回任何缓存专属字段时，`prompt_tokens` 本身不能证明缓存可用。

对应实现：

- `packages/agent-ai/src/modelApi.ts`
- `packages/agent-ai/src/deepseek.ts`
- `packages/agent-ai/src/glm.ts`

## Lane、Profile 与 Epoch

这些值只是本地诊断标签，不发送给 provider 作为缓存句柄。

支持的 lane：

```ts
type ContextCacheLane =
  | 'main'
  | 'subagent'
  | 'evaluator'
  | 'distill:core'
  | 'distill:child_brief'
```

- **lane**：模型调用职责及逻辑作用域。
- **profile**：vendor、model、system、tools、thinking、tool choice、request mode 等稳定请求形态的指纹。
- **epoch**：同一 lane 中有效请求前缀的本地代数。

仅在尾部追加普通历史时 epoch 保持不变。以下变化会推进 epoch：

- vendor、model、system、thinking 或 request mode 变化；
- tools/schema、allowed tool set 或 tool choice 变化；
- 动态控制项增加、删除、改变，或新历史插入它们之前；
- compaction 或其他投影变化改写实际发送内容；
- 子 Agent 从 tool loop 切换到无工具的最终 synthesis。

指纹使用确定性序列化和 FNV-1a 32-bit，只用于分组诊断，不是安全签名，不得用于授权。
指纹和 trace 不保存 prompt、tool schema、API key 或原始租户身份。

对应实现：`packages/agent-core/src/runtime/contextCache.ts`。

## Compaction 与 lazy tools

正确顺序始终是：

```text
事实历史
  -> 正确性所需的 compaction 投影
  -> 完整模型请求
  -> provider 尽力复用前缀
```

Context cache 不扩大模型窗口，也不替代 compaction。lazy tool schema 继续按需加载；
工具集合变化只记录为 profile/epoch 变化，不预加载全部 schema 来换取表面稳定。

### 压缩投影复用

`compactContext` 是纯函数，每轮拿当轮完整 items 从头重算。items 每轮追加，保护窗口与单元切分点
随之整体后移，产出的投影逐字不同 —— 对 provider 的前缀缓存而言等于每轮换一个 prompt。实测
（2026-07-27，512 次请求）：越过压缩线之后每个 `cache_epoch` 只剩 1 次请求、reason 恒为
`compaction_projection_changed`，占当天全部请求的 45.3%；压缩线之前一个 epoch 能撑 28~92 次。

因此 `compactionPlugin` 记住上一次真压缩的产物及其输入快照，后续轮次在同时满足下面两条时直接
复用该投影、把新增条目原样接在后面：

- 本轮 items 是那份输入的 append-only 延长（逐条引用比较，checkpoint 回滚/revert 天然失配）；
- 旧投影 + 新增原文仍在本轮预算内。

外加一道 CC3 兜底：拼接结果里每条 `role:'tool'` 都必须能在其前面找到声明过该 `tool_call_id` 的
assistant，否则放弃复用。三条中任意一条不成立就回落到完整压缩。

这不违反上面「不得为提高命中率」的禁令：复用发出去的仍是完整 system + 压缩后的完整有效历史，
旧投影本身即一次合法压缩的产物，新增部分是原文，没有只发后缀、也没有跳过压缩（预算每轮照查）。
复用也不会让本该是原文的内容退化成摘要 —— 压缩当轮受 `keepRecentTurns` 保护的那几轮在旧投影里
就是原文，此后新增的也都是原文，被摘要的只有当轮就该摘要的历史部分。

缓存挂在插件闭包上，即 per-run（`runToolLoop` 每个 run 装配一次插件），run 结束随闭包释放。
跨 run 重压一次是有意的：跨 run 必然有新用户输入，保护窗口本就该借机重新取景。

## 可观测性

每次请求记录 profile、epoch、边界指纹和以下指标状态：

```ts
'pending' | 'available' | 'unavailable' | 'request_failed' | 'cancelled'
```

只有 `available` 且字段合法时才累计 hit/miss。统计按当前 profile + epoch 聚合，不把不同 lane
混成单个“对话命中率”。UI 入口是 `apps/web/src/agentNew/ui/ContextStats.tsx`，trace 属性使用
`cache_*` 前缀。

压缩相关的三个 trace 事件各司其职，不要混用：

| 事件 | 语义 |
| --- | --- |
| `llm.context_compacted` | 本轮真执行了一次压缩 |
| `llm.context_over_budget` | 四级降级跑完仍超预算（该开新会话了） |
| `llm.context_projection_reused` | 本轮复用了上一次的压缩投影，未重压；`reuse_count` 表示这份投影已摊了几轮 |

判断投影复用是否真的生效，看 `llm.context_projection_reused` 与 `llm.context_compacted` 的条数
比值，以及 `llm.context_snapshot` 里 `cache_epoch_reason` 为 `compaction_projection_changed`
的占比是否下降。

## 验证

```bash
pnpm exec vitest run packages/agent-ai/src/modelApi.cache.test.ts
pnpm exec vitest run packages/agent-core/src/runtime/contextCache.test.ts
pnpm exec vitest run packages/agent-core/src/runtime/modelRun.test.ts
pnpm exec vitest run packages/agent-core/src/subagents
pnpm build
```

这些测试验证请求整形、流式 usage、归一化、epoch 变化和各模型调用 lane 的接入。
真实 provider 命中率仍受服务端策略影响，live smoke 只能用于观测，不能成为正确性测试。

## Provider 文档

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [GLM Context Caching](https://docs.z.ai/guides/capabilities/cache)
- [GLM Chat Completion API](https://docs.z.ai/api-reference/llm/chat-completion)
