---
id: "065"
title: 对齐桌面发布现状文档
kind: leaf
parent: "300"
depends_on:
  - "060"
discovered_from: "060"
model: gpt-5.6-terra
status: done
created: 2026-08-31
done: 2026-08-31
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - docs/release-signing.md
  - docs/launch/repo-metadata.md
  - docs/ROADMAP.md
---

# 对齐桌面发布现状文档

## 目标

移除仍把桌面端与 `release-desktop.yml` 描述为当前不存在的文档冲突，同时保留旧富 Rust 宿主已删除的历史事实。

## 上下文

060 恢复的是只承载 Node sidecar 的 Tauri 薄壳与 Apple Silicon CI 验证/签名构建路径，不恢复旧 Rust
业务宿主，也不授权 GitHub Release、artifact upload、push 或实际发布。历史 issue 账本继续按当时事实保留；
这里只改仍被当作当前说明的三份文档。

## 验收标准

1. `docs/release-signing.md` 明确当前六个 Apple secrets、Apple Silicon tag 构建路径与“不上传/不发布”边界，并把九-secret 四平台流程标成历史。
2. `docs/launch/repo-metadata.md` 不再声称 workflow/desktop 当前不存在，仍准确说明没有 GitHub Release 产物。
3. `docs/ROADMAP.md` 区分已删除的旧多平台 Rust 宿主与当前 Apple Silicon 薄壳，不把新实现标成已作废。
4. `node scripts/check-docs.js`、`git diff --check` 与普通文件 300 行门通过。

## 执行记录（仅编排者回写）

- 2026-08-31：编排者在核对 060 时发现三份当前文档仍宣称桌面端/workflow 不存在，登记为发现叶。
- 2026-08-31：三份现状文档完成对齐并通过独立审查；编排者修复两处审查账本代码片段的链接误判后，根文档门通过 317 个 Markdown 文件。
