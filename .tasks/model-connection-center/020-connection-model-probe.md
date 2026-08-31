---
id: "020"
title: 探测兼容端点模型
kind: leaf
parent: "100"
depends_on:
  - "010"
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/host-node/src/model/connectionProfileProbe.ts
  - packages/host-node/src/model/connectionProfileProbe.test.ts
  - packages/host-node/src/model/connectionProfileCommands.ts
  - packages/host-node/src/model/connectionProfileCommands.test.ts
  - packages/host-node/src/model/index.ts
  - packages/host-node/src/commandNames.ts
  - packages/host-node/src/commandNames.test.ts
  - packages/host-node/src/commandArgs.ts
  - packages/host-node/src/createNodeHostInvoke.ts
  - packages/host-node/src/createNodeHostInvoke.test.ts
  - apps/web/src/settings/modelConnectionProfileHost.ts
  - apps/web/src/settings/serverModelConnectionProfileHost.ts
  - apps/web/src/settings/serverModelConnectionProfileHost.test.ts
---

# 探测兼容端点模型

## 目标

从受限兼容端点读取模型清单。

## 上下文

010 后 profile 的 `models` 为列表。当前 config 和 forward 链已经通过
`requireOpenAiCompatBaseUrl` 校验第三方地址，并用 host 内的 Key 发上游请求；此任务只增加一个不会写
配置的 probe，供新建/编辑前发现 `/models` 的模型 ID。

新增 node command 名 `model_connection_profile_probe`，严格接受：

```ts
{ input: { baseUrl: string, apiKey?: string } }
```

它必须先调用 `requireOpenAiCompatBaseUrl`，随后唯一请求
`GET ${normalizedBaseUrl}/models`。若 `apiKey` 给出，先以既有 `normalizeApiKey` 校验并只把它写入此
请求的 `Authorization: Bearer`；不给 Key 时不读取、猜测或返回已存 Key。实现注入 fetch、超时和有限
响应 body，测试绝不联网。

成功值为：

```ts
interface ModelConnectionProfileProbeResult {
  readonly models: readonly ConnectionProfileModel[]
}
```

只接受标准 OpenAI `{ data: [{ id: string }] }`，受限为非空、无控制字符、去重排序的 ID，转换为
`{ id, label: id, source: 'discovered' }`。畸形、超大、非 2xx、网络或认证失败必须受控报错；不得把
上游 body、URL 中的潜在秘密或 Key 拼进错误信息。probe 不得写 `modelConnections` 或 credential section。

web 的 `ModelConnectionProfileHost` 增加：

```ts
probe(input: { baseUrl: string; apiKey?: string }): Promise<ModelConnectionProfileProbeResult>
```

static host 一律拒绝，server adapter 只调用新 host command。

## 接口

### 消费

- `ConnectionProfileModel`：来自 010，用作 probe 唯一公开输出。
- `requireOpenAiCompatBaseUrl`、`normalizeApiKey`：现有 host 边界，不复制验证规则。

### 产出

- `ModelConnectionProfileHost.probe(input)`：030 的 `probeModelConnectionProfile` 消费。
- `model_connection_profile_probe`：仅 server host adapter 调用，060 不得直接构造 host command。

## 验收标准

1. `pnpm exec vitest run packages/host-node/src/model/connectionProfileProbe.test.ts packages/host-node/src/model/connectionProfileCommands.test.ts packages/host-node/src/commandNames.test.ts packages/host-node/src/createNodeHostInvoke.test.ts` → 精确 `/models`、规范化/去重、无写入、拒绝异常 URL/响应及无 Key 泄漏全部通过。
2. `pnpm exec vitest run apps/web/src/settings/serverModelConnectionProfileHost.test.ts` → server adapter 的 probe request/response 窄化通过；static adapter 不可探测。
3. `pnpm --filter @einfach-agent/host-node build && git diff --check` → 全部通过。全仓 `tsc -b` 为 060、
   070 的消费端迁移总门，见 index 的裁决记录。

## 执行记录（仅编排者回写）

- 2026-08-21：010 已完成，已派发执行。
- 2026-08-21：执行完成，新增 probe 已同步 `NodeHostCommandArgs`；聚焦验证通过，等待独立审查。
- 2026-08-21：独立审查通过；3xx 与模型数量/ID 长度边界的独立 test case 为 Minor，留至终审。
