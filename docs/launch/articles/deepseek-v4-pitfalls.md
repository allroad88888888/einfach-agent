# DeepSeek V4 thinking 协议踩坑实录：六个把请求打回 400 的地方

给用 OpenAI 兼容 SDK 接 DeepSeek `/chat/completions` 的工程师。都是在一个带工具调用（function
calling）的 Agent 里跑真实多轮时踩到的，不是读文档想出来的。每个坑一节，按现象（报错原文）、
根因、最小修复展开。适用范围：`https://api.deepseek.com` 的 `deepseek-v4-pro` /
`deepseek-v4-flash`，开启 thinking + 工具调用的多轮场景。下文代码是我们 adapter
（`packages/agent-ai/src/deepseek.ts`）的简化版，去掉了重试和 SSE 解析等无关部分。

一句话结论：**thinking 模式改的不只是响应，它改了请求的合法性规则**——历史消息要多带一个字段，
一批采样参数要整个剥掉，而且你不声明 thinking 也可能被按 thinking 校验。

| # | 坑 | 一句话 |
| --- | --- | --- |
| 1 | `reasoning_content ... must be passed back` 400 | 工具调用续轮要回传 assistant 的 `reasoning_content` |
| 2 | 别名被静默路由到 thinking 家族 | 请求里没写 thinking，服务端一样按 thinking 校验 |
| 3 | thinking 不接受采样参数和 `tool_choice` | adapter 层剥掉，且不能改调用方的对象 |
| 4 | 流式拿不到 usage | 少了 `stream_options.include_usage: true` |
| 5 | `finish_reason=insufficient_system_resource` | 私有终态，HTTP 200，通用重试中间件看不见 |
| 6 | `user_id` 非法值 | 该整体丢弃，不该"修剪"后继续发 |

## 坑一：thinking 下工具调用续轮必须回传 `reasoning_content`

**现象**：第一轮永远正常，把工具结果拼回历史继续跑的第二轮直接 400，body 里的关键字是：

```text
HTTP/1.1 400 Bad Request
... reasoning_content ... must be passed back ...
```

触发它的历史长这样（key 一律用 `sk-***` 占位，别把真 key 贴进 issue）：

```json
{"role": "assistant", "content": null,
 "tool_calls": [{"id": "call_read", "type": "function",
                 "function": {"name": "read_file", "arguments": "{}"}}]}
```

**根因**：thinking 家族要求**推理链在多轮之间可追溯**——模型上一轮产出的 `reasoning_content`
属于对话状态的一部分，续轮必须原样回传，否则服务端认为历史被截断，拒绝整个请求。两个额外陷阱：

- **同一条消息的 `content` 不能是 `null`。** OpenAI 协议里纯工具调用轮写 `content: null` 是标准
  做法，很多 SDK 的类型就是 `string | null`；DeepSeek 这里要一个字符串。
- **有些 assistant 轮根本没有推理正文。** 我们的 runtime 会为孤儿工具结果合成配对的 assistant
  消息（把生命周期工具的输出投影进历史），它天生没有 `reasoning_content`。**实测补空串 `""`
  可以过校验**——服务端要的是"字段在"，不是"字段有内容"。

**最小修复**：发请求前归一化历史，只碰"assistant 且带 tool_calls"这一类消息。

```ts
function normalizeToolCallTurns(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.tool_calls?.length) return message
    const content = message.content === null ? '' : message.content
    const reasoning =
      typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    if (content === message.content && reasoning === message.reasoning_content) return message
    return { ...message, content, reasoning_content: reasoning }
  })
}
```

它 `map` 出新数组、`{ ...message }` 出新对象，不原地改调用方的历史——UI 里存的还是
`content: null` 的原始消息，只有发到线上的那份被归一化。

## 坑二：别名被静默路由到 thinking 家族，"我没开 thinking"不成立

**现象**：请求里压根没有 `thinking` 字段，模型名写的是老别名 `deepseek-chat`，一样收到坑一的
400。响应体里的 `model` 字段暴露了真相：请求 `deepseek-chat`，返回 `"model": "deepseek-v4-flash"`。

**根因**：服务端把老别名静默路由到了 V4 thinking 家族。**"是否按 thinking 规则校验"由服务端实际
解析到的模型决定，不由你请求里的开关决定。** 如果归一化写成
`if (body.thinking?.type === 'enabled') { 补 reasoning_content }`，那么走别名、走默认模型、走
用户自定义模型名的路径全部漏网，而且是间歇性的——取决于服务端当天把别名指向谁。反过来，非
thinking 路径上多带一个 `reasoning_content: ""` 有没有副作用？**实测没有，能过校验**。

**最小修复**：把消息归一化提到 thinking 分支**外面**，无条件执行。

```ts
function prepareRequest(body: DeepSeekChatRequest): DeepSeekChatRequest {
  // 不看 body.thinking：服务端可能把别名路由到 thinking 家族
  const messages = normalizeToolCallTurns(body.messages)
  // ...
}
```

一般化的教训：凡是"服务端可以在你背后换模型"的字段（模型别名、默认模型、灰度），都不能拿它当
客户端分支条件。要么无条件按最严格的规则组装请求，要么锁定完整模型名。

## 坑三：thinking 开启时不接受采样参数和 `tool_choice`

**现象**：thinking 开启 + 请求里带 `temperature` / `top_p` / `presence_penalty` /
`frequency_penalty` 任意一个，或者带了 `tool_choice`，请求被拒。用户侧的症状很迷惑：**同一个
会话，把"深度思考"开关一打开就再也发不出消息**，因为设置面板里的 temperature 一直在。

**根因**：thinking 的采样策略由服务端接管，这几个参数没有语义位置；`tool_choice`（强制某个工具、
强制调用）同理，会和推理阶段的工具决策冲突。协议选择了报错而不是忽略。

**最小修复**：在 adapter 层剥掉，**但不能改调用方传进来的对象**——会话设置里那份 temperature 是
用户配置，关掉 thinking 之后还要用。解构 + 重新组装，天然不写原对象。

```ts
function prepareRequest(body: DeepSeekChatRequest): DeepSeekChatRequest {
  const {
    tool_choice, temperature, top_p, presence_penalty, frequency_penalty,
    ...base
  } = body
  const messages = normalizeToolCallTurns(body.messages)

  if (body.thinking?.type === 'enabled') return { ...base, messages }   // 五个字段已被解构摘走
  return { ...base, messages, tool_choice, temperature, top_p, presence_penalty, frequency_penalty }
}
```

测试断言两件事：新请求体上这五个字段不存在（用 `not.toHaveProperty`，别写 `toBeUndefined`
——`JSON.stringify` 会丢 undefined，两者在线上等价但在断言上不等价），以及**传入的 body 没被改动**。

## 坑四：流式不加 `stream_options.include_usage` 就没有 usage

**现象**：`stream: true` 的请求跑完，SSE 消费到 `[DONE]`，最终响应的 `usage` 是 `undefined`。
缓存命中率、token 成本统计全线为空，非流式调用却一切正常。

**根因**：流式响应默认不带 usage。只有 `stream_options.include_usage` 为 `true` 时，DeepSeek 才会
在 `[DONE]` 之前**补发一个只带 `usage`、`choices` 为空的最终 chunk**。缓存计费口径
（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）就在这个 chunk 里，拿不到它等于放弃了
上下文缓存的可观测性。

**最小修复**：在流式入口注入默认值。

```ts
function withStreamUsage(body: DeepSeekChatRequest): DeepSeekChatRequest {
  return {
    ...body,
    stream_options: {
      ...body.stream_options,
      include_usage: body.stream_options?.include_usage ?? true,
    },
  }
}
```

用 `?? true` 而不是硬写 `true`：显式传 `false` 的调用方仍然说了算。另外 SSE 解析器要能处理
"`choices` 为空数组的 chunk"，别在 `choices[0]` 上直接解引用。

## 坑五：`insufficient_system_resource` 是 HTTP 200 的失败

**现象**：请求返回 200，SSE 正常结束，但 `finish_reason` 是 OpenAI 协议里没有的值，内容为空或
半截：

```json
{ "choices": [ { "delta": {}, "finish_reason": "insufficient_system_resource" } ] }
```

**根因**：这是 DeepSeek 私有的终态——**服务容量不足**。它不是 429、不是 5xx，所以基于 HTTP 状态码
的重试中间件、SDK 自带的 `maxRetries` 全都不触发，在传输层看这是一次成功的请求。它值得做一次自动
重试（容量抖动通常几秒内恢复），但有硬约束：**已经吐出内容的请求绝对不能重放**。流式 delta 已经
进了 UI，重放会让用户看到同一段话说两遍；工具调用同理，重放可能让副作用执行两次。

**最小修复**：在流式入口外面包一层循环，重试条件卡死"零输出"。

```ts
for (;;) {
  let emittedOutput = false
  const response = await postChatCompletionStream(url, withStreamUsage(prepareRequest(body)), options, {
    onDelta(delta) {
      emittedOutput ||= deltaCarriesOutput(delta)   // content / reasoning_content / tool_calls 任一非空
      handlers?.onDelta?.(delta)
    },
  })

  const choice = response.choices?.[0]
  if (choice?.finish_reason !== 'insufficient_system_resource') return response
  if (emittedOutput || messageCarriesOutput(choice.message)) return response
  if (retryCount >= MAX_RETRIES || options.signal?.aborted) return response   // MAX_RETRIES = 1

  retryCount += 1
}
```

三个容易漏的判据：`reasoning_content` 也算"已输出"（thinking 内容同样进了 UI）；上游可能对
`stream: true` 返回非流式 JSON，所以除了 delta 还要看最终 message；用户已点取消
（`signal.aborted`）时不要偷偷再发一个请求。重试上限设 1 就够，多了只是加剧拥塞。把这个私有终态
映射成用户可读的提示比透传原始 `finish_reason` 友好，但映射表要留在 adapter 里，别污染通用协议层。

## 坑六：`user_id` 非法值应该整体丢弃，不是修剪

**现象**：`user_id` 有字符集和长度的线协议约束（我们按官方约束实现的是 `[A-Za-z0-9_-]+`、长度
1–512）。传邮箱或文件路径进去，请求被拒。

**根因**：真正的坑不在报错，在"顺手修好它"的诱惑——很多人会写 `slice(0, 512)` 加一个正则替换，把
非法字符删掉再发。**这是隐私事故的做法**：`user_id` 常被塞进邮箱、用户名、本机路径这类可识别
信息，"修剪"之后它仍然是一个会被发到第三方、且仍能反查到人的标识，只是从不合规变成了合规。

**最小修复**：校验不通过就整个丢弃，不 trim、不截断、不替换字符。

```ts
const MAX_USER_ID_LENGTH = 512

export function normalizeUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > MAX_USER_ID_LENGTH) return undefined
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined
}

const userId = normalizeUserId(rawUserId)
const request = userId === undefined ? base : { ...base, user_id: userId }
```

配套约定：调用方只传本地生成的不透明随机 ID，并且**不要隐式生成** `user_id`——不传就是不传，
别为了"统计好看"给每个用户默默造一个稳定标识。

## 小结

六个坑里有四个（1、2、3、5）是同一个形状：**协议的合法性规则由服务端实际路由决定，而不是由你
请求里写了什么决定**。适配层的正确姿势因此是无条件按最严格规则组装请求，并把所有 provider 私有
规则（字段剥离、历史归一化、私有 finish_reason、usage 开关）关在一个 adapter 文件里，不让它们
渗进通用的 chat/completions 抽象。

调试建议：先把请求体原样 dump 一份（脱敏，日志里只留 `sk-***`），再看响应里的 `model` 字段是不是
你以为的那个模型。坑二就是这么抓到的。
