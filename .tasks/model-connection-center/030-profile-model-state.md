---
id: "030"
title: 管理连接模型草稿
kind: leaf
parent: "200"
depends_on:
  - "010"
  - "020"
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/settings/modelConnectionProfileState.ts
  - apps/web/src/settings/modelConnectionProfileCommands.ts
  - apps/web/src/settings/modelConnectionProfileCommands.test.ts
  - apps/web/src/settings/defaultModelConnectionRuntime.ts
  - apps/web/src/settings/defaultModelConnectionCommands.test.ts
  - apps/web/src/modelTransport/openAiCompatRegistry.ts
  - apps/web/src/modelTransport/connectionProfileTransport.test.ts
---

# 管理连接模型草稿

## 目标

让 Einfach 草稿保存多模型编辑状态。

## 上下文

当前 `modelConnectionProfileState.ts` 的 `draft` 只有 `model: string`，
`modelConnectionProfileCommands.ts` 因而只能收集一个 model。010 将 host public/save 类型改为
`models: readonly ConnectionProfileModel[]`，020 提供 `activeHost.probe()`；本任务把浏览器控制面
切换到该契约，但不写任何 React UI。

同一个 `modelConnectionProfileEntryAtom` 继续拥有 profile、编辑模式、密码草稿和状态。将草稿换成
`models: readonly ConnectionProfileModel[]`，再新增独立的 probe 子状态：

```ts
type ModelConnectionProfileProbeState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; models: readonly ConnectionProfileModel[] }
  | { status: 'error'; error: string }
```

密码仍是仅内存、写入式值。保存、取消、删除和 settings dialog close 都必须清空它。增加精确命令：

```ts
probeModelConnectionProfile(): Promise<boolean>
addManualModelConnectionProfileModel(id: string): void
removeModelConnectionProfileModel(id: string): void
replaceModelConnectionProfileModels(models: readonly ConnectionProfileModel[]): void
```

probe 只用当前草稿的 `baseUrl` 和**当前临时** `apiKey`；成功结果先进入 probe state，不能自动覆盖
用户已选模型，UI 在 060 决定勾选哪些。保存至少要求一个模型。编辑旧 profile 时，模型草稿完整复制。

`replaceOpenAiCompatConnections` 仍只收 `{ id, kind, baseUrl }`，不得把模型、Key 或 probe 输出送入
transport。`synchronizeDefaultModelConnectionRuntime` 必须只在默认 `(connectionId, model)` 仍位于该
profile 的 models 列表中时映射运行时默认；缺失模型要安全回退且不改持久化偏好。

## 接口

### 消费

- `ModelConnectionProfileHost.probe(input)`：来自 020；只经命令层调用。
- `ModelConnectionProfile.models`、`ModelConnectionProfileSaveInput.models`：来自 010。

### 产出

- `modelConnectionProfileProbeStateAtom` 与四个模型草稿命令：060 消费。
- 多模型默认运行时校验：070 以缺失/删除模型验证。

## 验收标准

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/settings/defaultModelConnectionCommands.test.ts apps/web/src/modelTransport/connectionProfileTransport.test.ts` → probe 成败、手动增删、保存至少一项、密码清理、transport 不含模型/Key、默认缺失安全回退全部通过。
2. `pnpm check:state` → 不引入框架本地业务状态。全仓类型总门由 060 在所有 UI 消费方迁移后执行。
3. `git diff --check` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：010、020 已完成，已派发执行。
- 2026-08-21：执行完成，定向状态/transport 测试通过，等待独立审查。
- 2026-08-21：R1 只修模型 ID trim 后为空仍可通过 valid/save 的 Important，并添加回归测试；上次
  审查的 probe 状态跨编辑器残留是 Minor，留至终审。
- 2026-08-21：R1 独立复审通过；probe 残留已拆入 035，避免本任务再扩范围。
