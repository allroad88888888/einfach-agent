---
id: "100"
title: 编译设置 catalog
kind: leaf
parent: "200"
depends_on: ["070", "080", "090"]
discovered_from: null
model: gpt-5.6-terra
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/i18n/locales/**
---

# 编译设置 catalog

## 目标

为设置面生成英文 catalog。

## 上下文

070–090 完成后，本任务保留既有翻译并给新设置 UI message 填入自然英文。PO/compiled JS 为本波唯一共享写入面；
不改源码或测试。

## 接口

### 消费

- 070–090 的 Lingui message。

### 产出

- English Missing 为 0 的 compiled settings catalog，供 110 使用。

## 验收标准

1. `pnpm lingui:extract --clean && pnpm lingui:compile && pnpm exec lingui status` → 通过且 English Missing 为 0。
2. `git diff --check -- apps/web/src/i18n/locales` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：070、080、090 已经独立审查通过，设置 catalog 收口已派发。
- 2026-08-21：179 条设置 message 已翻译，English 325/325，进入独立审查。
- 2026-08-21：审查发现可见工具计数按错误变量决定单复数；原执行者进入 R1 修补 ICU。
- 2026-08-21：R1 经独立审查 PASS；English 325/325、计数 runtime 和 PO/JS 一致性均通过。
