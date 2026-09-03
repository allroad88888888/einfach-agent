# 017 独立审查

## 结论

APPROVED。未发现阻断项：旧 `currentTurnStartIndex` owner 已删除，canonical owner 的签名与 fallback 保持不变，side-effect 判定无语义改动，新测试真实覆盖关键分支，所有任务文件均远低于 300 行。

## 证据范围

审查仅使用：

1. `017-current-turn-owner.md`；
2. `reports/017-report.md`；
3. `git diff c804cd4 --` 限定的四个任务文件，并将未跟踪 `turnSafety.test.ts` 作为 `/dev/null` 到当前文件的新增 diff 审查。

未读取或引用其他审查报告、并行任务 diff 或会话历史；按委派要求未重跑测试或构建。

## 逐项验收

### 1. 唯一 `currentTurnStartIndex` owner：通过

- `activeTurnItems.ts` 保留 canonical `currentTurnStartIndex(items, turnId)`：优先使用 `turnId` 锚点，锚点缺失时回退到最后一条 user，无 user 时回退到 `0`。
- 基线 diff 只从 `commands/turnSafety.ts` 删除了忽略 `turnId` 且无 user 时返回 `-1` 的旧同名函数。
- `turnSafety.ts` 当前只导出 `currentTurnHasSideEffects`，未保留别名、转发或第二份轮边界算法。
- 实施报告记录的 runtime 范围 `rg` 结果为仅 `activeTurnItems.ts:12` 一个定义，与任务 diff 一致。

### 2. side-effect 语义不变：通过

- `turnSafety.ts` 的 diff 只删除旧 current-turn helper；`SIDE_EFFECT_TOOL_NAMES = new Set(['run_task'])` 与 `currentTurnHasSideEffects` 函数本身没有修改。
- 当前判定仍只检查 assistant 的 tool calls，对 `isDangerousTool(name)` 或显式 `run_task` 返回 true。
- 因为生产判定无 diff，不存在删除旧 helper 时顺带改变安全/危险工具分类的迹象。

### 3. 测试真实有效：通过

- `activeTurnItems.test.ts` 实际覆盖 4 项：`turnId` 锚点、缺失锚点回退最后 user、无 user 回退零点，以及 `currentTurnItems` 真实投影消费共享边界。
- 新增 `turnSafety.test.ts` 不是空测试：它直接调用真实 `currentTurnHasSideEffects`，且不 mock `isDangerousTool`。
- 该测试同时锁定了安全 `read_file -> false`、特别列入的 `run_task -> true` 和危险 `write_file -> true`，覆盖一条 false 路径与两种 true 来源。
- 两个文件的静态用例数为 5，与实施报告记录的“2 files / 5 tests passed”相互印证。按委派要求，本审查未重跑该命令。

### 4. 文件行数与职责：通过

`wc -l` 的当前物理行数：

| 文件 | 行数 | 职责判定 |
| --- | ---: | --- |
| `activeTurnItems.ts` | 35 | 提供当前轮对话切片 |
| `activeTurnItems.test.ts` | 31 | 验证当前轮切片契约 |
| `commands/turnSafety.ts` | 9 | 判定当前片段是否含副作用 |
| `commands/turnSafety.test.ts` | 23 | 验证副作用工具分类 |

全部低于 300 行，文件名与引用聚类均清晰，无假拆分或新增大杂烩。

## 构建可核实性

实施报告记录 agent-core 类型检查受既有 `*.md?raw` 声明问题及并行 018 类型改动阻断，根 build 亦受 018 阻断。在本审查限定证据与“不重跑”要求下，构建结果只能标记为**无法核实**；阻断点不在 017 任务 files 中，不作为否决理由。

## 发现

- Critical：无。
- Important：无。
- Minor：无。

## 边界

- 未修改产品源码或任务文档。
- 未 stage，未 commit。
