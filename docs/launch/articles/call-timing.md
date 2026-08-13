# 给工具加生命周期：CallTiming 机制

做 agent runtime 的人迟早会撞上同一个问题：**有些能力必须在特定时刻发生，而模型不该、也不会在那个时刻想起它。**

举个具体的。我们有一套 skills——按需加载的技能文档。模型想用它，前提是知道有哪些。这份清单怎么进上下文？

三条常见路子都不太行：

- **拼进 system prompt**：清单是动态的（项目目录会变、技能会增删），把动态内容塞进 system prompt 会打穿 prompt 缓存，组装逻辑还会散进 prompt 层。
- **做成普通工具让模型自己调**：模型不一定调，调的时机也不对——它得先"想到"自己可能需要某个技能，可这恰恰要求它先看过清单。鸡生蛋。
- **在主循环里写死一段特判**：`if (isSessionStart) injectSkillManifest()`。能跑，但这段逻辑绕开了工具的注册、权限、审计和 timeline 投影，它成了主循环里的第一根钉子，下一个类似需求就是第二根。

我们的解法是给**工具契约**加一个可选维度，而不是给主循环加分支。

## 一行声明

`packages/agent-core/src/tools/types.ts` 里的 `Tool` 接口多了一个可选字段：

```ts
/** 到点工具不进入模型发现面，由宿主按此值调度执行点。 */
readonly callTiming?: ToolCallTiming
```

于是那个 skills 清单工具长这样（`tools/skills/src/skill-manifest/skill-manifest.ts`）：

```ts
export const skillManifestTool: Tool = {
  name: 'skill_manifest',
  runtime: 'internal',
  callTiming: 'sessionStart',              // ← 全部的改动就是这一行
  execution: { mode: 'serial', effectKeys: ['skills:manifest'] },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  skill: { description: '在会话开始时生成当前可用 skills 的一级清单。', content: '…' },
  async execute(_args, ctx) {
    const snapshot = await ctx.projectSkills?.ensure()
    return { ok: true, data: buildSkillManifestText(snapshot) }
  },
}
```

它照常经域 registrar 注册进同一个 registry，但这一行带来两个后果：

**一、它从模型可见清单里消失。** `packages/agent-core/src/tools/toolCatalog.ts` 的判定简单到有点无趣：

```ts
export function isModelVisibleTool(tool: Tool): boolean {
  return !tool.callTiming
}
```

注意是"非空"而不是穷举枚举。这个选择是有意的：以后增补时机不需要回来改发现面的判定。`loadSchema()` 对到点工具同样返回 `undefined`——模型既看不见它，也拿不到它的 schema。

**二、它由 runtime 在对应生命周期点自动执行**，结果照样进 timeline、照样进审计。

这一步之后，"工具"这个词的含义变了。它不再是"模型可调用的函数"，而是**agent 的能力单元**——一个自带 schema、权限分类、执行语义和审计投影的封装体。谁来触发它（模型、还是生命周期）降级成了工具的一个属性。

## 九个核心时机

`packages/agent-core/src/tools/toolCallTiming.ts` 的全部内容就是一个类型：

```ts
export type ToolCallTiming =
  | 'sessionStart'
  | 'runStart'
  | 'runEnd'
  | 'turnStart'
  | 'turnEnd'
  | 'preCompact'
  | 'postCompact'
  | 'subagentStart'
  | 'subagentEnd'
  | `${string}:${string}`
```

九个核心时机，分派点分布在四个文件里：

| 时机 | 触发点 | 分派位置 |
| --- | --- | --- |
| `sessionStart` | 会话首次进入循环 | `runtime/toolLoopBootstrap.ts` |
| `runStart` | 每个 run 开始 | `runtime/toolLoopBootstrap.ts` |
| `runEnd` | run 收尾（`finally` 里，中止/报错也走） | `runtime/runToolLoop.ts` |
| `turnStart` | 每次向模型发请求前 | `runtime/runToolLoop.ts` |
| `turnEnd` | 该轮确实发过请求才触发 | `runtime/runToolLoop.ts` |
| `preCompact` | 判定要压缩、动手之前 | `runtime/core/plugins/compactionPlugin.ts` |
| `postCompact` | 压缩完成之后 | `runtime/core/plugins/compactionPlugin.ts` |
| `subagentStart` | 子 agent 循环开始 | `subagents/childAgentLoop.ts` |
| `subagentEnd` | 子 agent 循环结束 | `subagents/childAgentLoop.ts` |

值得单说的是最后那行模板字面量 `` `${string}:${string}` ``。它是给**领域事件**留的扩展位：宿主或插件可以经 `CoreInstance` 的受限分派 API 触发 `mcp:connected` 这类时机，不必回来改核心枚举。核心九个是 runtime 自己认识的，`<domain>:<event>` 是别人的地盘。

（一个诚实的细节：`sessionStart` 有，`sessionEnd` 没有。会话终止不是 runtime 能可靠观测到的事件——用户可能直接关掉窗口。`runEnd` 才是有终态保证的那个点。）

## 分派器做了什么

`packages/agent-core/src/runtime/timedDispatch.ts` 是这套机制的全部实现，不到 300 行。几个设计点：

**分桶注册，保持注册顺序。** `createTimedToolRegistry()` 包一层 registry，在 `register` / `unregister` 时把工具名维护进 `Map<ToolCallTiming, string[]>`，桶内按注册序排列。同一时机上有多个工具时，执行顺序是确定的，不随 Map 迭代顺序漂移。

**复用普通工具的执行路径。** 到点分派不自己实现一套调用——它走 `executeToolCall`，用同一个受限 `ToolContext`，产出同样的 `ToolResult`，再经 `appendMappedToolResult` 落 timeline。这意味着 workspace confinement、stale guard、trace 事件、checkpoint 持久化全部免费继承。一个 `sessionStart` 工具改了文件，你在审计里看到的东西和模型自己调工具改文件是同构的。

**风险非 safe 就拒绝执行。** 这是最容易忽略、也最要紧的一条。到点分派**不经过确认门**——`beforeToolCall` 那套 hook 是为"有人在场，可以点确认"设计的，而 `runEnd` 触发时用户可能早就走了。所以分派器在执行前主动咨询风险分类：

```ts
const risk = riskForTimedTool({ core: base.core, sessionId: base.id, name }, dependencies)
if (risk.level !== 'safe') {
  const error = `到点工具 ${name} 因风险等级 ${risk.level} 被拒绝执行`
  base.trace.event('tool.timed_rejected', { timing, toolName: name, callId, risk: risk.level, reason: risk.reason })
  return { ok: false, error, details: { timing: request.timing, risk: risk.level } }
}
```

配套的还有一条注册期硬约束：`origin: 'external'` 的工具**不允许**声明 `callTiming`，`toolRegistry.ts` 在注册时直接剥掉这个字段并记一条诊断。换句话说，接进来的 MCP server 没法给自己安一个"会话开始时自动跑"的位置。生命周期点位是框架内部的组装面，不对外部声明开放。

**幂等靠 callId 结构。** `sessionStart` 的 callId 是 `timed:sessionStart:${name}`——不含 runId，因此同一会话里跨 run 稳定。`runStart` / `runEnd` 带 runId，其余时机额外拼一个随机 id。这三个稳定桶在执行前会查 timeline 里是否已有同 `tool_call_id` 的记录，有就跳过。会话恢复、run 重入都不会重复注入清单。

**单个失败降级成结果，不炸整桶。** 抛错被 catch 成 `{ ok: false, error }` 写进 timeline，记一条 `tool.timed_failed`，循环继续下一个工具。只有 AbortError 和"当前 run 已失效"会中断整轮分派。

**一个协议上的小手术。** 到点工具的结果是个孤儿：它有 `role: 'tool'` 的记录，却没有对应的 assistant `tool_calls`——因为模型压根没发起过这次调用，而伪造一条 assistant 消息写回会话历史是不能接受的。但 OpenAI-compatible 的请求序列要求 tool result 紧跟同 id 的 assistant 声明。`runtime/timedToolResultProjection.ts` 的做法是：只在**即将送给模型的那份数组**里、紧贴孤儿结果之前合成一个固定形状的配对项（`timed_tool_result` / `{}`），持久化的历史不动。作用域严格限定在 `timed:` 前缀——非 timed 的孤儿是真问题，不该被这层投影掩盖。

## 和 Claude Code hooks 有什么不一样

熟悉 Claude Code 的人会立刻联想到它的 hooks。两者确实解决相邻的问题，时机集合也有明显重叠（`SessionStart`、`PreCompact`、`SubagentStop` 都能在两边找到对应物），但定位不同：

1. **声明位置不同。** Claude Code hooks 由**使用者**配置在 settings 文件里（`~/.claude/settings.json`、项目内的 `.claude/settings.json` 与 `.claude/settings.local.json`，此外还能来自插件和 agent/skill frontmatter）。CallTiming 是**工具自己在代码里**声明的一个字段，跟着工具一起注册进 registry——没有外部配置文件参与。

2. **执行载体不同。** Claude Code hooks 是运行在 agent 之外的执行体，支持多种类型（`command` 走 shell 并从 stdin 收 JSON，此外还有 `http`、`mcp_tool`、`prompt`、`agent`），有自己的输入输出协议。CallTiming 工具走的是**和普通工具完全同一条通道**：同一个 registry、同一个 `executeToolCall`、同一个 `ToolContext`、同一份 timeline 与 trace 投影。要给到点能力加一条审计字段，改的是工具执行路径，不是另起一套。

3. **能不能干预流程，差别最大。** Claude Code hooks 里有相当一部分事件支持**阻断**——`PreToolUse` 可以用退出码 2 或 JSON 里的 `permissionDecision: "deny"` 把工具调用拦下来，`UserPromptSubmit`、`Stop`、`SubagentStop` 等事件同样有决策能力。CallTiming **目前完全没有这个能力**：结果只往 timeline 写，不回传给循环做任何判断。下一节细说。

4. **面向的人不同。** hooks 面向使用者定制：不碰框架源码就能把自己的检查、格式化、通知插进 agent 的运行流。CallTiming 面向**框架内的能力组装**：写工具的人决定这个能力在哪个点位生效，成品是产品的一部分，不是用户的个人配置。

5. **信任模型因此不同。** hooks 的信任来自用户——是用户自己写进 settings 的。CallTiming 的信任来自注册面，所以才有前面那条"外部工具不许声明 callTiming"的注册期剥除，以及"非 safe 直接拒绝"的执行期闸门。

这两件事不互斥。一个成熟的 runtime 大概率两样都要：框架内的能力组装用 CallTiming 这类机制，使用者的定制留给 hooks 那一层。

## 现在还做不到的

写到这里必须说清楚边界，否则这篇就成了软文。

**时机没有干预循环的能力。** 到点工具的返回值只有一个去处：写进 timeline。它不能否决一次工具调用、不能改写即将发送的上下文、不能要求循环重试或提前结束。上面对比里说 Claude Code hooks 能 block 而我们不能，是实话。想要"到点做检查、不合格就拦下来"的场景，现在得落到插件 hook 上（`runtime/core/plugins/` 那一层是有干预能力的），不是 CallTiming。

**`<domain>:<event>` 扩展位还没接线。** 类型和分派 API 都在，`CoreInstance.dispatchTimedTools()` 也接受任意领域时机，但目前没有任何宿主真的去触发 `mcp:connected` 之类的事件——这个扩展位当下只有测试在用。留着它是因为改核心枚举的成本远高于留一个模板字面量，但"预留"和"可用"是两回事。

**真实用户只有一个。** `skill_manifest` 是目前唯一一个声明了 `callTiming` 的工具。九个时机里被实际占用的只有 `sessionStart`。一个机制在只有一个消费者的时候，你很难说它的抽象边界已经被验证过——`preCompact` 那个桶接上第二第三个工具时会不会暴露出顺序或幂等的新问题，我不知道。

## 最后

真正让人满意的不是这九个时机，而是那行 `return !tool.callTiming`。

加一个生命周期能力，需要写的代码是：给工具加一个字段。不需要新的 hook 注册表、不需要新的执行器、不需要新的审计通道、不需要在主循环里加分支。因为"工具"这个抽象本来就把 schema、权限、执行、审计打包好了，我们只是把"谁来触发"从硬编码的假设变成了契约上的一个可选维度。

一个抽象的价值，往往体现在你**不需要**为新需求发明第二个抽象的时候。
