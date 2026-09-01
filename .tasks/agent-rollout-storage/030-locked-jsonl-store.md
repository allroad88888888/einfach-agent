---
id: "030"
title: 实现带锁的 JSONL 主记录
kind: leaf
parent: "2000"
depends_on: ["010", "020"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 2
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/rollout/rolloutPath.ts
  - packages/host-node/src/rollout/rolloutPath.test.ts
  - packages/host-node/src/rollout/rolloutLock.ts
  - packages/host-node/src/rollout/rolloutLock.test.ts
  - packages/host-node/src/rollout/jsonlStore.ts
  - packages/host-node/src/rollout/jsonlStore.test.ts
---

# 实现带锁的 JSONL 主记录

## 目标

实现逻辑 target 到安全文件路径的映射，以及跨进程互斥、整批追加、`fsync` 的 JSONL source store。

## 上下文

server 与 CLI 可能同时写同一 history，单进程 Promise queue 不够。可参考
`scripts/subagent-archive-lock.js` 的 PID/token/stale/heartbeat 协议，但 runtime 不能 import scripts。

## 物理布局

```text
<app-data>/rollouts/conversations/<conversationKey>/root.jsonl
<app-data>/rollouts/conversations/<conversationKey>/runs/<runKey>/agents/<agentKey>.jsonl
```

所有 key 由逻辑 id 的规范化摘要生成，manifest/record 保留原 id；调用方不能提供 raw path。路径映射必须
确定、跨平台合法并抗 `..`、分隔符、保留设备名和超长 segment。

## 写入协议

1. 获取 history 专属跨进程 lock；存活 PID 不因 mtime 过期被抢，malformed/dead owner 才可恢复。
2. 在锁内用最大单行尺寸约束的 tail read 读取最后一条完整 record，校验/取得下一 ordinal；不得读整文件。
3. 为整批 mutation 分配连续 ordinal，编码为完整带换行 buffer，只执行一次 append。
4. `FileHandle.sync()` 成功后才释放锁并返回；失败不报告成功。
5. `flush()` 等待本进程所有队列并传播其覆盖的 append 失败，包括调用 flush 前已经 settled 的失败。
   单 record、单 batch 和 lock wait 都必须有显式上限。

## 验收标准

1. 两个独立进程并发追加同 target，结果无半行、覆盖、重号，ordinal 连续。
2. 不同 target 可并行，不共享全局锁；同 target 的批次内部不交错。
3. stale lock 可恢复，活跃 lock 不被抢；非 owner 不能释放别人的 lock。
4. append/fsync/编码失败均抛出，已有完整行保持可读；尾部半行得到明确 corruption 错误。
5. `pnpm exec vitest run packages/host-node/src/rollout/rolloutPath.test.ts packages/host-node/src/rollout/rolloutLock.test.ts packages/host-node/src/rollout/jsonlStore.test.ts` → 通过。
6. 新实现文件各不超过 300 行；锁、路径、I/O 不合并成一个 engine 文件。

## 禁止项

- 不读取 SQLite，不做 projection 或 search。
- 不 compact、truncate 或重写已有 rollout。
