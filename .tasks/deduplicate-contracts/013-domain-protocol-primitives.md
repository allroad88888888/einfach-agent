---
id: 013
title: 剩余机械协议副本由各领域小模块接管
kind: leaf
parent: 000
depends_on: [001, 003, 005, 006, 007, 008, 009, 011, 012]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-03
done: 2026-09-03
base: 82431a4
files:
  - apps/server/src/
  - packages/observability-idb/src/
  - packages/persistence-idb/src/
  - tools/fs/src/
  - packages/host-node/src/workspace/
  - packages/host-node/src/shell/
  - packages/agent-core/src/tools/
  - packages/agent-core/src/runtime/toolLoopSupport.ts
  - packages/agent-core/src/runtime/modelTurn.test.ts
  - packages/agent-core/src/subagents/childAgentToolCalls.ts
  - packages/agent-core/src/subagents/childResult.ts
  - packages/agent-core/src/subagents/types.ts
  - packages/agent-core/src/state/
---

# 剩余机械协议副本由各领域小模块接管

## 目标
在一个机械去重提交中，为原审查第 13 项的每类重复建立各自领域 owner，同时保持所有外部行为不变。

## 交付边界
这是用户要求按原编号形成单个 commit 的同型机械批次，必须完成以下全部子项：server bounded JSON reader、observability IDB schema/open、persistence IDB transaction、FS workspace result compatibility、host `pathExists`、ToolResult 模型序列化、ModelSettings 字段 schema。每类放在自己的领域模块，禁止共享成跨包工具桶。

## 上下文
- server：`invokeRouteBody.ts` 与 `modelRouteBody.ts` 复制 request data/end/error 收集器。
- observability-idb：reader/writer 复制 DB name/version/store/upgrade/open。
- persistence-idb：history/recovery drivers 复制 transaction wrapper。
- tools/fs：list/read/search/find-test-lint 重复识别 workspace result envelope。
- host-node：已有 `workspace/change/pathProbe.ts`，但 workspace/shell 多处仍有私有 `pathExists`。
- agent-core：root/child/timed child 重复序列化 `ToolResult`；`ModelSettings` 字段在类型、迁移和 recovery codec 三处维护。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- 各包当前公开协议和测试。
### 产出
- 七个领域内窄模块；每个模块一句话只能描述一个抽象，不跨包制造泛型 utils。

## 验收标准
1. 各受影响包的定向测试全部通过，至少包含两种 server body route、两个 IDB 包、tools/fs、host workspace/shell、agent-core tool/state。
2. 新增共享原语分别有契约测试；原 public API 与错误语义保持兼容。
3. `rg` 证明七类目标副本已移除，或对仍保留的信任边界 wrapper 有注释和测试说明。
4. `pnpm build` 与 `pnpm test` → 全部通过。
5. 所有新增和大改普通文件 `wc -l` 不超过 300；不把存量超限文件继续推高。

## 执行记录（仅编排者回写）
- 2026-09-03：任务建立，等待所有前置任务。
- 2026-09-03：全部前置任务完成，派发执行 agent，base `82431a4`。
- 2026-09-03：全量测试暴露 manifest registry 已超过旧单页上限断言；纳入 `runtime/modelTurn.test.ts`，只修为分页完整性验收。该文件存量 872 行，本次小改不做范围外拆分。
- 2026-09-03：执行 DONE_WITH_CONCERNS（仅记录并发 timeout 抖动与存量超限测试）；独立 reviewer APPROVED。
- 2026-09-03：编排者复跑 19 个关键文件、164 tests 通过；准予提交。
