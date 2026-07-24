# delegate_agent

Start a bounded batch of headless child agents for parallel analysis. The call returns an execution
handle immediately; it does not wait for the child tree.

## Parameters

- `children` (required): array of child task specs.
- `children[].objective` (required): the concrete task for that child agent.
- `children[].mode` (optional): short working style, such as `explore`, `review`, `design`, or `verify`.
- `children[].expectedOutput` (optional): the shape of result the parent needs.
- `children[].maxTurns` (optional): per-child LLM turn budget.
- `children[].toolProfile` (optional): narrows that child to `delegate_only` or `workspace_read`; it cannot widen the batch profile.
- `children[].confirmedTools` (optional): narrows the batch's host-confirmed dangerous-tool capability for that child.
- `toolProfile` (optional): effective child-tool profile. Defaults to `delegate_only`; `workspace_read` additionally permits `read_file`, `list_files`, `search_files`, and `rg_search`.
- `confirmedTools` (optional): dangerous tools explicitly requested for this exact delegation call. Omission means none; accepted names are `shell_macos`, `shell_linux`, `shell_powershell`, `write_file`, and `apply_patch`.
- `strategy` (optional):
  - `parallel_wait_all`（默认）：brief 蒸馏任一失败则不派发该批次；运行期混合成功/失败时批次状态为 `failed`。
  - `parallel_best_effort`：brief 失败使用降级 brief；运行期局部失败不抹掉成功结果，混合结果状态为 `partial`。
- `maxDepth` (optional): maximum tree depth from `root`.
- `maxChildren` (optional): maximum children in this batch.
- `maxConcurrent` (optional): root-level model request concurrency cap for the whole tree; nested calls may only lower it for their branch.
- `maxTotalNodes` (optional): whole-tree node budget, including `root` (default `64`, hard maximum `256`). All descendants share the same counter and cannot enlarge the inherited limit.
- `maxModelCalls` (optional): whole-tree model request budget, including distillation and child turns (default `128`, hard maximum `512`). A request is charged after it obtains a concurrency permit and immediately before the actual model call; descendants cannot enlarge the inherited limit.

Budget exhaustion is explicit: the current delegation/model turn fails with a `subagent tree ... budget exhausted` error. Already completed siblings remain archived.

## Use

- Use this when independent lines of investigation can run in parallel.
- Continue independent parent work after spawning. Use `observe_agent` to inspect progress and
  `join_agent` only when the child result is a dependency.
- Give each child one focused objective and an explicit expected output.
- Child agents inherit a distilled parent skill plus their task brief.
- A child agent may call `delegate_agent` again when the task naturally splits further and depth budget remains.
- Root depth/children/concurrency budgets are immutable upper bounds; descendants may narrow but never expand them.
- Tool profiles follow the same monotonic rule: descendants inherit omission, may narrow `workspace_read` to `delegate_only`, and may never widen.
- Dangerous permissions are separate from profiles. The host issues a capability bound to the current session, run, tool-call id, and parent path. A request can only narrow that capability.

## Constraints

- Do not pass path, id, filesystem paths, or cache names; the runtime assigns them.
- Do not use this for simple follow-up reasoning that fits in the parent context.
- Child agents run headless and return structured Markdown summaries to the parent.
- Workspace reads and explicitly confirmed dangerous tools are executed by the host through the normal tool context, preserving workspace-root, stale-run, abort, and tool-confirmation guards.
- A session-level “always allow” entry alone is not inherited. The current `delegate_agent` call must also explicitly list the tool, and the host signs only the intersection. One-time confirmations are not delegated.
- Omission of `confirmedTools` means no dangerous tools at every tree level. Nested calls and children must explicitly request a subset; they cannot inherit by omission or widen it.
- Effective dangerous-tool names are archived on `delegate_requested`; the capability object itself is host-only and never model-controlled.
- Task and browser tools are never exposed. Unconfirmed write, shell, and patch tools remain unavailable.

## Batch result semantics

Every child keeps its own `status`, `summary`, and `error`. The batch additionally returns:

- `summary`: exact `total`, `done`, `failed`, and `cancelled` counts.
- `status: done`: every child completed.
- `status: failed`: `parallel_wait_all` has any failed child, or every child failed under best effort.
- `status: partial`: only `parallel_best_effort` with both completed and failed children.
- `status: cancelled`: cancellation occurred.

For archive/UI compatibility, a `partial` root node is stored as `done`; failed child nodes and their errors remain independently visible in the tree and event log.
