# 006 独立审查

## 结论

**APPROVED** — 三个目标 consumer 已统一到同一实现，当前轮与 timed receipt 的既有范围语义均保持；TypeScript 命令只报范围外 `tools/**` 的 `*.md?raw` 解析错误，不阻断本叶。

审查只读取任务、执行报告、`git diff 17113d9 -- <task files>`、两个范围内未跟踪测试文件及必要的相邻定义；未重跑报告已执行的测试。

## 验收逐条判定

1. ✅ 定向 Vitest：执行报告记录 3 个测试文件、17 个测试全部通过。审查未重跑；代码检查确认新增用例覆盖锚点命中、锚点丢失回退和无 user 三类要求，并分别落到纯函数、未配对调用和恢复准入 consumer。
2. ✅ 私有副本扫描：报告记录 `rg "function (turnStart|currentRunStart)" packages/agent-core/src/runtime` 无匹配；diff 也确实删除了 `turnStart`、`currentRunStart`。范围内三个 consumer 均走 `activeTurnItems.ts` 的实现：
   - `currentTurnItems` 直接调用 `currentTurnStartIndex`（`activeTurnItems.ts:30-34`）；
   - `unresolvedToolCalls` 从该模块导入并调用（`toolCallOutcomeFacts.ts:4,31-37`）；
   - `requiresToolReconciliation` 从该模块导入并调用（`commands/recoveryCommands.ts:7,133-149`）。
3. ❌ 命令结果层面，`pnpm exec tsc -b packages/agent-core/tsconfig.json` 未通过，故不能把这一条记成“命令成功”。但执行报告中的 43 个诊断均为范围外 `tools/**` 的 `*.md?raw` 模块解析；任务 diff 没有触及 `tools/**`，这些导入、Markdown 输入和声明也都存在于基线。没有报告到六个任务文件的类型诊断，因此这是构建图/声明纳入方式的既有范围外故障，而非本叶引入的失败，裁决为不阻断本叶；应由编排者另行记账并在整体收尾时重跑。

## 重点语义核对

- `turnId === ''`：`if (turnId)` 不进入锚点查找，按“无有效锚点”回退到最后一条 user；若没有 user 则返回 0。与三个基线副本的行为一致。
- 重复 id：使用 `findIndex`，因此取 transcript 中第一个匹配项。与三个基线副本一致，没有在收敛时偷偷改变边界。
- 无 user：锚点不存在或未提供时返回 0；空数组也返回 0，`slice(0)` 安全。
- readonly items：参数外层声明为 `readonly ...[]`，实现只执行 `findIndex`、倒序读取和角色比较，不修改数组或元素；三个 consumer 后续均用非变异的 `slice`。
- 普通声明与普通 receipt：仍只检查 `currentItems`，所以锚点前的旧轮普通工具调用不会阻断恢复。
- timed receipt：仍单独遍历完整 `items` 构造 `timedReceipts`（`recoveryCommands.ts:143-148`），没有随 `currentItems` 缩到当前轮；基线已有的“turn anchor 之前 session-start receipt”恢复用例仍保留（`recoveryCommands.continue.test.ts:185-206`）。
- readonly 工具 outcome：`outcomeUnknown` 对 pure tool 的放行、`outcomeKnown` 必须有 receipt、未配对非 pure tool 的阻断逻辑均未被本 diff 改写（`recoveryCommands.ts:161-185`）。

## 质量发现

### Critical

无。

### Important

无。

### Minor

1. 范围外基线文件 `packages/agent-core/src/runtime/commands/turnSafety.ts:6-11` 还导出一个同名 `currentTurnStartIndex`，语义为“最后一条 user / 无 user 返回 -1”，且当前没有消费方。它不参与本任务的三个恢复 consumer，也不是本 diff 引入，故不阻断；但会削弱“仓库内唯一当前轮边界”这一命名认知，建议由编排者登记后删除或改名。
2. 新测试锁住了任务明确要求的锚点命中/丢失/无 user，但没有显式锁住空字符串、重复 id 和 readonly 编译契约。本次可由实现与基线逐行证明语义未变，因此不阻断；若后续要把 helper 作为稳定公共契约，建议补上这些边缘用例。

## 未跟踪文件检查

- `packages/agent-core/src/runtime/activeTurnItems.test.ts`：任务范围内新增测试，内容有效，提交时必须纳入。
- `packages/agent-core/src/runtime/toolCallOutcomeFacts.test.ts`：任务范围内新增测试，内容有效，提交时必须纳入。
- 未发现其他任务范围内未跟踪测试文件。
