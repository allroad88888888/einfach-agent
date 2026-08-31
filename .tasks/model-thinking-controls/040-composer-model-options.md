---
id: "040"
title: 生成模型下拉选项
kind: leaf
parent: "300"
depends_on:
  - "010"
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/composerModelOptions.ts
  - apps/web/src/agentNew/ui/composerModelOptions.test.ts
---

# 生成模型下拉选项

## 目标

把内置 catalog 与连接 profile 投影成模型选项。

## 上下文

现有 `ComposerModelPicker.tsx` 写死四条选项；连接中心已经在
`modelConnectionProfilesAtom` 提供一条 profile 下的多个 model。新增纯投影模块，不写 React 状态。

内置选项来自 010 registry 枚举，使用 descriptor displayName；profile 选项按 profile label 分组，设置
identity 固定为 `{ vendor:'openai-compat', model, vendorSettings:{ connectionId } }`。select key 必须对
冒号、斜线、Unicode 和同名模型无碰撞，不能靠解析 label/model 猜身份。当前会话若引用已删除或未枚举
的模型，保留一个“当前模型”选项，不能静默跳到第一项。

投影结果不得包含 Base URL、Key、credentialConfigured 的秘密派生信息；profile availability 只决定是否
列出 profile 选项。排序稳定，不能在每次 render 产生随机 key。

## 接口

### 消费

- 010 registry 模型枚举。
- `ModelConnectionProfile[]` 的公开 label/models/id。

### 产出

- `composerModelOptions(current, profiles)` 与稳定 key/lookup：050 消费。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/composerModelOptions.test.ts` → 内置全量、profile 多模型、同名隔离、特殊字符 key、缺失当前模型、稳定顺序全部通过。
2. 断言输出不含 baseUrl/apiKey，profile 模型保持 openai-compat + connectionId。
3. `pnpm exec tsc -b apps/web/tsconfig.json && git diff --check` → 通过。
4. 新模块与测试各自不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-21：执行者验收全部通过；独立审查 APPROVE，无 findings。
