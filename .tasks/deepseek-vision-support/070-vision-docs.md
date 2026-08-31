---
id: 070
title: 说明 DeepSeek 视觉能力
kind: leaf
parent: 400
depends_on: [040, 060]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - README.md
  - README.zh-CN.md
---

# 说明 DeepSeek 视觉能力

## 目标

在现有两份 README 的模型与工具说明中准确记录 DeepSeek vision 模型、Composer 附图、`view_image`
的 low/high 选择、支持格式与 Files API 临时上传清理语义，不宣传未实现的 GIF 或 Responses API。

## 粒度

预计 10–15 分钟；这是纯文档同步叶，多语言同一事实必须一起更新避免产品说明漂移。

## 上下文

以 040、060 的实际实现为准。两份文档保持现有密度。不要粘贴上游长段文字；只链接
官方 Vision 与 Files API 指南。工作区 README 已有用户改动，必须局部修改并保留。

## 覆盖矩阵行

- `C-010`：用户文档。

## 接口

### 消费
- 040 的 Composer 实际支持格式与清理行为。
- 060 的 `view_image` schema 与 detail 说明。

### 产出
- 无代码接口；产出用户可查阅的准确能力说明。

## 验收标准

1. `rg -n "deepseek-v4-flash-vision-exp|view_image|Detail|detail" README.md README.zh-CN.md` → 两份现有 README 均有对应说明。
2. `rg -n "api-docs.deepseek.com/.*/guides/(vision|files_api)" README.md README.zh-CN.md` → 官方链接存在且无搜索页链接。
3. `git diff --check -- README.md README.zh-CN.md` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：040、060 均经独立审查通过，派发文档同步。
- 2026-08-21：勘察确认根目录及基线都不存在 `README.zh-TW.md`、`README.ja.md`；不为单一能力新建
  两份不完整翻译，只同步现有 `README.md`、`README.zh-CN.md`，验收范围相应修正。
- 2026-08-21：独立审查 APPROVED 后，编排者严格执行官方链接验收发现 `/guides/...` 不匹配用户提供
  的 `/zh-cn/guides/...`，且原串联命令被后续成功命令掩盖退出码。进入 R1，仅修正四个官方链接并
  分别执行可失败的精确 rg。
- 2026-08-21：R1 链接复审 APPROVED；编排者以 `rg -c` 确认两份 README 各 2 个 zh-cn 官方链接，
  diff-check 通过，C-010 完成。
