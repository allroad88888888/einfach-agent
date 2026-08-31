---
id: "050"
title: 编译对话 catalog
kind: leaf
parent: "100"
depends_on: ["010", "020", "030", "040"]
discovered_from: null
model: gpt-5.6-terra
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/i18n/locales/**
---

# 编译对话 catalog

## 目标

为对话主线生成英文 catalog。

## 上下文

010–040 已把所有聊天静态文案改成 macro。PO 与编译 JS 为共享生成物，本任务是聊天波次唯一可写
`apps/web/src/i18n/locales/**` 的 leaf。保留既有 20 条已审校翻译；只补本波新提取的 message。

## 接口

### 消费

- 010–040 的 `Trans`/`t` message。

### 产出

- `en/messages.po` 每条聊天 UI message 都有自然英文 `msgstr`；`zh-CN` 仍显示原中文；compiled catalog 供 060 使用。

## 验收标准

1. `pnpm lingui:extract --clean && pnpm lingui:compile` → 通过。
2. `pnpm exec lingui status` → English Missing 为 0。
3. `git diff --check -- apps/web/src/i18n/locales` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：010、020、030、040 已完成独立审查，catalog 收口已派发。
- 2026-08-21：提取、翻译与编译完成，English catalog 146/146，进入独立审查。
- 2026-08-21：审查发现 5 条 count=1 的英文单数不自然；原执行者进入 R1 修补 ICU plural。
- 2026-08-21：R1 通过独立复审；English catalog 146/146 且 count=1/other 译文自然。
