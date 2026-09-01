---
id: "080"
title: 装配 server Web 与 CLI
kind: leaf
parent: "4000"
depends_on: ["050", "065", "070"]
discovered_from: null
model: gpt-5.6-terra
status: done
repair_round: 2
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - apps/web/src/persistence/serverAgentRolloutDriver.ts
  - apps/web/src/persistence/serverAgentRolloutDriver.test.ts
  - apps/web/src/persistence/persistenceDrivers.ts
  - apps/web/src/persistence/persistenceDrivers.test.ts
  - apps/web/src/main.tsx
  - apps/web/src/main.serverHost.test.tsx
  - apps/web/src/main.serverRolloutCorruption.test.tsx
  - apps/cli/src/runtime.ts
  - apps/cli/src/runtime.test.ts
  - apps/cli/src/persistence.ts
  - apps/cli/src/persistence.test.ts
  - apps/cli/src/bootstrap.ts
  - apps/cli/src/bootstrap.test.ts
  - apps/cli/src/shutdown.ts
  - apps/cli/src/shutdown.test.ts
  - apps/cli/package.json
  - pnpm-lock.yaml
  - packages/host-node/src/hostOptions.ts
  - packages/host-node/src/createNodeHostInvoke.ts
  - packages/host-node/src/createNodeHostInvoke.test.ts
---

# 装配 server Web 与 CLI

## 目标

把统一 rollout driver 注入 server Web 与 CLI 的 agent core，并在执行前 reconcile；静态 Web 明确不配置文件 driver。

## 装配规则

- server Web：`serverAgentRolloutDriver` 通过 `agent_rollout_append/reconcile` host invoke 适配核心合同。
- `persistenceDrivers.ts` 的 server 分支返回 rollout driver；static 分支保持 IndexedDB 并令 rollout 为 absent。
- `main.tsx` 在 hydration 完成、agent 可执行前 await reconcile；warning 可报告但 source corruption 必须阻止执行。
- CLI：直接 `createNodeAgentRolloutDriver`，使用与 server 同一 app-data/DB 默认路径，启动后先 reconcile。
- Web/CLI 的 shutdown/close 边界 await `flush()`，不依赖进程自然退出碰运气。

## 验收标准

1. server driver 精确映射 target/mutation/result/warning，host error 不被转成成功。
2. server Web root 与 child 共用同一个 injected driver；registry 不重复创建 service。
3. CLI integration mock 证明 reconcile 先于 agent execution，shutdown 会 flush。
4. static driver 测试证明不调用 host rollout command，既有 IndexedDB recovery 不变。
5. `pnpm exec vitest run apps/web/src/persistence/serverAgentRolloutDriver.test.ts apps/web/src/persistence/persistenceDrivers.test.ts apps/cli/src/runtime.test.ts` → 通过。
6. `pnpm exec tsc -b`、`pnpm check:boundaries` → 通过；`main.tsx`/`runtime.ts` 若触线则先按 bootstrap 职责抽取并报告 owner。

## 禁止项

- 不在浏览器 fallback 到 workspace path 或 OPFS 冒充 node rollout。
- 不在本叶新增 history tool、UI、查询或 FTS。

## R1 修复门

- CLI 必须配置真实 recovery + `recoveryStore`，让 root capture 创建 RecoveryWriter；root/child 使用
  同一 rollout driver，同一默认 SQLite/app-data，不得只写 child。
- Web/CLI 对 `source` warning 阻断启动，对 `projection` warning 报告后继续；两支都要入口级反例测试。
- CLI 正常返回与信号退出都 await 同一个幂等 drain；不得仅在 signal 路径 flush。
- runtime 测试不得读取真实 home/app-data；通过显式依赖或临时绝对路径隔离，并在 afterEach reset/close。
- 测试必须观察 `reconcile → agent execution → flush` 顺序，不能只断言调用次数。

## R2 修复门

- `drain()` 正常路径必须等待全部 disposer 后传播单个/AggregateError；signal 路径无论 drain 成败都退出。
  drain 开始后禁止静默接受晚登记，重复 drain 返回同一 fulfilled/rejected 结果。
- CLI 只登记一个 ordered persistence disposer：`flushRecovery()` 完成后才 `agentRollout.flush()`；
  host routes 借用该 driver 时不得再登记第二个 rollout disposer，MCP disposer 保留。
- bootstrap 的 lifetime 从 assembly/reconcile 前开始；启动失败也 drain，且 drain 成功时保留原始启动错误。
- CLI assembly test 必须经过 `startModelRun` 或等价真实 execution fence，观察
  `reconcile → root append → model loop → ordered flush`。
