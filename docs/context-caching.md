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

早期实现用 `compactContext`（纯函数，按 turn/unit 边界切分、`keepRecentTurns` 保护最近若干轮
原文）每轮从头重算整份投影；items 每轮追加，切分点随之整体后移，产出的投影逐字不同 —— 对
provider 的前缀缓存而言等于每轮换一个 prompt。实测（2026-07-27，512 次请求）：越过压缩线之后
每个 `cache_epoch` 只剩 1 次请求、reason 恒为 `compaction_projection_changed`，占当天全部请求的
45.3%；压缩线之前一个 epoch 能撑 28~92 次。

**这条路径现在已经不跑了。** `compactContext` / `keepRecentTurns` 仍留在
`packages/agent-core/src/runtime/contextCompaction.ts`，但生产请求不再调用它，唯一的调用方是
它自己的单测。压缩不再是插件：`packages/agent-core/src/runtime/core/plugins/compactionPlugin.ts`
连同它的复用缓存已随 A1 整个删除（提交 `64d7df4`），真正跑的是 `modelTurnRequester.ts` 的
**内联 checkpoint 蒸馏**：

- 每次请求先用 `projectContextCheckpoint`（`contextCheckpointProjection.ts`）尝试复用会话上一次
  保存的 checkpoint：checkpoint 记录 `coveredItemIds`，逐条按 id 比对当前 history 的前缀——
  精确匹配就复用摘要、把后面新增的条目原样接在后面；id 不匹配（checkpoint 回滚/revert 天然
  失配）就判 `invalidCheckpoint` 并清空。
- `contextNeedsDistillation` 判定投影后的请求是否仍超预算；超了才触发
  `createContextCheckpoint`（`contextDistillation.ts`）——**让模型自己**把「稳定前缀 + 当前投影
  （旧摘要或原文）」整段读一遍，产出一份新的 checkpoint 摘要文本，覆盖面是**这一刻的全部
  history**（不再有 `keepRecentTurns` 那样固定保留最近 N 轮原文不摘要的窗口）。
- 新 checkpoint 存进 `contextCheckpointAtom`（经 `setContextCheckpointOnSession`）。这是一个
  **会话级、持久化的槽位**（`SESSION_SLOTS.contextCheckpoint`，进 `RecoverySnapshotV1`），不是
  per-run 的插件闭包 —— 它跨 run 存活，直到被新 checkpoint 覆盖，或因历史不再前缀匹配而失效。
- `preCompact` / `postCompact` 两个到点时机由 `modelTurnRequester.ts` 自己的
  `dispatchCompactionTiming` 在蒸馏前后直接分派（C1，提交 `0cd3200`），不再经插件 hook 转发。

这不违反上面「不得为提高命中率」的禁令：复用发出去的仍是完整 system + 有效历史投影（摘要 + 新增
原文），旧 checkpoint 本身即一次合法蒸馏的产物，没有只发后缀、也没有跳过预算检查——是否需要新一
轮蒸馏每次请求都重新经 `contextNeedsDistillation` 判定。

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
pnpm exec vitest run packages/agent-core/src/runtime/modelRun.singleTurn.test.ts
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
