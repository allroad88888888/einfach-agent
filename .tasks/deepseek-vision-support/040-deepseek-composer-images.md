---
id: 040
title: 接通 DeepSeek Composer 图片会话
kind: leaf
parent: 300
depends_on: [010, 020]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/modelInput/**
  - apps/web/src/**/*Image*.test.ts
  - apps/web/src/**/*image*.test.ts
  - packages/agent-ai/src/historyImageCompatibility.ts
  - packages/agent-ai/src/historyImageCompatibility.test.ts
---

# 接通 DeepSeek Composer 图片会话

## 目标

让选择 `deepseek-v4-flash-vision-exp` 的会话复用现有 Composer 图片附件体验，提交时走 DeepSeek Files
API，历史恢复后仍能正确投影引用，移除/失败/丢弃时只清理不再保留的 DeepSeek 文件，且 Kimi 行为不回归。

## 粒度

预计 15–20 分钟；这是一个用户输入生命周期闭环，上传、恢复和清理不可拆成互相不可验收的半成品。

## 上下文

当前 `prepareProviderUserInput.ts`、feature gate、history compatibility 与 disposer 都硬编码 Kimi。将它们
改为按 provider/model 分派，避免条件链继续散落；不要改变通用 `UserImageContentBlock` 协议。DeepSeek
视觉模型的 capability 来自 010，fetch 路由来自 020。Composer 保留原图，不出现工具专用 detail UI。

新文件职责计划：
- 如需新增 dispatcher 文件，它只负责 provider 图片生命周期分派，不承担上传实现。

## 覆盖矩阵行

- `C-005`：Composer 上传、历史兼容、丢弃清理。

## 接口

### 消费
- `DEEPSEEK_VISION_MODEL`、`DEEPSEEK_VISION_IMAGE_INPUT`、`prepareDeepSeekImageBatch`、`disposeDeepSeekProviderFiles`：来自 010。
- DeepSeek Files API transport：来自 020。

### 产出
- `prepareProviderUserInput` 对 DeepSeek vision 返回持久化 provider-file 图片块。
- 通用历史/处置分派同时识别 Kimi 与 DeepSeek，供会话运行时使用。

## 验收标准

1. `pnpm exec vitest run apps/web/src/modelInput apps/web/src --testNamePattern='DeepSeek|Kimi|image|图片'` → DeepSeek 新覆盖与 Kimi 回归通过；若过滤器不适用，报告列出等价精确文件命令。
2. `pnpm exec tsc -b tsconfig.app.json` → 类型检查通过。
3. `git diff --check -- apps/web/src/modelInput packages/agent-ai/src/historyImageCompatibility*` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：010、020 已审查通过，派发首轮实现。
- 2026-08-21：勘察确认历史投影的唯一 owner 是 agent-ai 的 `historyImageCompatibility.ts`，并非任务
  初拟的 app 路径；将该实现与就近测试精确纳入，保持“Composer 图片生命周期”目标不变。
- 2026-08-21：7 文件 28 项聚焦测试与实际 web tsc 通过；独立审查 APPROVED。编排者复跑上传、
  disposer、历史兼容 16/16 通过，任务完成。宽过滤命令的 5 个 SettingsCenter 失败归属共享在途改动。
