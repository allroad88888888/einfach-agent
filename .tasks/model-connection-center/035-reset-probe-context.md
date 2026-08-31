---
id: "035"
title: 清理探测编辑上下文
kind: leaf
parent: "200"
depends_on:
  - "030"
discovered_from: "030"
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/settings/modelConnectionProfileState.ts
  - apps/web/src/settings/modelConnectionProfileCommands.ts
  - apps/web/src/settings/modelConnectionProfileCommands.test.ts
  - apps/web/src/agentNew/ui/SettingsDialog.close.test.tsx
---

# 清理探测编辑上下文

## 目标

防止探测结果跨连接编辑器复用。

## 上下文

030 的独立审查发现 `modelConnectionProfileProbeStateAtom` 在打开 create/edit、取消或关闭编辑器时仍保留
上一个 profile 的 `/models` 结果。060 将渲染此状态，若不消除它，用户可能误把旧端点模型勾入新连接。
本卡只管理 probe 生命周期，不改模型保存、host probe、transport 或 UI。

`ModelConnectionProfileProbeState` 必须在以下时机精确回到 `{ status: 'idle' }`：

1. `openCreateModelConnectionProfileEditor()`；
2. `openEditModelConnectionProfileEditor(profile)`；
3. `closeModelConnectionProfileEditor()`，包括成功保存、删除、取消和 settings 关闭；
4. 通过 `updateModelConnectionProfileDraft()` 修改的 `baseUrl` 在 trim 后与旧值不同。

仅改 label、ID、models 或临时 Key 不得清除已经针对同一地址完成的 probe 结果。probe 自己开始时仍改为
`loading`，成功/失败行为不变。禁止由 UI 通过本地 state 规避：所有生命周期由现有 Einfach entry/commands
集中维护。

异步 probe 必须绑定开始时的内部代次。任何上列上下文失效操作均递增该代次；旧 Promise 后续
resolve/reject 时，只有代次仍相同才可把 loading 更新为 ready/error，否则静默丢弃。该代次不是 UI
可读的产品状态，不能进入 public profile、transport 或持久化。测试用可控 pending Promise 至少覆盖
baseUrl 切换和 create/edit/close 中一条上下文切换；`SettingsDialog.close.test.tsx` 必须从实际
`closeSettingsCenter()` 入口先建立 probe state，再断言它回到 idle。

## 接口

### 消费

- 030 的 `ModelConnectionProfileProbeState`、编辑器命令与 draft atom。

### 产出

- 上下文一致的 `modelConnectionProfileProbeStateAtom`：060 可安全渲染，不需自行比对旧连接。

## 验收标准

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileCommands.test.ts` → create、edit、close、
   成功 save/delete 与 base URL 改变均清 probe；非地址草稿改动不清 probe；原有 probe 成败覆盖继续通过。
2. `pnpm check:state && git diff --check` → 通过。
3. `wc -l apps/web/src/settings/modelConnectionProfileState.ts apps/web/src/settings/modelConnectionProfileCommands.ts apps/web/src/settings/modelConnectionProfileCommands.test.ts` → 每个不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-21：由 030 独立审查 Minor 发现创建并派发。
- 2026-08-21：R1 只修审查发现的异步回写与 settings close 覆盖：加入内部代次失效，补 pending
  probe 与真实 close 入口回归；不扩到其它 UI 行为。
- 2026-08-21：R1 独立复审通过；过期 probe 不再回写当前编辑上下文。
