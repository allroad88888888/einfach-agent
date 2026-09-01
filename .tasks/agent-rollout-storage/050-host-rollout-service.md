---
id: "050"
title: 组装 host service 与 command
kind: leaf
parent: "2000"
depends_on: ["030", "040"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 3
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/rollout/jsonlStore.ts
  - packages/host-node/src/rollout/jsonlStore.test.ts
  - packages/host-node/src/rollout/service.ts
  - packages/host-node/src/rollout/service.test.ts
  - packages/host-node/src/rollout/commands.ts
  - packages/host-node/src/rollout/commands.test.ts
  - packages/host-node/src/rollout/index.ts
  - packages/host-node/src/commandNames.ts
  - packages/host-node/src/createNodeHostInvoke.ts
  - packages/host-node/src/createNodeHostInvoke.test.ts
  - packages/host-node/src/index.ts
  - packages/host-node/src/hostOptions.ts
  - packages/host-node/src/rollout/projector.ts
  - packages/host-node/src/rollout/projector.test.ts
  - packages/host-node/src/rollout/sourcePreflight.ts
  - packages/host-node/src/rollout/sourcePreflight.test.ts
  - packages/agent-core/src/history/rolloutMutation.ts
---

# 组装 host service 与 command

## 目标

把 JSONL store 与 projector 组装成 node driver，并通过两个 host command 暴露给 server Web。

## 接口

- `createNodeAgentRolloutDriver(options): AgentRolloutDriver`。
- `agent_rollout_append`：输入逻辑 target + 有界 mutation batch，输出 assigned records 和 projection warning。
- `agent_rollout_reconcile`：扫描已知 rollout source 并追平投影，返回逐 history 进度/错误。
- driver `flush()` 只排空本进程 append/project queue，不偷偷 prune 或 rebuild 全库。

service 通过 store 的 prepared append 在同一 target 跨进程 lock 内先追平 projection，以投影状态过滤
五类相同 mutation；然后强写 JSONL，再投影。未知 item tombstone 必须保留；projection 追平失败时跳过
dedupe 但仍强写 source，并在结果返回 warning。
source 成功而 projection 失败时 append 返回成功加 warning；source 失败必须 reject。command 参数在
`rollout/commands.ts` 内严格收窄，不能继续扩张已 289 行的 `commandArgs.ts`。

## 验收标准

1. 重复提交相同 root backfill 不追加第二份等价 item record；实际 update 会追加新 record。
2. source 失败 command reject；projection 失败返回 warning，reconcile 后 warning 清除且 offset 追平。
3. 两个 command 在 node host registry 各注册一次，未知/超大输入在 I/O 前拒绝。
4. `pnpm exec vitest run packages/host-node/src/rollout/service.test.ts packages/host-node/src/rollout/commands.test.ts packages/host-node/src/createNodeHostInvoke.test.ts` → 通过。
5. `pnpm --filter @einfach-agent/host-node build`、`pnpm check:boundaries` → 通过。
6. service、command adapter、public exports 各守单一职责且不超过 300 行。

## 禁止项

- 不新增 list/read/search/delete command。
- 不吞 source write 错误，不让 HTTP 调用方传 raw filesystem path。

## R2 修复门

- reconcile 的逐 history warning 必须带机器可判定的 `source` / `projection` 分类；不能让 Web/CLI
  解析 message。codec、identity、ordinal、partial/oversized line 与 source I/O 属于 fatal source；
  SQLite/projector 写入故障属于可追平 projection。
- append 前追平若发现 source corruption 必须拒绝继续 append；仅 projection 故障可以跳过去重后强写 source。
- `createNodeHostInvoke` 接受可选的既有 rollout driver，CLI 直接 driver 与 host routes 注入同一实例，
  且只登记一次 flush disposer；server 默认装配仍自行创建唯一实例。

## R3 修复门

- source/projection operation wrapper 必须按当前执行边界强制重新分类，即使 cause 已携带相反品牌。
- hot append 不得每次从 byte 0 全扫永久 JSONL。每个 driver 对 source 首次/启动 reconcile 做全量验证，
  后续在 target lock 内用同一 file identity + validated byte offset/next ordinal 增量验证新增尾部；
  truncation、replacement 或 offset/identity 不一致必须在 write 前 fail-closed。跨进程合法 append 要只验证
  上次 offset 之后的 tail，而不是退回全扫。缓存失效时允许一次全量重建验证状态。
