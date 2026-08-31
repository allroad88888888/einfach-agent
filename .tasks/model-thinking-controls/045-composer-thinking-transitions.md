---
id: "045"
title: 归一模型 Thinking 变更
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
  - apps/web/src/agentNew/ui/composerModelSettings.ts
  - apps/web/src/agentNew/ui/composerModelSettings.test.ts
---

# 归一模型 Thinking 变更

## 目标

把模型控件动作转换成合法会话设置。

## 上下文

React 组件不应散写 opaque `vendorSettings`。新增纯转换模块，接收当前 `ModelSettings`、目标模型 identity
和 010 capability，产出传给 030 command 的完整新设置。

规则：

- 切到同 provider 且目标支持当前 effort 时保留；否则删除 `reasoning_effort`，但保留目标仍支持的其它
  vendorSettings（尤其 Kimi region 或 profile connectionId 由目标 identity 精确给出）。
- 跨 provider 不携带旧 provider 私有 bag；不得把 DeepSeek effort、Kimi region 或 connectionId 串家。
- toggle on/off 只改 `thinking`；off 可在会话设置保留合法 effort 供重新开启，020 保证不上行。
- 选择 Auto 删除 `reasoning_effort`；选择档位只接受 capability 列表；unsupported/unknown 不产生
  thinking 字段并清理 effort。
- 原输入不可变；空 vendorSettings 删除整个袋，不能持久化 `{}` 噪声。

## 接口

### 消费

- 010 的 capability 查询。
- core `ModelSettings` opaque bag 契约。

### 产出

- 切模型、切开关、切 effort 的纯函数：050 消费。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/composerModelSettings.test.ts` → DeepSeek/GLM/Kimi/profile/unsupported/unknown、Auto、off→on、跨厂商、不可变输入全部通过。
2. 测试钉住 profile connectionId 不丢、旧 connectionId 不串到内置模型、非法 effort 不进入结果。
3. `pnpm exec tsc -b apps/web/tsconfig.json && git diff --check` → 通过。
4. 新模块与测试各自不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-21：首轮独立审查 REJECT：同 vendor 无 target bag 会继承旧 profile connectionId；显式 target
  identity bag 又会丢仍合法 effort。已交原执行者做限定 R1。
- 2026-08-21：R1 独立复审 APPROVE；上轮 High/Medium 均闭合。
