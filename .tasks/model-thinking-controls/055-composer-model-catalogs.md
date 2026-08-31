---
id: "055"
title: 更新模型控件翻译目录
kind: leaf
parent: "400"
depends_on:
  - "050"
discovered_from: null
model: gpt-5.6-luna
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/i18n/locales/en/messages.po
  - apps/web/src/i18n/locales/zh-CN/messages.po
---

# 更新模型控件翻译目录

## 目标

让模型控件文案具备完整中英文目录。

## 上下文

050 新增模型分组、Thinking 状态、档位提示、能力未知与运行中禁用等文案。仅运行 Lingui 提取/编译并
补自然英文 `msgstr`；模型名、Auto/Low/Medium/High/XHigh/Max 保持产品术语，不翻译成不一致别名。

不得修改组件源码、Lingui 配置或其它历史 msgid，不以清空/重排整份目录掩盖差异。PO 属生成/i18n
资源，行数规则例外。

## 接口

### 消费

- 050 的 Lingui macro 文案。

### 产出

- 完整中英文 catalog，060 与 UI 截图消费。

## 验收标准

1. `pnpm lingui:extract --clean && pnpm lingui:compile && pnpm exec lingui status` → English Missing 0。
2. `pnpm exec vitest run apps/web/src/agentNew/ui/i18nConversation.test.tsx` → 中英文激活与模型控件文案通过。
3. `git diff --check` → 通过；diff 只包含本功能相关 catalog 条目。

## 执行记录（仅编排者回写）

- 2026-08-21：执行时确认任务原写的 `apps/web/src/locales/` 不存在；按 Lingui 配置与实际提取输出将
  files 更正为 `apps/web/src/i18n/locales/`。CLI 无 `lingui status` 子命令，以 extract 的 Missing 0 为准。
- 2026-08-21：独立审查 APPROVE，无 findings。
