# 用 CLI 宿主 dogfood，十分钟抓出一个线上 400

> 一个桌面 Agent 项目的真实事故复盘：为了让编码 agent 能自己跑真实 run，我们加了个 headless
> CLI 宿主。它上线后的**第一次**真实调用就 400 了——而那条 bug 已经躺在主干上，单测全绿。

## 一、问题不在 bug，在"只有人肉能触发模型调用"

这个项目是一个装配式 Agent Runtime：一套可插拔内核，上面挂 Web 预览和 Tauri 桌面两个宿主。
工具、插件、观测、持久化都能换实现，单测覆盖也不算薄。但它有个很尴尬的结构性缺陷：
**模型调用只有点 UI 才能触发**。

要验证一次真实的模型往返，流程是：`pnpm tauri dev` 起桌面端 → 等编译 → 点开会话 →
敲一句话 → 盯着 UI 看输出。改一行 adapter 想确认没打破真实请求，就得把这套重来一遍。

后果有两条，第二条更致命：

1. 回归靠手点，成本高到没人愿意做，于是大家默认"单测绿了就是对的"。
2. 我让编码 agent 帮我改这个项目，**agent 自己没法验证自己的改动**。它能跑 `pnpm test` 和
   `pnpm build`，唯独不能跑"一次真的打到 DeepSeek 的 run"——它交付的每个模型相关改动都是没试过的。

所以我们花了一张卡，做一个 headless CLI 宿主。

## 二、装配式内核的好处：宿主是装配层，不是分叉

提交 `f4e3359 feat(cli): add headless cli host for dogfooding real runs`，新增 `apps/cli`。

关键在于它没有 fork 任何运行时逻辑。`apps/cli/src/runtime.ts` 一共 60 行，干的事就是把同一个
`defaultCore` 按 Node 环境装配一遍：

```ts
export function assembleCliRuntime(options: AssembleCliRuntimeOptions): void {
  registerStandardTools(toolRegistry)
  configureDefaultSkillsRegistry(builtInSkillsRegistry)
  configureDefaultProjectSkillsProvider((root) => scanProjectSkills(root, bridge))
  defaultCore.planRuntime = createDefaultPlanRuntime
  configureDefaultDelegation(createDelegationAssembly)
  configurePersistence({ history: createMemoryHistoryDriver() })   // 浏览器用 IndexedDB，桌面用 SQLite
  configureTraceOutput(options.verbose)                            // trace 打到 stderr
  configureCommands({ deepseekApiKey: ..., fetchImpl: globalThis.fetch })
}
```

其余部分全是终端外壳：选项解析、凭证读取、事件渲染、REPL。整个宿主 15 个文件、836 行（含测试），
连的是同一份 loop、同一份工具契约、同一份插件链。真正需要动内核的只有一处：性能诊断以前直接
写死 `console`，CLI 里会污染 stdout，于是把它改成可注入的 sink
（`55b1e54 feat(observability): make the performance diagnostic sink injectable`）——一个 bug
都没修，只加了一条缝。

于是"跑一次真实 run"变成了一行：

```bash
DEEPSEEK_API_KEY=sk-*** pnpm cli -p "列出当前目录下的 TypeScript 文件并统计行数"
```

## 三、第一次真实 run，400

```text
DeepSeek API error 400:
The reasoning_content in the thinking mode must be passed back to the API.
```

不是超时、不是限流、不是模型胡说，是**协议层被服务端直接拒绝**。而且它不是 CLI 专属的：任何一个
新会话的第一次模型请求都会踩，桌面端同样。主干上躺着一个"新会话必 400"的硬故障，而单测全绿。

## 四、根因：一个是我们造的，一个是服务端偷偷改的

**第一层：runtime 合成的配对 assistant 没有推理正文。**

这个 runtime 有一类叫"定时工具"（timed tool）的东西：不由模型发起，而是在 session/run/turn
等九个生命周期点位由宿主自动执行，结果投影进 timeline。比如 skills 清单就是一个 `sessionStart`
时机的工具（`tools/skills/src/skill-manifest/`），每个新会话开局自动跑一次。

问题在于 OpenAI-compatible 的请求协议要求：一条 `role: 'tool'` 的结果消息必须紧跟在声明了同
`tool_call_id` 的 assistant `tool_calls` 之后。而 timed tool 压根没有模型发起的 assistant 轮，
它是凭空多出来的一条工具结果。`packages/agent-core/src/runtime/timedToolResultProjection.ts`
的做法是：只在即将送给模型的那份数组里，给这种"孤儿"结果紧贴着合成一条配对 assistant，不写回
会话历史。合成出来长这样：

```ts
{ role: 'assistant', content: '', tool_calls: [{ id: 'timed:sessionStart:skill_manifest', ... }] }
```

干净、可重放、不把 provider 差异带进内核。唯一的问题是：这条 assistant 是我们造的，它**没有
`reasoning_content`**——它本来就没思考过。

**第二层：服务端把所有别名都路由到了 thinking 家族。**

按官方文档，`reasoning_content` 回传只是 thinking 模式的要求。所以 adapter 原本的处理是有条件的：
只有 `thinking.type === 'enabled'` 时才走归一化。没开 thinking 的路径，什么都不做。

实测下来这个前提不成立：请求 `deepseek-chat` 拿回的响应里 `model` 字段是 `deepseek-v4-flash`。
服务端已经把老别名统一路由到了 V4 thinking 家族，**一个从未声明过 thinking 的请求，也会因为缺
`reasoning_content` 而 400**。

这就是那种你永远不可能靠读文档或写单测发现的东西：文档里写的是旧契约，服务端跑的是新路由。

## 五、修复：在 adapter 层无条件归一化

修复提交 `78e1d6e fix(ai): backfill reasoning_content on tool-call turns for deepseek thinking aliases`。

改动很小，落在 `packages/agent-ai/src/deepseek.ts`：凡是带 `tool_calls` 的 assistant，
`content` 为 null 就补空串，缺 `reasoning_content` 就补空串。

```ts
function prepareDeepSeekThinkingMessages(messages) {
  return messages.map((message) => {
    if (message.role !== 'assistant' || (message.tool_calls?.length ?? 0) === 0) return message
    const content = message.content === null ? '' : message.content
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    if (content === message.content && reasoning === message.reasoning_content) return message
    return { ...message, content, reasoning_content: reasoning }
  })
}
```

两个值得说的决定：

- **空串可以过校验。**服务端要的是"字段在"，不是"内容有意义"。这是实测出来的，不是猜的——
  也是修复能这么轻的原因：不用去伪造一段推理正文。
- **归一化提到 thinking 分支之外。**既然服务端会把别名路由到 thinking 家族，那么"请求有没有声明
  thinking"就不再是可信的判据。非 thinking 路径带上空串字段同样验证过可用，于是干脆无条件做。

归一化只在发出去的请求副本上做，不修改调用方原始 messages——内核的历史仍然干净，provider 的
怪癖被关在 adapter 里。

标题里的"十分钟"不是修辞。摊开 git 时间戳：修复 11:02:04，宿主本体 11:02:28，别名下线
（`1698a15`，服务端既已悄悄退役老名字，模型表就不该再留）11:07:27，主 agent 默认模型切到
`deepseek-v4-pro`（`f838544`）11:13:52。从抓到到收尾，十来分钟。修复提交排在宿主提交前 24 秒，
是因为宿主在本地跑通、抓出 bug、修好之后才一起提交，而独立的 adapter 修复该自己成一个 commit。

## 六、为什么单测没抓到——它不但没抓到，还把错的断言成了对的

这才是这次事故里最值得说的部分。

项目里有一套离线协议矩阵，专门覆盖 DeepSeek 的请求形状：thinking 开/关、stream/non-stream、
单轮/两轮工具调用……工具续轮的 `reasoning_content` 也在覆盖范围内。它是绿的。

因为它当时是这么断言的：

```ts
expect(result.request_shapes[1]?.assistant_tool_call).toEqual({
  has_reasoning_content: result.thinking,   // 只有 thinking 请求才带
  content_non_null: result.thinking,
})
```

这条断言忠实地实现了**文档写的协议**：没开 thinking 就不该带 `reasoning_content`。它不只是漏测，
它是把错误假设固化成了"期望行为"。你越是认真写单测，这种测试就越是在帮倒忙——它给了你一个
"协议这块已经覆盖过了"的虚假安全感。修复后这两行变成了无条件的 `true`，旁边留注释说明原因。

单测能验证的永远只是"我以为服务端是这样"。服务端实际是怎样，只有真打一次才知道。

## 七、三个可以带走的结论

**1. 单元测试模拟不了服务端的隐式行为，必须有一条打真实 API 的最短路径。**

别名路由、灰度、悄悄收紧的校验、文档没跟上的新行为——这些都不在任何 mock 里。你的 fixture 是
按文档写的，而文档是滞后的。判断标准很简单：**你要花多久才能打出一次真实请求？**如果答案是
"起个 GUI 点几下"，那这条路径在实践中等于不存在。它必须便宜到可以顺手跑。

**2. headless 宿主让"agent 自己测自己"成为可能。**

这才是做 CLI 宿主的真正收益。不是给人省几次点击，是把"跑一次真实 run"降到一条命令、一段可读
的 stdout、一个非零退出码——于是编码 agent 可以自己触发、自己读结果、自己判断成没成。

也正因为如此，`apps/cli` 里那些看起来啰嗦的细节其实是刚需：run 失败必须写 stderr 并置非零退出码，
`-v` 要能把 trace 打到 stderr 而不污染 stdout。这不是给人看的人机工程，是给自动化和 agent 用的
契约——跑不通就是跑不通，不能安静地"看起来成功了"。

**3. 装配式内核让这件事的成本足够低，低到值得做。**

如果宿主意味着复制一份运行时逻辑，那这张卡多半永远排不上号——多一个宿主就多一份要同步的代码，
而且新宿主里跑通不代表老宿主里跑通。

装配式内核把这件事变成了：写一个装配层，注入这个环境该用的驱动（历史用内存、trace 打 stderr、
`fetch` 用 Node 的），剩下全部复用。60 行装配，加一层终端外壳。**而且因为跑的是同一个内核，CLI
里抓到的 bug 就是桌面端的 bug**——这次这条 400 正是如此。

如果你也在做 agent/LLM 应用，值得问自己一句：现在从一个念头到一次真实的模型往返，你要花几步？
把这个数字压到 1，你会开始发现一批"单测永远绿、线上永远错"的东西。
