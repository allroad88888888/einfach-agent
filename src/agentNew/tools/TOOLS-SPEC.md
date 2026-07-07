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
export type ToolRuntime = 'internal' | 'browser' | 'server' // server = 依赖 Tauri 原生能力（shell/文件系统）；web 下不进 manifest（TP3，见 §16）

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

// 受控本机 shell 结果。ctx.runShell 应 resolve 结构化结果；除 AbortError/stale 外不把命令失败抛给工具。
export type ShellPlatform = 'macos' | 'linux' | 'windows'
export interface ShellCommandInput {
  platform: ShellPlatform
  command: string
  cwd?: string
  timeoutMs?: number
  maxOutputChars?: number
  env?: Record<string, string>
}
export interface ShellCommandResult {
  platform: ShellPlatform
  shell: string
  command: string
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
}

// 工具拿到的唯一副作用面（白名单）。工具不 import 任何 atom/store —— 一切副作用都在这里。
export interface ToolContext {
  readonly sessionId: string
  readonly signal: AbortSignal
  progress(text: string): void                                 // 显示「工具正在干啥」（§5）
  callTool(name: string, args: unknown): Promise<ToolResult>   // 工具互调（§8）
  // —— 受控副作用（harness 实现 + 集中 stale/ghost 守卫，工具不再各写）——
  renderCard(card: { title: string; body?: string }): { cardId: string } | { error: string }
  saveArtifact(file: { filename: string; content: string; mimeType?: string }): { artifactId: string } | { error: string }
  runShell(input: ShellCommandInput): Promise<ShellCommandResult> // 唯一允许调用本机 shell 的前端入口（§14）
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
| 本机 shell | `ctx.runShell(input)` | shell tools 用。**这是前端唯一允许调用本机 shell 的入口**；harness/Tauri command 负责平台、timeout、输出截断和结构化 `ShellCommandResult`。 |

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

## §9 目录与注册（每个工具一个独立文件夹）

**每个工具一个独立文件夹**，文件夹内放三件一起：Tool 实现 `.ts` + skill 正文 `.md`（同目录）+ colocated 测试。工具之间互不 import。

```
tools/
  TOOLS-SPEC.md          // 本文
  types.ts               // Tool / ToolSkill / ToolContext / ToolResult / ToolSummary / LoadedTool
  registry.ts            // createToolRegistry() + 单例 toolRegistry
  register.ts            // 显式 import 每个工具 + toolRegistry.register(...)（批量生成加一行）
  skill-search/          // ← 每个工具一个独立文件夹
    skill-search.ts      //   Tool 实现（import ./skill-search.md?raw 作 skill.content）
    skill-search.md      //   skill 正文（?raw，同目录，§2 的 ToolSkill.content）
    skill-search.test.ts //   colocated 测试
  skill-read/            { skill-read.ts / .md / .test.ts }
  ask-user-question/     { … }
  browser-action/        { … }
  save-file/             { … }
  shell-macos/           { shell-macos.ts / .md / .test.ts }       // tool.name = shell_macos
  shell-linux/           { shell-linux.ts / .md / .test.ts }       // tool.name = shell_linux
  shell-powershell/      { shell-powershell.ts / .md / .test.ts }  // tool.name = shell_powershell
```

- **skill 正文放同目录的 `<name>.md`**（`?raw` 导入，`vite-env.d.ts` 已声明 `*.md?raw`），工具 `.ts` 里 `content: <name>Md`。
- `register.ts` 显式注册（确定性 + 可 tree-shake），不用 `import.meta.glob`。运行时经 `import '../tools/register'`（modelRun 已引）触发注册。
- **批量生成 = 新建 `tools/<name>/` 一个文件夹（`.ts` + `.md` + `.test.ts`）+ register.ts 加一行 import/register**。

## §10 批量生成模板

每个工具照此模板产出（生成器/LLM 只填 4 处：name/description/schema/execute 逻辑）：

```ts
// tools/<name>/<name>.ts
import type { Tool } from '../types'
import guide from './<name>.md?raw' // skill 正文（同目录 .md）

const inputSchema = { type: 'object', properties: { /* ... */ }, required: [/* ... */] }

export const <name>Tool: Tool = {
  name: '<name>',
  runtime: 'internal', // | 'browser' | 'server'
  skill: {
    description: '<一句话，给 model 看，进 manifest>',
    triggers: ['<可选触发词>'],
    content: guide, // 完整指南在同目录 <name>.md，载工具时随 schema 给 model
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
- ❌ 不绕过 `ctx` 做本机副作用：shell tools 不直接 `invoke` Tauri command、不直接碰进程 API；只能调 `ctx.runShell`。
- ❌ 不自己判 ghost/stale（harness 管）；`execute` 只写纯逻辑 + 防御式取参。
- ✅ 失败 `return { ok:false, error }`，绝不 `throw`（除非要透传 AbortError）。
- ✅ colocated 测试 `<name>.test.ts`：mock 一个 `ctx`（`progress`/`callTool` 用 vi.fn），断言正常/非法参数/进度/互调各路径。

## §11 测试约定

- 工具单测：构造 fake `ctx`（`sessionId`/`signal` + `progress`/`callTool`/`renderCard`/`saveArtifact`/`runShell` 的 vi.fn 或 noop），直接调 `tool.execute(args, ctx)` 断言返回的 `ToolResult` + 对应 ctx 方法调用。**不需要 store**（这正是隔离的红利）。
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
- `runtime:'server'` **已激活为「本机 Tauri 原生能力」语义**（shell/文件工具，见 §16/TP3），web 下不进 manifest。仍**不做**「server 工具经 HTTP 远程传输」那一层——server 目前专指本机 Tauri command，不是远程。
- `progress` 只做纯文本；结构化/百分比是后续加法。

## §14 shell tools（Tauri 本机 shell）

shell tools 只是本规范下的普通 lazy tools，不开新通道：

- **manifest-only 不变**：`registry.list()` 只暴露 `shell_macos` / `shell_linux` / `shell_powershell` 的 name/description/runtime；完整 `inputSchema` 和 guide 只能由 `request_tool_schema` → `registry.loadSchema(name)` 懒加载。不得因为 shell 高风险而预加载 schema，也不得把命令参数说明塞进 manifest。
- **副作用只经 `ctx`**：三个工具的 `execute` 只做参数校验、平台声明、进度文本和结果包装；真正调用本机 shell 只能 `await ctx.runShell(...)`。前端 TS 里不允许工具、runtime、UI 直接调用 Tauri `invoke` 跑 shell；`ctx.runShell` 是唯一前端入口。
- **Tauri command 是唯一 native spawn 点**：`runtime/toolContext.ts` 负责把 `ctx.runShell` 接到 `run_shell_command`；Rust 后端 command 负责创建非交互进程、kill timeout 进程、截断输出并返回 `ShellCommandResult`。浏览器环境没有 Tauri 时也归一成结构化 `ShellCommandResult`，不降级到 Web API。

内置三个工具：

| 工具名 | 目标平台 | 说明 |
|---|---|---|
| `shell_macos` | macOS / Darwin | 执行 macOS 非交互 shell 命令。平台不匹配时返回结构化失败结果。 |
| `shell_linux` | Linux | 执行 Linux 非交互 shell 命令。平台不匹配时返回结构化失败结果。 |
| `shell_powershell` | Windows / PowerShell | 以 `platform:'windows'` 执行 PowerShell 非交互命令。平台不匹配或 PowerShell 不可用时返回结构化结果。 |

安全约束（实现和 review 都按这个查）：

- **非交互**：不分配 PTY，不支持交互式 stdin，不允许等待用户输入；命令必须一次性提交并在完成、超时或 abort 后结束。
- **timeout 必须有上限**：schema 可暴露 `timeoutMs`，但 Tauri command 必须有默认值和硬上限；超时要终止进程并返回 `ShellCommandResult`，其中 `timedOut:true`。
- **输出截断**：stdout/stderr 必须按字节或字符上限截断，返回 `truncated:true`，并保留 stdout/stderr 的结构化字段；不得把无限输出塞进 tool result。
- **平台匹配**：工具名声明的平台必须和后端检测结果匹配；不匹配不尝试执行，返回结构化失败结果（固定字段里至少有 `platform/shell/command/cwd/exitCode/stdout/stderr/durationMs/timedOut/truncated`，`stderr` 说明 platform mismatch）。
- **cwd 不硬编码本机路径**：工具实现、guide、测试和示例不得写死 `/Users/...`、`/Volumes/...`、`C:\Users\...` 等开发机路径。`cwd` 只能来自 schema 参数、会话/工作区上下文或后端默认工作目录；无效目录返回结构化失败结果，`stderr` 说明 cwd 无效原因。
- **错误结构化返回**：参数非法仍用工具层 `{ ok:false, error:'...' }`；命令执行失败（非零退出、timeout、spawn 失败、平台不匹配、cwd 无效）经 `ShellCommandResult` 的固定字段返回 `exitCode/stdout/stderr/durationMs/timedOut/truncated`，不抛裸异常、不只回自由文本。

最终验收清单：

- [ ] `shell_macos` / `shell_linux` / `shell_powershell` 都按 §9 目录结构落地：`.ts` + `.md` + `.test.ts`，并在 `register.ts` 显式注册。
- [ ] registry 单测覆盖 manifest-only：`list()` 里三个 shell tools 只有 name/description/runtime；`loadSchema()` 才出现 schema + guide。
- [ ] 工具单测覆盖：合法参数调用 `ctx.runShell`；非法参数返回工具层 error；平台不匹配/timeout/输出截断/非零退出/cwd 无效都映射为结构化 `ShellCommandResult`。
- [ ] `ctx.runShell` / Tauri command 桥接单测或编译检查覆盖：前端没有绕过 ctx 的 shell 调用；Rust command 能编译，返回类型能被 TS 侧消费。
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `cd src-tauri && cargo check`

## §15 workspace file tools（读写/patch/diff）

文件工具也只是普通 lazy tools，不绕过 `ToolContext`：

- **读工具**：`read_file` / `list_files` / `search_files` 只读 workspace 内文本内容，路径由 Tauri 后端做 canonical 校验，拒绝逃逸路径、binary/超大输出，并返回截断标记。
- **代码搜索主力**：`rg_search` 是 grep 类能力的专业实现，底层调用 ripgrep (`rg --json`)；默认普通字符串搜索，显式 `regex:true` 才启用正则，支持 glob、大小写、上下文行和总匹配上限。
- **主力修改工具**：`apply_patch`。模型应优先用结构化 patch 修改已有源码；patch operation 必须带上下文或期望旧内容，后端按原子语义处理，存在 rejected operation 时不做部分写入。
- **补充写入工具**：`write_file`。只用于新文件、小文件、生成物或明确的 append/overwrite；修改已有源码时应优先 `apply_patch`。
- **review 工具**：`git_diff_review` 只读 Git status/diff/stat，不修改文件，适合提交前检查和模型自审。
- **副作用只经 `ctx`**：工具不得直接 import Tauri API 或 Node/Rust FS 能力；前端唯一入口是 `ctx.readWorkspaceFile` / `ctx.listWorkspaceFiles` / `ctx.searchWorkspaceFiles` / `ctx.rgSearchWorkspace` / `ctx.applyWorkspacePatch` / `ctx.writeWorkspaceFile` / `ctx.getWorkspaceDiff`。

安全约束：

- **workspace root 必须可信**：前端显式传入优先，否则 Rust 侧 `git rev-parse --show-toplevel` 派生 git 根，都拿不到则报错——绝不回退到不可控的 process cwd；解析出的 root 若是文件系统根（`/`）一律拒绝。所有 path 必须 canonicalize 后 `starts_with(root)`（含符号链接 / `..` 解析），绝对路径也照此限制。
- 文件读取、搜索、rg、diff、写入都必须有大小/条数上限，并返回 `truncated` 或结构化错误。`rg_search` 不走 shell，argv 调 `rg`；达到 `maxMatches` 后停止读取并 kill 子进程，防大仓库无限输出。
- 写入类工具不得静默覆盖：`apply_patch` 依赖 `oldText` / `oldContent` / `expectedReplacements`；`write_file` 的 overwrite 可用 `expectedOldContent` 防竞态。同一批 operations 里先 `delete_file` 再 `add_file` 同路径**不得**绕过 overwrite 守卫（本批开始时磁盘上已存在的文件即视为「已存在」）。`write_file` 结果 `path` 返回 workspace 相对路径，不泄漏本机绝对路径。
- `git_diff_review` 调 git 时不得走 shell；用 argv 传参，path 转 workspace 相对路径。**只读保证要硬**：所有 git 子进程统一经加固入口——`--no-ext-diff --no-textconv` + `-c diff.external=` + env `GIT_EXTERNAL_DIFF=""`（禁外部 diff/textconv 执行）、`GIT_LITERAL_PATHSPECS=1`（pathspec 字面化，`:(top)`/`*.ts` 不被展开）、`GIT_OPTIONAL_LOCKS=0`（禁 `status` 刷 `.git/index`，真只读）。大 diff 用流式 capped read + 达上限 kill，不整块缓冲。

## §16 server runtime · Tauri-primary（TP1–6）

决策（2026-07）：**Tauri = 唯一产品目标 + 能力基准；web 降级为 dev 预览**。`runtime:'server'` 的工具（shell×3 + `read_file`/`write_file`/`list_files`/`search_files`/`rg_search`/`apply_patch`/`git_diff_review`）依赖 Tauri 原生 command，只在桌面可用。完整契约与阶段见 `../TAURI-PIVOT-PLAN.md`；要点：

- **TP2 副作用单入口**：工具只经 `ctx`（`runShell`/`readWorkspaceFile`/…）碰原生能力，**禁止**直接 `import '@tauri-apps/api'`；invoke 细节封在 `runtime/*.ts` 桥接层。web 无 Tauri 时桥接层归一成结构化失败（`unavailable`），绝不崩、绝不降级到 Web API。
- **TP3 manifest 环境降级**：`runtime:'server'` 工具在 **web 下不进 manifest**——`modelTurn.ts` 的 `buildTurnTools(visible, isTauri)` 用 `runtime !== 'server' || isTauri` 同时过滤 `request_tool_schema` 的 enum 与 visible 展开，`modelRun` 注入 `isTauri()`。model 在 web 下根本看不到 server 工具，不会白白调用。三层防御：manifest 过滤 → visible 过滤 → 桥接层 `isTauri()` 兜底。
- **TP4 安全边界**：见 §14/§15 —— shell 非交互 + timeout/输出上限；文件工具可信 root（显式优先→git root→拒 `/`）+ canonical confine；git 只读加固。用户确认 UI 尚未做（后续 S4）。
- **TP6 command 对齐**：`ctx.*` → Rust `#[tauri::command]` 参数逐字对齐（snake_case，如 `run_shell_command` / `workspace_root`）。
