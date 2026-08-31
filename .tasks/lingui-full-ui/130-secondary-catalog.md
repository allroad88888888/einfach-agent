---
id: "130"
title: 编译次级 catalog
kind: leaf
parent: "300"
depends_on: ["120"]
discovered_from: null
model: gpt-5.6-terra
status: merged_into_150
created: 2026-08-21
done: null
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/i18n/locales/**
---

# 编译次级 catalog

## 目标

为次级时间线生成英文 catalog。

## 上下文

120 的源码消息在本 leaf 唯一写 PO/compiled JS。保留先前翻译，英文只覆盖静态 UI 文案，不翻译 payload。

## 接口

### 消费

- 120 新增 message。

### 产出

- English Missing 为 0 的最终 catalog，供 140 审计。

## 验收标准

1. `pnpm lingui:extract --clean && pnpm lingui:compile && pnpm exec lingui status` → 通过且 English Missing 为 0。
2. `git diff --check -- apps/web/src/i18n/locales` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：合并到 150 最终双语交付，避免继续细分。
