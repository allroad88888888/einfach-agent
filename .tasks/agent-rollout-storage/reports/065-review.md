# 065 独立审查

结论：**REVIEW_FAIL**

## Findings

### Important — reset 后旧在途 append 可清掉新生命周期的 previous

证据：`RecoveryWriter.reset()` 清空 `states` 并调用 coordinator 全局 `reset()`（`recoveryWriter.ts:247-250`）；reset 后同一 session 的新 `persist()` 会得到新 queue/state，可以与旧 state 中已经进入 `driver.append()` 的任务并发。旧 append 返回后，`saveCaptured()` 仅按 session id 调用 `resetSession(sessionId)`（`recoveryWriter.ts:127-129`），无法辨别 coordinator 中的 previous 是否已经属于 reset 后的新生命周期。

可复现交错：旧 capture A 进入 append 并阻塞 → `writer.reset()` → 新 capture B append 成功并把 B 设为 previous（`agentRolloutCoordinator.ts:16-25`）→ A 返回并执行 `resetSession(s1)` → B 的 previous 被误删 → 下一 capture C 再次按完整 backfill 写入，而不是相对 B 的 delta。若 A/B append 的完成顺序相反，结果又不同，属于真实 race。

影响：破坏“相同 capture 不重复”“previous 只随正确 session 生命周期推进”，跨 session/writer reset 后可能产生等价重复记录。现有 rollout 测试只覆盖顺序调用、failure、recovery retry 和已完成 persist 后 delete（`agentRolloutCoordinator.test.ts:32-71`、`recoveryWriter.rollout.test.ts:26-78`），没有覆盖 reset/delete 与在途 append、新生命周期复用 session id 的交错。

建议：让 previous 带 writer/coordinator lifecycle token，并只允许旧任务条件式清理自己所属 lifecycle；或 reset 时换用新的 coordinator 实例，使旧闭包不能修改新生命周期状态。补一条可控 promise gate 的 reset/in-flight/new-persist 测试。

### Important — rollout reject 被引入大量 fire-and-forget 调用，形成未处理 rejection

证据：rollout append reject 会从 `writer.persist()` 原样 reject（`recoveryWriter.ts:206-214`），bridge 的 `.then(...)` 没有 rejection handler（`persistenceBridge.ts:155-163`）。但现有生产路径大量明确丢弃该 Promise，例如 `runToolLoop.ts:41-44, 53-63, 151-164`、`toolLoopSupport.ts:69-77`、`runLifecycleCommands.ts:72-81, 114-124`。这些调用原先只会 resolve `RecoveryWriteOutcome`，配置 rollout 后则会产生未处理 Promise rejection。

影响：未处理 rejection 会污染测试/遥测，并在采用严格 unhandled-rejection 策略的宿主中终止进程。部分 fire-and-forget capture 也没有直接把失败反馈给发起状态变更的调用方。模型入口本身在 `modelRunLifecycle.ts:51-60, 71-83` 正确 await 并阻断，因此“下一次模型请求”主门成立；问题在其它现存调用方的兼容回归。

建议：为 fire-and-forget 路径提供显式 best-effort wrapper/集中 failure handler，或统一迁移调用方处理 rejection；同时保留模型/tool execution fence 上可观察、可阻断的 reject。补未配置 driver 与已配置但 append reject 的调用路径回归测试。

## 验收逐条核对

1. append/update/reorder/delete 与相同 capture 去重：**部分满足**。顺序路径由 `agentRolloutCoordinator.test.ts:33-56` 覆盖；reset race 可令相同状态再次完整 backfill。
2. rollout failure 阻止 recovery、previous 不前移、调用方 reject：**满足（定向证据）**。实现顺序见 `recoveryWriter.ts:121-139`，测试见 `recoveryWriter.rollout.test.ts:27-42`。
3. recovery failure 保留 rollout、重试不重复、最终 recovery 成功：**满足（定向证据）**。previous 在 append 成功后推进，测试见 `recoveryWriter.rollout.test.ts:44-63`。
4. hydration 后首次完整 backfill、第二次为空：**实现机理成立但缺直接 hydration 验收证据**。新 coordinator 的 map 为空会完整写入，顺序重复 capture 测试可证明第二次为空；没有测试从旧 SQLite hydrate 入口贯通到首次 capture。
5. session delete 不调用 rollout delete、recovery delete 保持：**基本满足**。合同没有 rollout delete；测试见 `recoveryWriter.rollout.test.ts:65-78` 及既有 tombstone 测试。但该测试用 `flush` spy 代指不存在的 delete，只能证明 flush 未调用，证据较弱；delete/in-flight 清理逻辑存在，但没有覆盖 reset 后新生命周期竞态。
6. 指定 Vitest：执行报告称 `3 files / 7 tests passed`；本审查按要求未重跑。
7. tsc/check:state/行数：执行报告称通过，最高 253 行；静态查看 owners 未发现超限。报告还声称 `check:boundaries` 与 `git diff --check` 通过。

## 重点语义审查摘要

- 正常顺序为 capture → rollout append → recovery load/save → history-log flush；history flush 只在 recovery `saved` 后触发，且保持原 best-effort generation 配对语义。
- rollout 失败时 previous 不推进；recovery 失败时 previous 保留，从而重试不重复 rollout。
- session delete 不删除 rollout；旧 SQLite session 的首次 capture 可由空 previous 做 backfill。
- 未配置 driver 时 coordinator 不创建，既有 recovery 路径保持 no-op rollout；但缺新增绑定层的明确回归用例。
- 阻断验收的问题是 reset/in-flight previous race，以及新 reject 语义与既有 fire-and-forget 调用不兼容。

---

# R1 复审

结论：**REVIEW_PASS**

## 原 Important 复核

### 已修复 — reset/in-flight coordinator lifecycle 隔离

`persist()` 在入队前捕获当前 coordinator（`recoveryWriter.ts:214-218`），`saveCaptured()` 的 append 与竞态后清理始终只操作该捕获实例（`recoveryWriter.ts:119-138`）。`reset()` 先 reset 旧实例，再原子替换为新实例（`recoveryWriter.ts:254-258`）。因此旧 A append 返回后的 `captureCoordinator.resetSession()` 无法触及 reset 后 B/C 所用的新 coordinator previous。

新增 gate 测试精确覆盖原反例顺序：A append 阻塞 → reset → B 成功 → A 返回 skipped → C 相同 capture 去重；最终 append 仅两次（`recoveryWriter.rollout.test.ts:48-72`）。该修复消除了旧 lifecycle 清掉新 lifecycle previous 的路径。

### 已修复 — rollout failure outcome 与 fire-and-forget 兼容

`saveCaptured()` 在 rollout append 周围捕获异常并返回 `RecoveryWriteOutcome {status:'error'}`，且 return 发生在任何 recovery load/save 之前（`recoveryWriter.ts:126-148`）。`persist()` 因此正常 resolve outcome（`recoveryWriter.ts:216-222`），bridge 的 `.then()` 也正常完成；既有 `void persistRecovery(...)` 路径不会再产生 rollout 导致的 unhandled rejection。

模型执行入口仍 await `persistRecovery()` 并且只接受 `undefined`/`saved`，`error` 会将 run 标为 interrupted 且不调用 model loop（`modelRunLifecycle.ts:51-60, 71-83`）。新增测试直接证明 rollout reject 时 `runLoop` 未调用并进入 interrupted（`recoveryWriter.rollout.test.ts:74-91`）。failure 后 previous 不前移、recovery 未触碰及完整 backfill 重试由 `recoveryWriter.rollout.test.ts:29-46` 覆盖。

## 其余验收与回归

- 正常顺序仍为 snapshot capture → rollout append → recovery load/save → successful outcome 后 history-log flush；rollout error 不进入 recovery。
- recovery failure 后已成功 append 的 previous 保留，重试不重复 append（`recoveryWriter.rollout.test.ts:102-121`）。
- 未配置 rollout 时 coordinator 为 `undefined`，recovery 正常保存；新增回归见 `recoveryWriter.rollout.test.ts:93-100`。
- delete 仍只 tombstone recovery 并清理内存 previous，不存在 rollout delete API；旧在途任务只清理其捕获 coordinator。
- 首次 capture 的空 previous 产生完整 backfill，第二次相同 capture 为空；旧 SQLite hydration 不向 coordinator 注入 previous，因此遵循同一路径。
- history-log 仍仅在 recovery `saved` outcome 后 best-effort flush，generation/undo 配对未改变。
- owners 共 7 个文件均低于 300 行，最高 `recoveryWriter.ts` 261 行。
- 执行报告称指定 Vitest `3 files / 10 tests`、既有回归 `3 files / 24 tests`、tsc、state、boundaries 与 diff check 全部通过；复审按要求未重跑。

未发现新增 Critical 或 Important。
