# 中文渠道帖文案（V2EX / 掘金 / 即刻）

> 本文件是**草稿**：三个渠道各一版可直接复制粘贴的正文，供维护者审阅与改写。**发布动作一律由
> 维护者手工执行**，仓库里没有任何自动发帖流程。文中事实以 `README.md` 与
> `docs/launch/comparison.md` 为准，未交付的能力（Kimi 入口、npm 发布）不写进强项；正文里的仓库
> 文件用反引号标注，不放仓库内相对链接——帖子发出去以后相对路径是死的。

## 一、V2EX

> **渠道**：V2EX，节点 `/go/create`（分享创造）；备选 `/go/programmer`。
> **建议发布时间段**：工作日 10:00–11:30，或 21:00–23:00（V2EX 晚间在线密度更高）。
> **配图建议**：`docs/launch/assets/cli-demo.gif`（开头故事的直接证据，一张就够；V2EX 帖子图多显营销）。

**标题**：自己写的 Agent 内核：一个 core 跑 Web/桌面/CLI，求拍砖

**正文**：

前阵子给项目加了个 headless CLI 宿主，本意只是让编码 agent 能自己跑一次真实 run，不用我起 GUI 点几下。
宿主跑通后的第一条命令就 400 了：

```text
DeepSeek API error 400:
The reasoning_content in the thinking mode must be passed back to the API.
```

不是超时也不是限流，是协议层被服务端直接拒。而且它不是 CLI 专属：任何新会话的第一次模型请求都会踩，
桌面端一样踩。主干上躺着一个"新会话必 400"的硬故障，单测全绿——因为单测是照官方文档写的，
文档说没开 thinking 就不该带 `reasoning_content`，而服务端已经把老别名统一路由到了 V4 thinking 家族。
修在 adapter 里，从抓到到收尾十来分钟。

这件事之后我把项目清理了一下开源出来：Einfach Agent（einfach 是德语的"简单"），MIT。

它是什么：一个装配式 Agent Runtime 内核。core 里只留工具契约与 registry、主循环、插件 hook，
以及状态/持久化/观测的接口，其余全部靠槽位注入——工具集、观测出口、持久化 driver、项目 Skills、
计划运行时、子 Agent 委派。不注入就是没有，不会静默降级到某个内置默认实现。`createCore()` 造出的
实例私有持有 store、工具 registry、插件宿主，同一进程里跑两份互不干扰。

同一个内核现在装配出三个宿主：Web 预览、Tauri 桌面端、headless CLI。CLI 的装配层 60 行
（`apps/cli/src/runtime.ts`），其余全是终端外壳。依赖方向 `agent-ai ← agent-core ← tools-* ← app`
不靠自觉：`scripts/check-boundaries.js` 在 CI 里排在测试前面，按行扫 import，core 一旦引入 React、
任何工具域包或持久化/观测能力包就直接 fail。

模型这边 DeepSeek 和 GLM 是一等公民——不是接聚合 SDK，是自己写 adapter。上面那条 `reasoning_content` 回传、
GLM 的 thinking / `reasoning_effort`、各家 cache usage 字段归一，都是项目自己维护并写进兼容契约文档的。

现在的弱项，先自己说，省得你们挖：

- 生态为零。没有插件市场，没有社区 provider 包，没有问答社区，出问题只能读源码。
- 包全部 `private`，**没发 npm**，`exports` 直接指向未编译的 `src/*.ts`，靠仓库自己的 Vite alias
  和 tsconfig paths 解析——离开这个 workspace 不成立。想用只能 clone 整个仓库。
- 自研 adapter 只有 3 家，默认构建下真能用的是 DeepSeek 和 GLM 两家（Kimi 代码写完了，但入口挂在构建开关下，
  真实 Key 端到端验收前默认关着）。没有 OpenAI / Anthropic / Gemini，没有 Ollama，也没有 base_url 兜底。
- 文档全中文，没有英文 README，界面文案也是中文。
- 没有 lint 脚本，`tsc -b` 是唯一静态门禁；没有 CHANGELOG，没有版本发布流程，`0.1.0` 之后
  什么算 breaking 目前没有对外约定。

所以它现在不适合当依赖装进你的项目。适合的是：想自己搭一套 agent runtime 的、已经在为第二个宿主
复制粘贴 core 的、或者主要用 DeepSeek/GLM 且在意 provider 协议细节的人——clone 下来拆开看。

https://github.com/allroad88888888/einfach-agent

想听的反馈：槽位注入这套抽象在你看来是不是过度设计？"横切行为写成插件、主循环不留特判"这条
你们踩过什么坑？以及如果这些包真要发 npm，你会希望它长成 SDK 模式还是 server 模式？
欢迎拍砖，尤其欢迎说"这玩意没必要存在"的那种。

## 二、掘金

> **渠道**：掘金，分类「后端 / 前端」，标签建议：`AI`、`Agent`、`TypeScript`、`DeepSeek`、`架构`。
> **建议发布时间段**：工作日 09:00–10:30 或 20:00–22:00（掘金推荐位对早高峰友好）。
> **配图建议**：封面用 `docs/launch/assets/cli-demo.gif` 抽帧或 `docs/launch/assets/session-streaming.png`；
> 正文内配 `docs/launch/assets/plan-approval.png`（计划审批）与 `docs/launch/assets/ask-user-decision.png`（危险工具确认）。

**标题**：装配式 Agent Runtime 内核：一个 core 三个宿主，和 DeepSeek 那条必现的 400

**正文**：

### 痛点：core 什么都想管，第二个宿主就还债

大部分 agent 框架的 core 里塞着内置工具实现、存储层、UI 事件、子 agent 调度、压缩策略、日志落盘，
第一个宿主上跑得很好，问题全在第二个：想把 IndexedDB 换成 SQLite 得改 core，因为 core 直接 import 了
driver；想长 headless CLI 得绕开 core 里的 React/DOM 引用；想裁掉一半工具做嵌入式小 agent 做不到，
工具是硬编码的；想在同一进程跑两个互不干扰的实例也做不到，core 里全是模块级单例。判断一个 core
干不干净，最快的办法不是读架构文档，是读它的 `package.json`。

### 设计：内核只留四样，其余全是槽位

`packages/agent-core` 只提供机制：工具契约 + registry、主循环、插件 hook 面、状态/持久化/观测的
contract。其余经 `createCore()` 的构造参数注入——`registerTools`（不传则该实例**没有任何工具**）、
`plugins`、`observability`、`projectSkillsProvider`、`planRuntime`、`delegation`、`config`；
会话/历史持久化不走构造参数，由宿主通过 persistence bridge 配 driver。

一个关键取向：**横切行为是插件，不是主循环里的 if**。上下文压缩、finish reason 续写、loop guard、
老会话字段迁移，四个需求如果各写一个特判，主循环就废了。它们在
`packages/agent-core/src/runtime/core/plugins/` 里各是一个插件，loop 侧只有"槽为 undefined 就跳过"
这一个分支。`compactionPlugin` 现在已经不在默认集合里（压缩改走 durable context checkpoint 路径），
主循环一行没动，`transformContext` 槽还在那儿等下一个插件——这正是槽位设计的收益。

### 证据一：CLI 宿主的装配层就 60 行

`apps/cli/src/runtime.ts` 全文 60 行，干的事就是把同一个 `defaultCore` 按 Node 环境装配一遍（节选）：

```ts
export function assembleCliRuntime(options: AssembleCliRuntimeOptions): void {
  registerStandardTools(toolRegistry)
  configureDefaultSkillsRegistry(builtInSkillsRegistry)
  configureDefaultProjectSkillsProvider((root) => scanProjectSkills(root, bridge))
  defaultCore.planRuntime = createDefaultPlanRuntime
  configureDefaultDelegation(createDelegationAssembly)
  configurePersistence({ history: createMemoryHistoryDriver() })   // 浏览器用 IndexedDB，桌面用 SQLite
  configureTraceOutput(options.verbose)                            // trace 打到 stderr
  configureCommands({ modelCredentials: { deepseek: /* ... */ }, fetchImpl: globalThis.fetch })
}
```

`apps/web/src/main.tsx` 的前几行几乎逐字相同，差别只落在宿主特有的那几样：Skills 文件桥、会话/历史 driver、
观测 driver、模型传输、凭据来源。桌面端没有第三份 TS 装配——Tauri 的 `frontendDist` 直接复用 Web 产物，
只多一层 Rust 桥负责 shell、MCP stdio、模型代理和凭据读取，所以"三个宿主"实际是**两份 TS 装配 + 一层原生实现**。

### 证据二：边界由 CI 强制

架构约定写在文档里，三个月后必然被破。`scripts/check-boundaries.js` 把规则做成门禁：core 禁入 React、
禁入任何 `@einfach-agent/tools-*`、禁入持久化/观测/子 Agent 能力包、禁入 Tauri SQL 插件；能力包禁入工具域。
它在 CI 里排在测试之前（`check-docs → check-boundaries → pnpm test → pnpm build`），
所以"core 不依赖 React"这句话是可执行的，不是愿望。

### 坑：单测不但没抓到，还把错的断言成了对的

为了让编码 agent 能自己验证改动，我们加了 headless CLI 宿主。它跑通后的**第一次**真实调用就 400：

```text
DeepSeek API error 400:
The reasoning_content in the thinking mode must be passed back to the API.
```

两层原因叠在一起。第一层是我们造的：runtime 有一类"定时工具"，在 session/run/turn 等生命周期点位由宿主自动
执行，不由模型发起。但 OpenAI-compatible 协议要求 `role: 'tool'` 的结果必须紧跟在同 `tool_call_id` 的
assistant `tool_calls` 之后，于是内核只在送给模型的那份数组里合成一条配对 assistant——这条 assistant
是造出来的，它没有 `reasoning_content`，它本来就没思考过。

第二层是服务端偷偷改的：请求 `deepseek-chat` 拿回的响应里 `model` 字段是 `deepseek-v4-flash`。
老别名已经被统一路由到 V4 thinking 家族，**一个从未声明过 thinking 的请求，也会因为缺
`reasoning_content` 而 400**。文档写的是旧契约，服务端跑的是新路由。

修复落在 `packages/agent-ai/src/deepseek.ts`，无条件归一化，只作用在发出去的请求副本上：

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

空串能过校验——服务端要的是"字段在"，不是"内容有意义"，这是实测出来的，所以不用伪造推理正文。

最值得说的是单测。项目里有一套离线协议矩阵专门覆盖 DeepSeek 请求形状，工具续轮的 `reasoning_content`
也在覆盖范围内，它是绿的。因为它当时断言的是 `has_reasoning_content: result.thinking`——
忠实实现了**文档写的协议**。它不只是漏测，是把错误假设固化成了"期望行为"，还附赠一句
"这块已经覆盖过了"的虚假安全感。

结论就一条：**单元测试只能验证"我以为服务端是这样"**。你要花多久才能打出一次真实请求？
如果答案是"起个 GUI 点几下"，那这条路径在实践中等于不存在。

### 现状与弱项

已交付：多会话、checkpoint/revert、lazy tool schema、危险工具确认、结构化计划与评估、树形子 Agent
（逐路径预算 + JSONL 归档 + 回放脚本）、上下文压缩与 provider cache 统计、结构化 trace 与内置 TraceViewer。
不够的地方也直说：包全部 `private` 没发 npm，只能 clone 进 workspace 用；自研 adapter 只有 3 家，
默认构建下可用的是 DeepSeek 与 GLM 两家（Kimi 门禁默认关闭）；没有 OpenAI/Anthropic/Gemini/Ollama
通路，也没有 OpenAI-compatible 兜底；文档只有中文；没有 lint、没有 CHANGELOG、没有版本承诺。
要今天就能用的编码助手，装 Cline 或 pi 更合适；这个项目适合的是想拆开内核自己改的人。

### 链接与延伸阅读

仓库（MIT）：https://github.com/allroad88888888/einfach-agent

仓库 `docs/launch/articles/` 下还有五篇更细的：《一个内核，三个宿主：装配式 Agent Runtime 设计》
《给工具加生命周期：CallTiming 机制》《子 Agent 治理：replay、容量与归档》
《用 CLI 宿主 dogfood，十分钟抓出一个线上 400》《DeepSeek V4 thinking 协议踩坑实录》。

## 三、即刻

> **渠道**：即刻，圈子建议「AI 探索站」或「编程学习」；不加话题标签也可发个人动态。
> **建议发布时间段**：工作日 12:00–13:00 或 21:00–22:30。
> **配图建议**：`docs/launch/assets/cli-demo.gif`（首图，动图在信息流里最抓人），
> 第二张可选 `docs/launch/assets/plan-approval.png`。

**正文**：

给自己的 Agent 加了个 CLI 宿主，跑通后第一条命令就 400——DeepSeek 把老别名路由到了 thinking
家族，少回传一个字段就拒，而单测全绿：它是照文档写的。

顺手开源了 Einfach Agent：装配式 Agent Runtime 内核，一个 core 装配出 Web / 桌面 / CLI 三宿主，
工具、存储、观测、子 Agent 全是槽位注入，DeepSeek 与 GLM 一等公民，MIT。生态为零，还没发 npm。

https://github.com/allroad88888888/einfach-agent
