---
id: "010"
title: 迁移多模型连接存储
kind: leaf
parent: "100"
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/host-node/src/model/connectionProfile.ts
  - packages/host-node/src/model/connectionProfileSection.ts
  - packages/host-node/src/model/connectionProfileTransaction.ts
  - packages/host-node/src/model/connectionProfileCommands.ts
  - packages/host-node/src/model/connectionProfileValidation.test.ts
  - packages/host-node/src/model/connectionProfileTransaction.test.ts
  - packages/host-node/src/model/connectionProfileCommands.test.ts
  - packages/host-node/src/model/connectionProfileForward.test.ts
  - packages/host-node/src/model/connectionProfileForwardBinding.test.ts
  - packages/host-node/src/model/connectionProfileCommandArgs.ts
  - apps/web/src/settings/modelConnectionProfileHost.ts
  - apps/web/src/settings/serverModelConnectionProfileHost.ts
  - apps/web/src/settings/serverModelConnectionProfileHost.test.ts
---

# 迁移多模型连接存储

## 目标

使一个已登记连接持久化多个模型。

## 上下文

当前 host 的 `StoredConnectionProfile` 位于
`packages/host-node/src/model/connectionProfile.ts`，固定存储 `{ id, label, kind, baseUrl, model }`；
web 的同名公开类型与 `ModelConnectionProfileSaveInput` 在
`apps/web/src/settings/modelConnectionProfileHost.ts` 中镜像这个单模型形状。事务
`connectionProfileTransaction.ts` 已保证 profile 元数据和 Key 在同一 `updateSections` 快照写入；
这条原子性必须保留。

新增精确形状：

```ts
export interface ConnectionProfileModel {
  readonly id: string
  readonly label: string
  readonly source: 'manual' | 'discovered'
}
export interface StoredConnectionProfile {
  readonly id: string
  readonly label: string
  readonly kind: 'openai-compatible'
  readonly baseUrl: string
  readonly models: readonly ConnectionProfileModel[]
}
```

`models` 非空；模型 ID 沿用当前 `model` 的长度与控制字符保护，`label` 使用受限文本并可等于 ID；
模型 ID 在同 profile 内去重、顺序稳定。公开 profile 仅额外加 `credentialConfigured`。
不得给 profile、模型、save input 或 config 增加 `vendor`、`adapter`、`headers`、`apiPath`、
`reasoning_effort` 等可改变官方 adapter 身份的字段；015 证明这种隔离，030–060 只消费该安全形状。

历史 config 记录精确迁移规则：读到旧的 `{ ..., model: string }` 时，在内存中变为
`models: [{ id: model, label: model, source: 'manual' }]`；下一次成功 save 才以新形状写回。读新旧记录
都必须完整校验，坏记录仍以 `invalidConfigFormat` fail closed。旧 session 的
`settings.model` 本来就是字符串，转发不需要更改，必须用现有 forward 测试证明。

Host save 命令仍为 `model_connection_profile_save`，输入改为：

```ts
{ input: { id, label, baseUrl, models, apiKey?: string } }
```

list/read/save 公开响应使用带 `models` 的 `ModelConnectionProfile`；Key 的写入式和 omit-key 语义不变。

## 接口

### 消费

- `connectionProfileCredentialKey(id)`：既有 key 命名空间，来自本文件；020 与转发链继续按连接而非模型
  取 Key。
- `ModelConnectionProfileHost`：030 通过该 web contract 管理多模型草稿。

### 产出

- `ConnectionProfileModel`、`StoredConnectionProfile.models`、`ModelConnectionProfile.models`：020、030、
  040、050、060 消费。
- `ModelConnectionProfileSaveInput.models`：030 调用；保存参数不得再含 `model`。
- 兼容的 `decodeConnectionProfiles(section)`：070 用迁移 fixture 验收。

## 验收标准

1. `pnpm exec vitest run packages/host-node/src/model/connectionProfileValidation.test.ts packages/host-node/src/model/connectionProfileTransaction.test.ts packages/host-node/src/model/connectionProfileCommands.test.ts packages/host-node/src/model/connectionProfileForward.test.ts packages/host-node/src/model/connectionProfileForwardBinding.test.ts` → 新旧记录、原子保存、删除、同 URL profile 隔离与旧会话转发全部通过。
2. `pnpm exec vitest run apps/web/src/settings/serverModelConnectionProfileHost.test.ts` → web host 只接收/返回公开多模型形状，响应和测试快照均无 API Key。
3. `pnpm --filter @einfach-agent/host-node build && git diff --check` → 全部通过。全仓 `tsc -b` 为 030、
   060 消费端迁移后的总门，见 index 的裁决记录。

## 执行记录（仅编排者回写）

- 2026-08-21：R1 只修独立审查的 Important：将静态 `ConnectionProfileCommandArgs` 的 save input
  迁移为 `models`，移除旧 `model`；更新报告并复跑本任务聚焦命令。
- 2026-08-21：R1 独立复审通过；静态参数契约已与运行时 handler 对齐。
