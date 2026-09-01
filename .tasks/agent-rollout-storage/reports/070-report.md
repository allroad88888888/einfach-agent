# 070 执行报告

状态：DONE_WITH_CONCERNS（R1/R2 已修复；独立 core build 仍有非 owner 阻塞）

## 交付

- 新增 `childRolloutRecorder.ts`，为每个 child 构造独立逻辑 target，分配稳定 item id 与从 0 连续的 item ordinal。
- 在 `child_started` 后强写 initial system/user 与 running state；assistant、tool result、max-turn synthesis user 均在后续模型请求前 await append。
- terminal 状态强写后在 child 完成边界 flush；未配置 driver 时保持明确 no-op，原 archive trace 行为不变。
- sibling 与 nested child 的 target/ordinal 隔离由单元测试覆盖；runtime 测试覆盖完整两轮顺序和 tool append 失败阻断下一次模型请求。
- R1 将成功边界收敛为 `recordSuccess()`：done append 与 flush 均成功后才 finalize done；任一步失败都会进入 catch。
- R1 将失败收尾收敛为 `settleFailure()`：failed/cancelled terminal append 与 flush 均 best-effort，持续故障不会覆盖原始错误或阻止结构化结果。
- R1 参数化覆盖 initial、assistant、tool、synthesis、done terminal、failed terminal 与 flush 故障，并断言模型调用次数与 terminal 状态序列。
- R1 runtime 集成覆盖实际 sibling/nested `node.path` target，验证 `root-01`、`root-02`、`root-01-01` 各自 ordinal 从 0 连续。
- R2 仅调整测试类型：为 append mock 提供 `AgentRolloutDriver['append']` 显式签名，并以 mutation/target 判别函数安全收窄 union；产品语义未变。

## 验证

- 定向 Vitest：22/22 通过。
- `pnpm check:boundaries`：通过。
- `pnpm check:state`：通过。
- `git diff --check`：通过。
- R2 `pnpm exec tsc -b --pretty false`：通过，零错误。
- R1 复跑 `pnpm --filter @einfach-agent/core build`：tsup 成功，随后仍被非 owner `src/state/persistence/modelMigration.ts:25` 的 `DeepSeekReasoningEffort` 类型错误阻塞；本任务未修改该文件。
- R2 再次复跑独立 core build，仍为同一非 owner `modelMigration.ts:25` 错误；完整 project-reference `tsc -b` 已通过。
- ESLint 未运行：仓库未安装 `eslint` 命令。

## 文件职责与行数

- `childRolloutRecorder.ts`：100 行，只负责 child rollout mutation 与强写/收尾边界。
- `childRolloutRecorder.test.ts`：111 行，只验证 recorder 合同。
- `runtime.childRollout.test.ts`：188 行，只验证 child runtime rollout 时序、失败 fence 与 target 隔离。
- `childAgentLoop.ts`：294 行。
- `childAgentToolCalls.ts`：292 行。

`one-file-one-thing` 规则使写入逻辑留在独立 recorder；两个既有临界文件均未越过 300 行，因此未请求 owner 扩展或 helper 拆分。
