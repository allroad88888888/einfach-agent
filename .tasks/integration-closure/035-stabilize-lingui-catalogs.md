---
id: "035"
title: 审阅并稳定 Lingui catalogs
kind: leaf
parent: "200"
depends_on: ["010", "020", "tauri-server-web-modes/065"]
discovered_from: "030"
model: gpt-5.6-terra
status: done
created: 2026-08-31
done: 2026-08-31
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/i18n/locales/en/messages.po
  - apps/web/src/i18n/locales/zh-CN/messages.po
---

# 审阅并稳定 Lingui catalogs

## 目标

把 030 首次 clean extract 生成的两份 catalog 作为待审生成产物核对，并证明它们从当前源码再次提取时不漂移。

## 上下文

030 已把两份原本 untracked 的 PO 从旧 hash 更新为当前源码对应状态；第二次 extract hash 不变，English
Missing 为 0。本叶不得手工美化 PO，也不得放宽真实 Provider；只审阅生成结果是否完整、无 fuzzy/obsolete/
空翻译，并用提取前后 hash 证明稳定。

## 验收标准

1. 两份 PO 都有 482 条 source message；除 header 外没有空 `msgstr`，没有 fuzzy 或 obsolete entry。
2. `pnpm lingui:extract --clean && pnpm lingui:compile` 前后两份 PO 的 SHA-256 完全一致，English Missing 0。
3. 真实 Provider 的中英文 surface 测试通过，`git diff --check` 通过。
4. 只接受生成 catalog，不修改生产源或 Lingui 配置。

## 执行记录（仅编排者回写）

- 2026-08-31：发现自 030；首次 extract 已同步 catalog，第二次已幂等，等待 owner 独立核对生成内容。
- 2026-08-31：独立审查 APPROVED；编排者再次复跑 extract/compile，482/482、English Missing 0 且前后 hash 完全一致。
