---
id: "055"
title: 清理退役模型的可执行引用
kind: leaf
parent: "300"
depends_on: ["045"]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-31
done: 2026-08-31
base: 5ad0f617571f96de36305019c531a258c0fb4e25
files:
  - README.md
  - README.zh-CN.md
  - docs/README.md
  - docs/launch/repo-metadata.md
  - docs/model-adapter-compatibility.md
  - packages/agent-ai/src/*.test.ts
  - packages/agent-core/src/**/*.test.ts
  - packages/subagents/src/*.test.ts
  - apps/web/src/**/*.test.ts
  - apps/web/src/**/*.test.tsx
  - apps/web/src/i18n/locales/en/messages.po
  - apps/web/src/i18n/locales/zh-CN/messages.po
---

# 清理退役模型的可执行引用

## 目标

消除测试与界面中会继续产出退役模型的引用。

## 粒度

这是跨包机械夹具同步与静态 allowlist 审计，预计 15 分钟；按文件拆会制造大量不足十分钟的小任务。

## 上下文

产品实现更新后，characterization、routing、credential、model controls、session fixtures 中仍有旧 GLM 与
K2.6 ID。用户确认无需存量迁移，因此产品与可执行夹具中的这些 ID 全部删除或改成目标六模型；旧任务
账本和历史说明可保留。DeepSeek Vision 的引用是目标项，绝不能被清掉。

只同步夹具、当前 README/文档索引模型说明与必要翻译目录，不借机改生产语义。历史蓝图、RFC、任务账本和
项目学习记录可作为历史说明保留。若发现生产代码仍产出退役 ID，报告 BLOCKED 交回对应厂商叶，
禁止在机械任务里顺手修。

## 覆盖矩阵行

- `C-01`、`C-09`、`C-12`、`C-13`：选择器、视觉回归、自定义连接与静态残留。

## 接口

### 消费

- 020/030/040/045 的最终常量与 catalog。

### 产出

- 一条可复跑的 `rg` allowlist 规则，区分历史账本与非法可执行残留。

## 验收标准

1. registry/UI 断言精确六模型；profile 的 missing-current fallback 仍支持自定义模型。
2. 退役 ID 的 `rg` 命中只出现在旧任务账本或官方历史说明。
3. DeepSeek Vision viewer、Composer 图片、Kimi K3 图片、model controls 和 routing 相关测试通过。
4. Lingui extract/compile、类型检查、diff check 通过；不修改生成目录以外的生产代码。
5. 当前 adapter 兼容契约同步六模型目录与三家最新 thinking/wire 语义，不再把 Kimi 写成未接入。
6. 英文目录无缺失翻译，required Thinking toggle 的 accessible name/title 在 English 下为英文。
7. retired-ID 静态模式覆盖升级前完整 GLM 目录（含 exact `glm-5`、air/airx/flashx）与 K2.6。
