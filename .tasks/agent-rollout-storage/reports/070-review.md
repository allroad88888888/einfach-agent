# 070 独立审查

结论：**REVIEW_FAIL**

审查范围仅限任务 frontmatter owners；未修改产品代码，未重跑执行者测试。

## Critical

1. `flush()` 失败发生在 child 错误处理之外，能产生互相矛盾的完成状态。

   `childAgentLoop.ts:266-271` 先 append `done`，随后 `finalizeChildResult()` 把 scheduler、archive 与 continuation 标为 done；直到 `finally` 的 `childAgentLoop.ts:291-296` 才调用 `flush()`。若 flush 拒绝，`runChildAgent()` 整体拒绝，但 rollout 最新状态和运行时 scheduler 已是 done，且没有机会补写 failed terminal。批调度器 `delegationBatch.ts:172-193` 不把该拒绝转换为 child failed，因此整个 batch 可能直接失败，无法返回一个一致的失败 child。强持久化完成边界没有原子的一致语义。

2. append 失败后的 failed terminal 若也失败，child 不会形成 failed 结果。

   initial、assistant、tool、synthesis append 的错误进入 `childAgentLoop.ts:282-290`，但 catch 内直接 await `recordTerminal(status, message)`；若 driver 是持续故障而非测试覆盖的一次性故障，这个第二次 append 再次拒绝，`finalizeChildResult()` 不执行，scheduler 仍可能停在 running，child Promise 继续向 batch 冒泡。验收要求“任一 append 失败都阻止后续模型请求并让 child failed”，当前只满足前半句。现有 runtime 测试特意只让 tool item append 失败、随后 terminal append 成功，未覆盖真实持续故障。

## Important

1. 强边界失败矩阵的测试覆盖不足。

   `runtime.childRollout.test.ts` 只覆盖成功顺序与 tool append 单次失败。未覆盖 initial、assistant、synthesis、done terminal、failed terminal、flush 的失败；尤其没有断言这些失败后模型调用次数、child/scheduler terminal 状态及 batch 是否仍返回结构化失败。这使上述两个 Critical 缺陷无法被当前定向测试发现。

2. nested/sibling 只验证 recorder 的手工输入，没有验证 runtime 实际传入当前 node path。

   `childRolloutRecorder.test.ts:68-83` 直接构造三个 recorder，并不能证明 nested delegation 的 runtime wiring 没有继承父 path。实现 `childAgentLoop.ts:119-124` 当前确实使用 `node.path`，静态检查看是正确的；但 C04 要求的 runtime 回归仍没有覆盖，未来接线漂移不会被测试拦住。

3. build 验收仍未得到可信证明。

   报告称 `tsup` 成功后被 `modelMigration.ts:25` 的 `DeepSeekReasoningEffort` 阻塞。该文件不在 070 owners 且当前相对基线无 diff；源码 `agent-ai/src/deepseek.ts` 的类型已包含 `'max'`，因此这更像工作区依赖产物/并发状态不一致，而不是 070 源码错误。但 `build` 脚本是 `tsup && tsc -p tsconfig.build.json && ...`，所以完整 build 确实没有通过，不能以 tsup 成功替代验收。应在稳定依赖产物下复核；本审查依指令未重跑。

## Minor

1. `recordInitial()` 接受任意数量/角色的 items，测试也只检查 ordinal，没有断言 initial 恰为 system、user 且内容等于第一次模型请求。runtime 成功测试以 role 顺序间接覆盖当前路径，但 recorder 合同本身较宽。

## 逐条验收

1. **部分通过**：静态调用链为 system、user、assistant、tool、synthesis user、assistant final；synthesis 在模型调用前记录，assistant/tool 在后续模型调用前 await。成功测试覆盖该顺序。
2. **失败**：各 item append 能封锁下一模型请求，但持续 append 故障不能稳定产出 failed child；terminal/flush 失败会逸出并造成状态不一致。
3. **部分通过**：target 使用 `conversationId/runId/node.path`，每 recorder ordinal 独立；缺少 nested/sibling runtime 集成证明。
4. **通过（静态与既有定向覆盖层面）**：无 driver 时 recorder 明确 no-op，原 trace 调用仍保留；执行报告称 timed/no-driver 相关定向测试通过，本审查未重跑。
5. **报告称通过但不足以放行**：13/13 定向测试通过；失败矩阵缺口导致关键语义未验收。
6. **通过**：`childAgentLoop.ts` 298 行、`childAgentToolCalls.ts` 292 行；其余 owner 文件分别 87、84、101 行，均不超过 300 行，职责拆分合理。两个临界文件已只剩 2/8 行余量，后续任何增长需优先按职责拆分。

## Owner 审计

070 的产品与测试改动均落在 frontmatter owners 中；未发现本任务需要跨 owner 的实现。工作区另有其他任务改动，本审查未归责给 070。

---

# R1 复审

结论：**REVIEW_PASS**

复审仍仅检查 frontmatter owners；未修改产品代码，未重跑执行者测试。

## 原 Critical 回归

1. **已修复：成功 terminal 与 flush 均先于 done finalize。**

   `childRolloutRecorder.ts:77-83` 的 `recordSuccess()` 依次 await `done` append 与 driver flush；`childAgentLoop.ts:266-271` 只有该方法成功后才调用 `finalizeChildResult(status:'done')`。done append 或 flush 任一失败都会落入同一 try/catch，不会先把 scheduler/archive finalize 为 done。

2. **已修复：持续持久化故障仍结构化 finalize failed/cancelled。**

   `childAgentLoop.ts:282-290` 捕获原始错误后调用 `settleFailure()`；后者在 `childRolloutRecorder.ts:84-97` 分别隔离 terminal append 与 flush 的失败，并保留原始执行错误，随后必然继续 `finalizeChildResult()`。initial/assistant/tool/synthesis 强写仍全部位于后续模型请求前，因此失败会封锁下一次请求。取消错误同样按 `cancelled → stopped` 尝试收尾，且收尾故障不改变结构化 cancelled 结果。

## 测试证据审查

- `runtime.childRollout.test.ts:61-133` 参数化覆盖 initial、assistant、tool、synthesis、done terminal、failed terminal、flush；断言结构化 failed、精确 model call 上限及 run-state 序列。failed-terminal 场景同时让原 assistant append 与 error terminal append 失败，覆盖持续故障。
- `childRolloutRecorder.test.ts:83-95` 分别覆盖 failed/cancelled 的 terminal append 与 flush 双故障不外溢。
- `runtime.childRollout.test.ts:135-186` 实际发起两个 sibling，并由 `root-01` 发起 nested delegation；断言 runtime 目标为 `root-01`、`root-02`、`root-01-01`，且每个 target 的 item ordinal 独立从 0 连续。原 C04 测试缺口已补齐。
- 成功用例继续证明实际模型上下文条目顺序为 system、user、assistant(tool call)、tool、synthesis user、assistant(final)，随后才写 done 与 flush。

## 其余核验

- no-driver 路径仍为明确 no-op，既有 archive trace/event 调用没有被删除或改写。
- owners 内物理行数为 100、96、294、292、187，均不超过 300 行；recorder 职责独立。两个 loop 文件仍临界，后续增长需要按职责拆分。
- 未发现新增 Critical、Important 或越权 owner 改动。
- 完整 build 仍受报告所述非 owner `modelMigration.ts`/工作区依赖产物问题阻塞；R1 报告未把 tsup 成功误报为完整 build 通过。该项是仓库级验收 concern，不构成 070 owners 的产品缺陷，需由编排者在稳定依赖状态下统一复核。

---

# R2 复审

结论：**REVIEW_PASS**

本轮只核验测试类型修复；未修改产品代码，未重跑测试。

- `childRolloutRecorder.test.ts:5-7` 的 `appendMock` 显式采用 `AgentRolloutDriver['append']` 作为实现与 mock 签名，保留 target、readonly mutations 与 append result 的完整合同，没有用宽泛 cast 掩盖类型错误。
- `firstItemOrdinal()` 与 `childTargetPath()` 分别通过 `mutationType === 'item_upsert'`、`target.kind === 'child'` 收窄 union 后访问字段；失败时主动抛错，因此不会把错误 mutation/target 静默算作通过。
- `runtime.childRollout.test.ts:73-82` 新增 `item.role === 'assistant'` 判别后才读取 `tool_calls`。阶段分类仍区分 tool-call assistant 与 final assistant，R1 的 initial/assistant/tool/synthesis/done/flush/failed-terminal 故障注入及 model-call/run-state 断言保持不变。
- sibling/nested target 集合与逐 target 连续 ordinal 断言保持不变；成功上下文顺序断言也未削弱。
- owner 产品文件内容与 R1 审查时的控制流一致；R2 报告明确仅修改测试类型。当前行数 100、111、294、292、188，均符合 300 行规则。
- 执行报告记录 `pnpm exec tsc -b --pretty false` 已零错误通过；依指令本审查未重跑。独立 core build 的非 owner concern 仍被如实保留，不影响本轮测试类型修复结论。

未发现新增 Critical 或 Important。
