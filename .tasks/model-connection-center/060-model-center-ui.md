---
id: "060"
title: 呈现多模型连接中心
kind: leaf
parent: "300"
depends_on:
  - "035"
  - "040"
  - "050"
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/ModelConnectionProfileSettings.tsx
  - apps/web/src/agentNew/ui/ModelConnectionProfilesPanel.tsx
  - apps/web/src/agentNew/ui/ModelConnectionProfilesPanel.test.tsx
  - apps/web/src/agentNew/ui/ModelConnectionProfileEditor.tsx
  - apps/web/src/agentNew/ui/ModelConnectionProfileEditor.test.tsx
  - apps/web/src/agentNew/ui/ModelConnectionSourcePicker.tsx
  - apps/web/src/agentNew/ui/ModelConnectionSourcePicker.test.tsx
  - apps/web/src/agentNew/ui/ModelConnectionModelPicker.tsx
  - apps/web/src/agentNew/ui/ModelConnectionModelPicker.test.tsx
  - apps/web/src/agentNew/ui/ModelCredentialPanel.connections.test.tsx
  - apps/web/src/agentNew/ui/agentnew.model-connections.css
---

# 呈现多模型连接中心

## 目标

让用户从连接中选择多个模型。

## 上下文

现有 `ModelConnectionProfileEditor.tsx` 要求用户一次填写单个模型 ID；
`ModelConnectionProfilesPanel.tsx` 也只展示 `profile.model`。030 后草稿有多模型/probe 状态，040 提供
来源预设，050 提供安全的导入解析器。此任务只组装 UI 和会话行为，不修改 host、transport 或设置状态。

UI 使用现有原生 `<details>` 折叠语言，拆成职责明确的组件：

- `ModelConnectionSourcePicker.tsx` 只显示「云端服务商 / 自部署 / 本地 / 导入 JSON」来源；选择预设
  把 label、baseUrl、models 写进 030 草稿，不设 Key。
- `ModelConnectionProfileEditor.tsx` 只编辑连接字段和写入式 Key，提供「测试并发现模型」动作；不能把
  Key 显示到卡片、文本、状态或 DOM 默认值之外。
- `ModelConnectionModelPicker.tsx` 只显示 probe 结果、当前已选模型和手动模型输入；用户勾选/移除或
  手动加入，模型才属于草稿。
- `ModelConnectionProfilesPanel.tsx` 只展示已保存连接卡；每张卡按连接显示来源/协议/Key 配置状态，并
  在卡内列出模型。每个模型拥有“用此模型新建对话”“设为新对话默认”；不能把 profile 的第一个模型
  暗中当默认。

`ModelConnectionProfileSettings.tsx` 是绑定层：调用 030 命令和 040/050 纯接口，以
`{ vendor: 'openai-compat', model, vendorSettings: { connectionId } }` 新建会话，并把默认保存为
`{ id: connectionId, model }`。导入 JSON 是本地 FileReader 文本解析，失败停留在编辑器并显示通用错误；
成功仅预填草稿，仍须由用户提供 ID、Key 并保存。禁止 `useState` 保存产品状态。

静态部署继续完全隐藏连接中心；官方/legacy 折叠区保留其既有行为。视觉上明确标出“官方直连”与
“第三方 / OpenAI 兼容”，避免把第三方 DeepSeek 标成官方。

## 接口

### 消费

- 030 的多模型 atoms/命令及 probe 状态。
- 040 的 `modelConnectionPresets()`。
- 050 的 `parseModelConnectionProfileManifest(text)`。

### 产出

- 用户可选择的 `{ connectionId, model }` 会话/默认行为：070 端到端断言消费。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/ModelConnectionProfileEditor.test.tsx apps/web/src/agentNew/ui/ModelConnectionProfilesPanel.test.tsx apps/web/src/agentNew/ui/ModelConnectionSourcePicker.test.tsx apps/web/src/agentNew/ui/ModelConnectionModelPicker.test.tsx apps/web/src/agentNew/ui/ModelCredentialPanel.connections.test.tsx` → 来源预填、probe 显示、手动加入、多个模型、ID-only 会话、新默认、导入不含 Key、static 隐藏及官方/第三方文案全部通过。
2. `pnpm check:state && pnpm exec tsc -b` → 状态约束通过，且所有 host/state/UI 消费方迁移后全仓类型通过。
3. `wc -l` 检查本任务新增/大改普通源文件 → 每个不超过 300 行；`git diff --check` → 通过。

## 执行记录（仅编排者回写）

- 2026-08-21：035、040、050 已完成，已派发执行。
- 2026-08-21：执行完成，五个 UI 测试文件和 state check 通过；全仓 tsc 被三处范围外旧测试夹具
  阻断，等待独立审查。
- 2026-08-21：首轮审查未发现 UI 范围 Important 产品缺陷，但全仓 tsc 未闭合；等待 065 迁移范围外
  fixture 后由原执行者 R1 复跑总门。FileReader 绑定路径和视觉证据为 Minor，留至 070。
- 2026-08-21：065 已完成，R1 只复跑本卡五组 UI、state 和全仓 tsc 验收；不修改产品范围。
- 2026-08-21：R1 独立复审通过；全仓类型总门闭合。FileReader 绑定路径和视觉证据仍由 070 终审。
