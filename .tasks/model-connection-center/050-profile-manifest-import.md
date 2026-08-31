---
id: "050"
title: 解析非秘密连接清单
kind: leaf
parent: "200"
depends_on:
  - "010"
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/settings/modelConnectionProfileManifest.ts
  - apps/web/src/settings/modelConnectionProfileManifest.test.ts
---

# 解析非秘密连接清单

## 目标

把公开 JSON 清单转换为连接草稿。

## 上下文

用户希望能加开源社区的服务商配置，但不能把外部程序、API Key 或未验证脚本接进产品。本任务实现
浏览器内纯解析器，不发网络、不保存、不直接更新 atom；060 将其输出送给 030 的草稿命令。

只接受精确 manifest：

```ts
{
  "version": 1,
  "connection": {
    "label": "显示名称",
    "kind": "openai-compatible",
    "baseUrl": "https://example.com/v1",
    "models": [{ "id": "model-id", "label": "可选显示名" }]
  }
}
```

根、connection、model 的未知字段一律拒绝，特别是 `apiKey`、`token`、`headers`、`apiPath`、URL query
或任意 adapter 声明不得静默保留。`connection.id` 不在格式内，导入结果也不得指定它，避免覆盖已有
profile；060 让用户填写/生成本地唯一 ID。结果的 model 使用 `source: 'manual'`。解析器必须复用
`normalizeOpenAiCompatBaseUrl` 等价规则或在纯 web 中实现字面一致的无宿主依赖验证，绝不能放宽 host
安全边界。

导出：

```ts
export interface ImportedModelConnectionProfile {
  readonly label: string
  readonly baseUrl: string
  readonly models: readonly ConnectionProfileModel[]
}
export function parseModelConnectionProfileManifest(text: string): ImportedModelConnectionProfile
```

抛出的错误固定、面向用户且不得回显整个输入。最大文本、最大模型数和字段长度须有上限，防止页面
导入畸形大文件。

## 接口

### 消费

- `ConnectionProfileModel`：来自 010，导入输出的模型类型。

### 产出

- `parseModelConnectionProfileManifest(text)`：060 在用户选择 JSON 文件后消费；函数只解析，不改变
  任何 store。

## 验收标准

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileManifest.test.ts` → 合法最小清单、模型 label、重复 ID、未知字段、Key/headers、坏 URL、超限文本与无秘密输出全部覆盖并通过。
2. `git diff --check` → 通过。全 app 类型总门由 060 在全部消费方迁移后执行，见 index 裁决。

## 执行记录（仅编排者回写）

- 2026-08-21：执行完成，专属测试通过，等待独立审查；全 app 类型门按 index 裁决延至 060/070。
- 2026-08-21：独立审查通过；根级未知字段及 `connection.id` 可补专门回归 case 的 Minor 留至终审复核。
