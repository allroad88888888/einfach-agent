---
id: 010
title: 建立 DeepSeek 视觉适配器
kind: leaf
parent: 100
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/agent-ai/src/deepseek.ts
  - packages/agent-ai/src/deepseek*.ts
  - packages/agent-ai/src/imageCapability.ts
  - packages/agent-ai/src/builtinModelDescriptors.ts
  - packages/agent-ai/src/builtinProviders.ts
  - packages/agent-ai/src/index.ts
  - packages/agent-ai/src/*.test.ts
---

# 建立 DeepSeek 视觉适配器

## 目标

在 agent-ai 内交付 `deepseek-v4-flash-vision-exp` 的完整 provider adapter：模型描述、静态图片能力、
Files API multipart 上传/删除、`file-api-*` 引用校验、Chat `file` 内容块投影及就近回归测试。复用 Kimi
的 provider-neutral `provider-file` 源，但不得把 Kimi 的 `ms://` 规则或 scope 泄漏给 DeepSeek。

## 粒度

预计 15–25 分钟；模型目录、上传生命周期和消息投影是同一个 provider adapter 闭环，拆开会产生无法
独立验证的临时公开接口，因此保持一叶。若 `deepseek.ts` 会超过 300 行，必须按上传/消息职责拆新文件。

## 上下文

现有 `deepseek.ts` 会把视觉块退化为非视觉消息；Kimi 对照实现在 `kimiFiles.ts`、`kimiMessages.ts`、
`kimiFileDisposal.ts`。官方要求上传 `POST /files` multipart 字段 `file` 与 `purpose=user_data`，返回 ID
形如 `file-api-*`，聊天内容块为 `{type:'file',file_id}`。不要发送无效的 `detail` 字段。模型 1M 上下文，
沿用 flash 的思考/工具能力。当前 `builtinModelDescriptors.ts` 是用户在途未跟踪文件，必须原地保留其余改动。

新文件职责计划：
- `deepseekFiles.ts` → 只管理 DeepSeek Files API 图片上传批次与回滚。
- `deepseekMessages.ts` → 只把 provider-neutral 图片块投影为 DeepSeek Chat 内容块。
- `deepseekFileDisposal.ts` → 只计算并删除不再保留的 DeepSeek 文件引用。

## 覆盖矩阵行

- `C-001`：模型目录与静态图片能力。
- `C-002`：Files API 上传、引用投影与清理。

## 接口

### 消费
- `UserImageContentBlock` / `provider-file`：来自 `modelProtocol.ts`，沿用现有持久化图片抽象。
- `ProviderFetch`：来自现有 transport 调用选项，用于注入测试 fetch。

### 产出
- `DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp'`：供 040、050 使用。
- `DEEPSEEK_VISION_IMAGE_INPUT: ImageInputCapability`：供 Composer 能力判断使用。
- `prepareDeepSeekImageBatch(files, options)`：供 040 与 050 上传图片。
- `disposeDeepSeekProviderFiles(...)`：供 040/050 清理远端临时文件。
- DeepSeek request projector 对视觉模型保留并编码 `file` block；非视觉模型行为不回归。

## 验收标准

1. `pnpm exec vitest run packages/agent-ai/src/deepseek*.test.ts` → 模型、上传、投影、回滚、清理全通过。
2. `pnpm exec tsc -b packages/agent-ai/tsconfig.json` → 类型检查通过。
3. `wc -l packages/agent-ai/src/deepseek*.ts` → 普通文件均不超过 300 行且各文件职责可一句话说明。
4. `git diff --check -- packages/agent-ai` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：已派发首轮实现。
- 2026-08-21：执行 36/36 DeepSeek 聚焦测试、包级 tsc 与 agent-ai 268 项回归通过；独立审查
  APPROVED。编排者复跑指定 5 文件 39/39 通过，任务完成。
