---
id: 020
title: workspace 读写使用同一 content hash 原语
kind: leaf
parent: 000
depends_on: [016]
discovered_from: 016
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: c804cd4
files:
  - packages/host-node/src/workspace/common/contentHash.ts
  - packages/host-node/src/workspace/common/contentHash.test.ts
  - packages/host-node/src/workspace/change/contentHash.ts
  - packages/host-node/src/workspace/change/contentHash.test.ts
  - packages/host-node/src/workspace/read/content.ts
  - packages/host-node/src/workspace/read/content.test.ts
  - packages/host-node/src/workspace/read/bytesRead.ts
  - packages/host-node/src/workspace/read/bytesRead.test.ts
  - packages/host-node/src/workspace/read/linesRead.ts
  - packages/host-node/src/workspace/read/linesRead.test.ts
  - packages/host-node/src/workspace/write/guard.ts
  - packages/host-node/src/workspace/write/guard.test.ts
  - packages/host-node/src/workspace/patch/guard.ts
  - packages/host-node/src/workspace/patch/guard.test.ts
---

# workspace 读写使用同一 content hash 原语

## 目标
建立唯一的字节级 workspace content hash owner，让 read 产出的 hash 与 write/patch 的 expected hash 校验通过同一实现和格式判据。

## 交付边界
hash 计算、格式校验、read 产出与 mutation 消费属于同一乐观并发协议，必须一起迁移。UTF-8 字符串调用方显式编码为字节；不得保留 change/read 两份算法或只用测试对拍维持副本。

## 上下文
`workspace/change/contentHash.ts` 接收 string，`workspace/read/content.ts` 接收 bytes；两者都实现 `sha256:<64 lowercase hex>`。共享 owner 应位于精确命名的 `workspace/common/contentHash.ts`，不是新增大杂烩。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- 现有 `CONTENT_HASH_FORMAT_ERROR` 与 `hasValidContentHashFormat(value)` 行为。
- read 路径已有 `Uint8Array`；write/patch 当前字符串必须按 UTF-8 编码后计算。
### 产出
- `contentSha256(bytes: Uint8Array): string` 位于 `workspace/common/contentHash.ts`，为唯一 SHA-256 实现；格式 predicate 与错误常量同属该协议模块。

## 验收标准
1. `rg -n "function contentSha256" packages/host-node/src/workspace` → 只有共享 owner 一处；其它不同格式/用途的 SHA-256 协议不在本任务范围。
2. read、write、patch 均直接消费共享 owner；不存在 change/read 兼容文件内的第二实现。
3. 公共测试覆盖空串、ASCII、多字节 UTF-8、严格格式；handler/guard/read 既有测试证明行为不变。
4. `pnpm exec vitest run packages/host-node/src/workspace/common/contentHash.test.ts packages/host-node/src/workspace/read/content.test.ts packages/host-node/src/workspace/read/bytesRead.test.ts packages/host-node/src/workspace/read/linesRead.test.ts packages/host-node/src/workspace/write/guard.test.ts packages/host-node/src/workspace/patch/guard.test.ts` → 全部通过；所有文件 ≤300 行。

## 执行记录（仅编排者回写）
- 2026-09-03：并行派发实现。
- 裁决: 唯一 owner 验收改查 `contentSha256` 定义数，不查所有 `createHash('sha256')` — workspace 内另有 journal fingerprint、path fingerprint、run-index cursor 等不同格式和信任边界的 SHA-256 协议 — 若用宽泛命令，会把不应合并的不同抽象误判为重复。
- 2026-09-03：实现 DONE_WITH_CONCERNS、独立审查 APPROVED；编排者复跑指定 6 files / 79 tests，并确认唯一函数定义。review 的两处陈旧说明为 Minor，按任务树规则记账不返工。
