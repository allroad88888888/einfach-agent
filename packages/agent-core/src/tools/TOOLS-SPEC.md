# Tool Runtime Specification

> Status: implemented contract. This document describes the current tool runtime,
> not a migration plan.

## 1. Architecture

Tools are split into three layers:

| Layer | Responsibility |
| --- | --- |
| `packages/agent-core/src/tools` | Types, registry, validation, scheduling metadata, and the side-effect boundary |
| `tools/*` | Tool implementations grouped by domain |
| `tools/standard` | The standard tool bundle registered by the application |

The standard bundle currently exposes 31 tools across six domains:

- agents: `delegate_agent`, `observe_agent`, `join_agent`, `cancel_agent`
- filesystem: `read_file`, `list_files`, `search_files`, `rg_search`,
  `apply_patch`, `write_file`, `delete_path`, `copy_path`, `move_path`,
  `revert_workspace_change`, `find_test_lint_commands`
- interaction: `ask_user_question`, `browser_action`, `save_file`
- planning: `get_plan`, `create_plan`, `update_plan`, `execute_plan`,
  `submit_stage_result`
- shell: `shell_macos`, `shell_linux`, `shell_powershell`, `run_task`,
  `run_verification_command`, `git_diff_review`
- skills: `skill_search`, `skill_read`

Each domain registrar in `tools/<domain>/src/index.ts` is authoritative for this
list; treat the count above as a snapshot.

MCP is a seventh domain (`tools/mcp`). It is deliberately outside the standard
bundle: the application installs an `McpClientManager` against a registry and
that manager reconciles remote tools at runtime.

Applications register the bundle explicitly. Merely adding a source file does not
make a tool available.

## 2. Public contract

The canonical definitions live in `types.ts`.

```ts
type ToolRuntime = "internal" | "browser" | "server";

interface ToolSummary {
  name: string;
  description: string;
  runtime: ToolRuntime;
}

interface LoadedTool extends ToolSummary {
  inputSchema: JsonSchema;
  guide: string;
}

type ToolResult =
  | { ok: true; data?: unknown; warnings?: string[] }
  | { ok: false; error: string }
  | { pause: unknown };

interface Tool {
  name: string;
  runtime: ToolRuntime;
  skill: ToolSkill;
  inputSchema: JsonSchema;
  origin?: "local" | "external";
  callTiming?: ToolCallTiming;
  execution?: {
    mode: "serial" | "parallel";
    effectKeys?: readonly string[];
  };
  execute(
    args: unknown,
    context: ToolContext,
  ): ToolResult | Promise<ToolResult>;
}
```

`ToolCallTiming` 包含 `sessionStart`、`runStart`、`runEnd`、`turnStart`、`turnEnd`、
`preCompact`、`postCompact`、`subagentStart`、`subagentEnd`，并允许 `<domain>:<event>` 形式的扩展值。
`origin` 缺省为 `local`；`callTiming` 非空表示此工具只由宿主按该值到点分派，绝不进入模型清单、目录搜索或 `request_tool_schema`。
外部声明工具（如 MCP 清单）携带 `callTiming` 时在注册期剥除并记录诊断，不会中断外部连接——自动执行面不得被外部来源占用。
危险约束不在注册期表达：风险由运行时按调用上下文评估（dangerousTools 与确认门插件）；到点分派不经过确认门，因此分派器在执行前必须咨询既有风险评估，非 safe 的到点调用拒绝执行并记诊断。

`ToolSkill` contains the manifest description, optional triggers, and the
lazy-loaded guide content.

`ToolContext` is the exclusive capability boundary for side effects. It exposes
progress reporting, nested tool calls, subagent operations, plan operations,
shell execution, workspace operations, cards, and artifact saving. Tool
implementations should not import application state, Tauri APIs, or Node system
APIs to bypass this boundary.

子 Agent 操作由 Core 装配时可选注入的 `delegation` capability 提供。默认 Core 注入过渡期
factory；显式 `delegation: null` 时 `ToolContext` 不提供这些方法，`delegate_agent`、
`observe_agent`、`join_agent` 和 `cancel_agent` 返回不可重试的
`AGENT_DELEGATION_UNAVAILABLE`，并给出“子 Agent 委派能力不可用：当前运行环境未注入委派执行器。”。

## 3. Manifest and lazy loading

`ToolRegistry.list()` returns manifest-only `ToolSummary` objects. This keeps
normal model context small.

When the model selects a tool, `ToolRegistry.loadSchema()` returns its input
schema and guide. The selected schema can then be added to the next model
request. The runtime always validates and normalizes arguments before execution.

The registry returns structured failures for normal validation or execution
errors. `AbortError` is rethrown so cancellation remains observable by the
runtime.

`callTiming` 适合需要记账、可追踪且执行位置透明的宿主选工具场景；需要拦截、改写输入输出或改变控制流时，应使用 plugin hook。前者声明“何时执行哪个工具”，后者负责“如何拦截或变换”。

## 4. Runtime availability

- `internal`: pure runtime operations available in Web and Tauri.
- `browser`: browser-mediated interactions available in Web and Tauri.
- `server`: workspace and shell operations. They are hidden from the Web
  manifest and enabled only when the native bridge is available.

Availability is decided before a manifest is sent to the model. A model should
not see tools it cannot call in the current environment.

## 5. Scheduling and execution graph

Tools are serial by default.

Only tools marked with `execution.mode: "parallel"` may overlap, and the current
parallel set is limited to read-oriented operations: `read_file`, `list_files`,
`search_files`, `rg_search`, `find_test_lint_commands`, `git_diff_review`,
`get_plan`, `skill_search`, `skill_read`, `observe_agent`, and `join_agent`.

`effectKeys` describe resources touched by a call and are retained in the
session execution graph for inspection and future dependency rules. A batch is
run concurrently only when every call in that model response is explicitly
parallel, has valid arguments, and does not require confirmation. Mixed batches
stay on the ordered path.

Nested calls go through `ToolContext.callTool()` and therefore keep validation,
authorization, cycle/depth guards, abort handling, and graph tracking. A nested
tool is not allowed to pause the parent run.

## 6. Safety boundary

The runtime, rather than individual prompts, enforces these rules:

- dangerous tools require authorization before execution;
- stale or aborted calls cannot mutate the active run;
- nested calls are protected against recursion cycles and excessive depth;
- workspace paths are canonicalized under the configured root;
- workspace mutations are grouped into recoverable change sets;
- shell commands are non-interactive and have timeout and output limits;
- Git review commands are read-only;
- tool errors are returned as structured results instead of leaking raw
  exceptions into the model loop.

Frontend code remains responsible for the user-visible confirmation and pause
experience. Native code remains responsible for enforcing filesystem and
process isolation at the bridge boundary.

## 7. Adding or changing a tool

1. Choose the matching domain under `tools/`.
2. Keep the implementation, guide, and focused tests together.
3. Define an explicit JSON schema and runtime.
4. Use only `ToolContext` capabilities for effects.
5. Mark the tool parallel only when overlapping execution is safe; add stable
   effect keys when it touches a shared resource.
6. Export it from its domain and register it in `tools/standard/src/index.ts`.
7. Test both success and rejected-input paths.

Changing tool registration does not require changing the root application
protocol unless the public `ToolContext` or `ToolResult` contract changes.

## 8. Verification

Use the smallest relevant checks first:

```bash
pnpm exec vitest run tools
pnpm exec vitest run packages/agent-core/src/tools
pnpm build
```

If a `runtime: 'server'` tool changes, also run the host bridge's own suite and the
packed-artifact gate — those tools execute through `packages/host-node`, and the
gate is the only thing that runs the real binary:

```bash
pnpm exec vitest run packages/host-node
pnpm check:packed
```

The implementation, tests, and generated application manifest are authoritative
when this document and code disagree.
