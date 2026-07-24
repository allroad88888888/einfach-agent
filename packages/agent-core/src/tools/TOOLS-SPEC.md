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

The standard bundle currently exposes 27 tools:

- agents: `delegate_agent`, `observe_agent`, `join_agent`
- filesystem: `read_file`, `list_files`, `search_files`, `rg_search`,
  `apply_patch`, `write_file`, `delete_path`, `copy_path`, `move_path`,
  `revert_workspace_change`
- interaction: `ask_user_question`, `browser_action`, `save_file`
- planning: `create_plan`, `update_plan`, `execute_plan`,
  `submit_stage_result`
- shell: `shell_macos`, `shell_linux`, `shell_powershell`, `run_task`,
  `git_diff_review`
- skills: `skill_search`, `skill_read`

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

`ToolSkill` contains the manifest description, optional triggers, and the
lazy-loaded guide content.

`ToolContext` is the exclusive capability boundary for side effects. It exposes
progress reporting, nested tool calls, subagent operations, plan operations,
shell execution, workspace operations, cards, and artifact saving. Tool
implementations should not import application state, Tauri APIs, or Node system
APIs to bypass this boundary.

## 3. Manifest and lazy loading

`ToolRegistry.list()` returns manifest-only `ToolSummary` objects. This keeps
normal model context small.

When the model selects a tool, `ToolRegistry.loadSchema()` returns its input
schema and guide. The selected schema can then be added to the next model
request. The runtime always validates and normalizes arguments before execution.

The registry returns structured failures for normal validation or execution
errors. `AbortError` is rethrown so cancellation remains observable by the
runtime.

## 4. Runtime availability

- `internal`: pure runtime operations available in Web and Tauri.
- `browser`: browser-mediated interactions available in Web and Tauri.
- `server`: workspace and shell operations. They are hidden from the Web
  manifest and enabled only when the native bridge is available.

Availability is decided before a manifest is sent to the model. A model should
not see tools it cannot call in the current environment.

## 5. Scheduling and execution graph

Tools are serial by default.

Only tools marked with `execution.mode: "parallel"` may overlap. The current
parallel set is limited to read-oriented operations such as observation,
filesystem search/read, diff review, and skill search/read.

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

If the native bridge or a server tool changes, also run:

```bash
cargo test --manifest-path apps/desktop/Cargo.toml
```

The implementation, tests, and generated application manifest are authoritative
when this document and code disagree.
