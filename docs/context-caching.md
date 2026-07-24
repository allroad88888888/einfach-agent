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

## 可观测性

每次请求记录 profile、epoch、边界指纹和以下指标状态：

```ts
'pending' | 'available' | 'unavailable' | 'request_failed' | 'cancelled'
```

只有 `available` 且字段合法时才累计 hit/miss。统计按当前 profile + epoch 聚合，不把不同 lane
混成单个“对话命中率”。UI 入口是 `apps/web/src/agentNew/ui/ContextStats.tsx`，trace 属性使用
`cache_*` 前缀。

## 验证

```bash
pnpm exec vitest run packages/agent-ai/src/modelApi.cache.test.ts
pnpm exec vitest run packages/agent-core/src/runtime/contextCache.test.ts
pnpm exec vitest run packages/agent-core/src/runtime/modelRun.test.ts
pnpm exec vitest run packages/agent-core/src/subagents/runtime.test.ts
pnpm build
```

这些测试验证请求整形、流式 usage、归一化、epoch 变化和各模型调用 lane 的接入。
真实 provider 命中率仍受服务端策略影响，live smoke 只能用于观测，不能成为正确性测试。

## Provider 文档

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [GLM Context Caching](https://docs.z.ai/guides/capabilities/cache)
- [GLM Chat Completion API](https://docs.z.ai/api-reference/llm/chat-completion)
