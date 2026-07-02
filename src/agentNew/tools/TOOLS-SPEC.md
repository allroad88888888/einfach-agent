# TOOLS-SPEC — 工具规范（抽象工厂版）

> 规范性文档。定义 agentNew 里「工具」的统一抽象、能力边界、注册与执行方式，作为**批量生成工具**的模板依据。
> 现状（要改的）：一个「工具」被拆散在三处——`tools/registry.ts` 的 `toolSummaries`（摘要）+ `toolSchemas`（schema），
> 和 `runtime/toolExecution.ts` 的一个大 `switch(toolName)`（内联执行，直接抓 rootStore/transientAtoms/skills）。
> `ask_user_question` 更是在 `runtime/modelRun.ts` 循环里特判、不走 `runRuntimeTool`。加一个工具要改 3 个地方，工具之间不能互调。

---

## §1 核心原则

1. **一个统一抽象 `Tool`**：一个工具 = 一个自包含模块，实现同一个 `Tool` 接口（身份/描述/runtime/inputSchema/execute）。定义不再散落。
2. **一根准绳：工具只碰 `ctx`，永不碰 atom / store / 全局单例。** 一切副作用（报进度、互调工具、读 signal…）都经 `ToolContext`；**harness 是唯一写 atom + 加守卫的地方**。这条是隔离的全部、也是让整套保持简单的关键。
3. **一个抽象工厂 `ToolRegistry`**：注册 + 懒加载 schema + 统一分发（`run`）。运行时依赖工厂接口，不依赖具体工具；`switch` 消失。
4. **异步无差别**：`execute` 返回 `T | Promise<T>`，工厂 `await` 吸收；atom 写入器本就 await-tolerant，工具内同步/异步随意，**不区分** LongRunning。
5. **懒加载不变（TK3）**：model 只看 `list()`（name/desc/runtime），完整 `inputSchema` 只经 `loadSchema(name)` 按需合成，绝不进 manifest。
6. 三个历史问题就此消解：①隔离＝自包含模块 + ctx 白名单；②抽象＝单一 `Tool` 接口；③互调＝`ctx.callTool`。批量生成＝照模板新建一个文件 + 注册。

## §2 核心类型

```ts
export type ToolRuntime = 'internal' | 'browser' | 'server' // server 先留标记，暂不落远程传输（§13）

// manifest-only 摘要——model 只看这一层。description 取自 tool.skill.description（一句话，TK3/TK4）。
export interface ToolSummary { name: string; description: string; runtime: ToolRuntime }
// 懒加载后补出 schema + 指南正文（request_tool_schema 时一起给 model）。
export interface LoadedTool extends ToolSummary { inputSchema: Record<string, unknown>; guide: string }

// 每个工具自带一个 skill（取代裸 description）：一句话摘要 + 可选触发词 + 完整指南正文。
// 与 skills/registry 的 skill 同形，工具因此自文档化；未来可把工具 skill 并入 pickSkillsForInput 选取。
export interface ToolSkill {
  description: string   // 一句话，进 manifest（terse）
  triggers?: string[]   // 可选，触发词
  content: string       // markdown 指南正文；随 schema 经 loadSchema 给 model，不进 manifest
}

// 工具执行结果（判别联合）。harness 负责把它映射成回给 model 的 tool-result。
export type ToolResult =
  | { ok: true; data?: unknown }          // 成功；data 序列化后作 tool result（无 data → {"ok":true}）
  | { ok: false; error: string }          // 失败；序列化成 {"error": "..."}（TK6，不打断循环）
  | { pause: unknown }                     // 暂停 run（ask_user）；harness 置 waiting_user，不回填该 tool（§7）

// 工具拿到的唯一副作用面（白名单）。工具不 import 任何 atom/store —— 一切副作用都在这里。
export interface ToolContext {
  readonly sessionId: string
  readonly signal: AbortSignal
  progress(text: string): void                                 // 显示「工具正在干啥」（§5）
  callTool(name: string, args: unknown): Promise<ToolResult>   // 工具互调（§8）
  // —— 受控副作用（harness 实现 + 集中 stale/ghost 守卫，工具不再各写）——
  renderCard(card: { title: string; body?: string }): { cardId: string } | { error: string }
  saveArtifact(file: { filename: string; content: string; mimeType?: string }): { artifactId: string } | { error: string }
}

// 统一抽象：一个工具要具备的全部。
export interface Tool {
  readonly name: string
  readonly runtime: ToolRuntime
  readonly skill: ToolSkill                                    // 取代裸 description —— 工具自带 skill
  readonly inputSchema: Record<string, unknown>                // 仅经 loadSchema 暴露，不进 manifest
  execute(args: unknown, ctx: ToolContext): ToolResult | Promise<ToolResult>
}
```

- `list()` → `{ name, description: tool.skill.description, runtime }`（manifest 仍 terse）。
- `loadSchema(name)` → `{ ...summary, inputSchema, guide: tool.skill.content }`（schema + 指南一起给 model）。

- `execute` 的 `args` 是 model 传来的原始对象。**工具自己在 execute 开头防御式取字段**（typeof / 默认值），非法参数直接 `return { ok:false, error }`。不强制单独的 `parse()`——保持接口最小（要更强类型可在工具内用私有 helper）。

## §3 抽象工厂 `ToolRegistry`

```ts
export interface ToolRegistry {
  register(tool: Tool): void
  has(name: string): boolean
  list(): ToolSummary[]                                        // 只 name/desc/runtime（TK3）
  loadSchema(name: string): LoadedTool | undefined             // 懒加载：summary + inputSchema
  run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>
}
```

- 一个模块级单例 `toolRegistry`（`createToolRegistry()` 建，内部 `Map<name, Tool>`）。`register` 幂等/后注册覆盖同名。
- `list()` 从各 `Tool` 摘出 `{name,description,runtime}`；**绝不含 inputSchema**。`loadSchema(name)` 取该 `Tool` 合成 `LoadedTool`。
- `run` 见 §4。未知 name → `{ ok:false, error: 'unknown tool: <name>' }`。

## §4 执行生命周期（守卫/错误/进度集中在 `run`）

`ToolRegistry.run(name, args, ctx)` 一处收口，工具的 `execute` 只写纯逻辑：

1. 查 `has(name)`，无 → `{ok:false, error:'unknown tool'}`。
2. `try { result = await tool.execute(args, ctx) } catch (e)`：
   - `AbortError` → 透传 rethrow（交给上层 run 状态机降级为 stopped，与现有 toolExecution 一致）。
   - 其它异常 → `{ ok:false, error: message }`（TK6：工具抛错不打断循环，封成 error result）。
3. 返回 `result`（`run` 本身不 append、不判 stale——见下）。

**守卫归属**：`ctx.signal`/ghost/stale 的**写回守卫**由**调用方（modelRun 的 tool 循环）**在 `run` 返回后、append tool-result **之前**统一施加（沿用现有 `isCurrentRun(id,runId)` + `signal.aborted` 三件套）。`run` 只负责「执行 + 错误封装」，循环负责「要不要把结果写回」。这样 `run` 不需要知道 runId，`ctx` 也不用暴露 isCurrent 给工具。

**结果映射**（modelRun 循环做）：
- `{ok:true,data}` → append tool item，content = `JSON.stringify(data ?? {ok:true})`。
- `{ok:false,error}` → append tool item，content = `JSON.stringify({error})`。
- `{pause}` → 不 append 该 tool 的 result（留给 resume），`patchRun(waiting_user, pendingQuestion:pause)` 并 return（§7）。

## §5 能力：`ctx` 白名单（工具只碰这几个）

| 能力 | 签名 | 说明 |
|---|---|---|
| 会话身份 | `ctx.sessionId` | 只读。工具需要时传给…没有，工具不直接用它写 atom —— 副作用一律走下面的方法。 |
| 中断 | `ctx.signal` | 长任务里可 `throwIfAborted()` / 传给 fetch，实现 esc 可断。 |
| 报进度 | `ctx.progress(text)` | 「工具正在干啥」。**由 harness 实现**：内部 `if isCurrent → 写会话 store 的瞬态 `toolActivityAtom``；工具只给文本。 |
| 互调 | `ctx.callTool(name,args)` | 调另一个工具，见 §8。 |
| 渲卡片 | `ctx.renderCard({title,body?})` | browser_action 用。harness → `addBrowserCard` + 集中 stale 守卫，回 `{cardId}`/`{error:'stale'}`。工具不再 import transientAtoms。 |
| 存文件 | `ctx.saveArtifact({filename,content,mimeType?})` | save_file 用。harness → `addPendingArtifact` + 集中 stale 守卫，回 `{artifactId}`/`{error}`。 |

> 所有工具都拿到完整 ctx（不做按需注入的 capabilities 声明——那是被否掉的复杂度）；按约定各用所需。ctx 就是「工具能做的事」的**固定小白名单**，harness 是唯一实现方 + 守卫方。将来若某效果只该给某类 runtime，再在 harness 侧按 runtime 收窄即可。

- **`progress` 的落地（harness 侧，非工具）**：新增瞬态 atom `toolActivityAtom: { callId: string; toolName: string; text: string }[]`（会话 store 内共享单例 key，与 browserCards/pendingArtifacts 同范式）。harness 构造 ctx 时闭包住 `callId/toolName/sessionId/runId`：`progress(text) => { if isCurrent(sessionId,runId) upsertActivity(sessionId, {callId,toolName,text}) }`；工具执行结束（run 返回后）harness 按 callId 移除该条。UI 在工具结果附近渲染该列表。
- **进度签名先定为纯文本**（`progress(text: string)`）。将来要结构化（`{ stage, percent }`）是**加法**、不破坏现有工具，后续再说。
- **原则**：以后若还有别的跨切面副作用（结构化 `emit` 等），也只往 `ctx` 加方法，**绝不让工具直接碰 atom**。`ctx` 就是工具能做的事的白名单。

## §6 懒加载 schema + 指南（保留 TK3）

- manifest = `registry.list()`（name/desc/runtime，description 取自 skill.description）。完整 `inputSchema` **和 `guide`（skill.content）** 只在 model 请求 `request_tool_schema` 时经 `registry.loadSchema(name)` 一起合成，塞进本轮可见工具（`runtime/toolLoading.ts` 的 `ensureToolLoaded` 逻辑不变，数据源从旧 `loadTool` 换成 `registry.loadSchema`；给 model 的 schema 消息里附上 guide）。禁止预加载：manifest 永不含 schema/guide。

## §7 `ask_user_question` 收编为「暂停」工具

- 不再在 modelRun 循环里特判。`ask_user_question` 也是一个 `Tool`，其 `execute` 校验 `questions` 后 `return { pause: args }`（合法）或 `{ ok:false, error }`（无 questions）。
- 循环见到 `{pause}` → 置 `waiting_user + pendingQuestion`、不回填该 tool（留给 `resumeWithAnswers`）。TK7「已回答」守卫仍在循环侧（resume 后本轮已回填过 → 不再 pause，回 `user_answers_already_provided`）。工具集就此统一。

## §8 工具互调 `ctx.callTool`

- `callTool(name, args)` 经工厂转发：`registry.run(name, args, childCtx)`。**harness 中介**，加轻量护栏：
  - **signal 透传**：childCtx 复用同一 `signal`。
  - **防环 + 限深**：ctx 内部携带一个「调用栈」`Set<string>` 与 `depth`；`callTool` 时若 `name` 已在栈中 → `{ok:false,error:'tool cycle: <name>'}`；`depth > MAX_TOOL_DEPTH(=4)` → `{ok:false,error:'tool depth exceeded'}`。子调用的 `progress` 归属父 callId（或各自 callId，实现时定，不阻塞）。
  - `pause` **不允许经 callTool 冒泡**：被调工具返回 `{pause}` 时，`callTool` 折成 `{ok:false,error:'cannot pause inside callTool'}`（暂停只能是顶层 model 触发，避免嵌套暂停语义混乱）。

## §9 目录与注册（一文件一工具，全部集中在 defs/ 一个文件夹）

**所有工具集中在 `tools/defs/` 一个文件夹，不分散到别处。** 一个工具 = 一个 `.ts`（自带 skill，见下），互不 import。

```
tools/
  TOOLS-SPEC.md          // 本文
  types.ts               // Tool / ToolSkill / ToolContext / ToolResult / ToolSummary / LoadedTool
  registry.ts            // createToolRegistry() + 单例 toolRegistry（抽象工厂，替掉旧 registry.ts）
  defs/                  // ← 所有工具都在这一个文件夹
    index.ts             // 显式 import 每个工具 + registry.register(...)（批量生成加一行）
    ask-user-question.ts // 各工具一个文件，export 一个 Tool（含其 skill）
    skill-search.ts
    skill-read.ts
    browser-action.ts
    save-file.ts
```

- **skill 内容默认内联在工具 `.ts` 里**（`skill.content` 用模板字符串）——保持「一文件一工具」，批量生成产一个 `.ts` 即可。指南很长时才拆出同目录 `defs/<name>.md?raw`（仍在同一文件夹）。
- `defs/index.ts` 显式注册（确定性 + 可 tree-shake），不用 `import.meta.glob`。批量生成 = 新增 `defs/<name>.ts` + index 里加一行 import/register。

## §10 批量生成模板

每个工具照此模板产出（生成器/LLM 只填 4 处：name/description/schema/execute 逻辑）：

```ts
// tools/defs/<name>.ts
import type { Tool } from '../types'

const inputSchema = { type: 'object', properties: { /* ... */ }, required: [/* ... */] }

export const <name>Tool: Tool = {
  name: '<name>',
  runtime: 'internal', // | 'browser' | 'server'
  skill: {
    description: '<一句话，给 model 看，进 manifest>',
    triggers: ['<可选触发词>'],
    content: `<完整使用指南（markdown）：何时用、参数含义、示例、注意事项。载工具时随 schema 给 model>`,
  },
  inputSchema,
  async execute(args, ctx) {
    // 1) 防御式取参：typeof 校验，非法 → return { ok:false, error:'...' }
    // 2) 纯逻辑；需要报进度 → ctx.progress('...')；需要别的工具 → await ctx.callTool('other', {...})
    // 3) return { ok:true, data:{...} }   // 或 { ok:false, error } / { pause }（仅 ask_user）
  },
}
```

**硬规则（批量生成必须遵守，review 照此查）**：
- ❌ 不 import 任何 `state/`（atom/writer/store）、不 import 别的工具模块、不碰 `rootStore`。副作用只经 `ctx`。
- ❌ 不自己判 ghost/stale（harness 管）；`execute` 只写纯逻辑 + 防御式取参。
- ✅ 失败 `return { ok:false, error }`，绝不 `throw`（除非要透传 AbortError）。
- ✅ colocated 测试 `<name>.test.ts`：mock 一个 `ctx`（`progress`/`callTool` 用 vi.fn），断言正常/非法参数/进度/互调各路径。

## §11 测试约定

- 工具单测：构造 fake `ctx`（`{ sessionId:'s', signal, progress: vi.fn(), callTool: vi.fn() }`），直接调 `tool.execute(args, ctx)` 断言返回的 `ToolResult` + `progress/callTool` 调用。**不需要 store**（这正是隔离的红利）。
- 工厂单测：register/list（无 schema）/loadSchema（有 schema）/run（未知名/错误封装/AbortError 透传）。
- 循环集成：modelRun 侧断言 `{ok}`/`{error}`/`{pause}` 三种映射 + 写回守卫（沿用现有 modelRun.test 范式）。

## §12 迁移（现有 5 工具 → 参考实现）

1. 建 `tools/types.ts`（§2）+ `tools/registry.ts`（工厂，§3）。旧 `tools/registry.ts` 的 summaries/schemas 数据拆进各 `defs/*.ts`。
2. 把 `runtime/toolExecution.ts` 的 switch 分支拆成 5 个 `defs/*.ts`（skill_search/skill_read/save_file/browser_action/ask_user_question），副作用改走 ctx：
   - skill_search/skill_read：现在直接 import `skills/registry`。迁移期可保留（skills 是只读查询，不是 atom 写入）；或后续也收进 ctx。**先保留**，不阻塞。
   - browser_action/save_file：现在直接 `addBrowserCard`/`addPendingArtifact`。改为 harness 在 ctx 上提供 `ui.renderCard`/`ui.saveArtifact`（作为 §5 白名单的扩展），或暂时由这两个工具经 ctx 的一个受控写入口。**迁移时定**，原则不变：工具不直接 import transientAtoms。
   - ask_user_question：`execute` 返回 `{pause:args}`（§7），删掉 modelRun 里的特判。
3. `runtime/toolLoading.ts` 数据源换成 `registry.loadSchema`；`modelRun` 的 tool 循环 dispatch 换成 `registry.run` + §4 结果映射。
4. 每步跑 colocated 测试 + `codex review --uncommitted` 收口。

## §13 范围外（现在不做）

- **不引 MCP / WASM 沙箱 / 能力域注入 ceremony**。当前工具是仓内可信 TS，用不上进程/沙箱隔离；`ctx` 白名单已够。
- `runtime:'server'` **只留标记**，不落远程传输（HTTP/invoke）实现。将来真要远程工具，再定「server 工具经某传输执行」的一层，不影响本抽象。
- `progress` 只做纯文本；结构化/百分比是后续加法。
