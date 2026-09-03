---
id: 002
title: CLI 与宿主执行同一模型凭据和端点安全规则
kind: leaf
parent: 000
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: 55a3d2e
files:
  - apps/cli/src/credentials.ts
  - apps/cli/src/credentials.test.ts
  - apps/cli/src/runtime.ts
  - apps/cli/src/runtime.test.ts
  - packages/host-node/src/model/
  - packages/host-node/src/index.ts
---

# CLI 与宿主执行同一模型凭据和端点安全规则

## 目标
CLI 从环境和 `~/.webAgent/config.json` 装配模型配置时，复用 host-node 的凭据键、section codec 和 openai-compatible base URL 安全判据。

## 交付边界
凭据键、配置段验证、base URL 归一化以及 CLI 回归测试必须一同交付，否则仍会保留两个 owner。CLI 的环境变量优先级和无文件快速路径保持不变。

## 上下文
- CLI 当前在 `apps/cli/src/credentials.ts` 手写 provider/env/config key 映射，只 trim 值。
- host 正式规则位于 `packages/host-node/src/model/credentials.ts`、`credentialSection.ts`、`openAiCompatBaseUrl.ts`、`openAiCompatEndpoint.ts`。
- CLI 已依赖 host-node；应导出窄的只读契约，不复制实现。
- 非回环 HTTP、URL credentials、query、fragment 必须 fail closed，错误不得泄露 API key。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `normalizeOpenAiCompatBaseUrl(value: string): string | undefined`。
- host-node credential section/key binding 的现有语义。
### 产出
- CLI 可消费的公开只读模型配置 codec/key binding；不暴露可变内部状态。

## 验收标准
1. `pnpm vitest run apps/cli/src/credentials.test.ts apps/cli/src/runtime.test.ts packages/host-node/src/model/openAiCompatBaseUrl.test.ts packages/host-node/src/model/credentialSection.test.ts` → 全部通过。
2. CLI 测试证明远程 HTTP、带 credentials/query/fragment 的 URL 被拒，HTTPS 与回环 HTTP 被归一化接受。
3. CLI 与 host 对超长 key、空白 key、配置段非字符串成员得出相同结果；环境变量仍优先于配置文件。
4. `pnpm exec tsc -b apps/cli/tsconfig.json packages/host-node/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：派发执行 agent，base `55a3d2e`。
- 2026-09-03：执行 DONE；独立 reviewer APPROVED。
- 2026-09-03：编排者复跑 credentials、base URL、credential section 测试，共 51 tests 通过；准予提交。
