---
id: 050
title: 接通视觉工具运行能力
kind: leaf
parent: 300
depends_on: [010, 020, 030]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/agent-core/src/runtime/core/runtimeConfig.ts
  - packages/agent-core/src/runtime/toolContext.ts
  - packages/agent-core/src/runtime/toolContext/visionCapabilities.ts
  - packages/agent-core/src/tools/types.ts
  - packages/agent-core/src/index.ts
  - packages/agent-core/src/**/*.test.ts
  - apps/web/src/vision/**
  - apps/web/src/main.tsx
  - apps/web/src/**/*.test.ts
---

# 接通视觉工具运行能力

## 目标

建立 `ToolContext.viewImage` 的受管运行能力：读取 030 的受限图片，`low` 时在浏览器内等比缩入
512×512 包围盒、`high` 时保留原像素，经 010/020 上传后以固定 DeepSeek vision 模型发起无历史、
无工具的隔离调用，返回文字与实际模型名，并在所有退出路径尽力删除远端文件。

## 粒度

预计 20–30 分钟；这项跨 core 能力边界、浏览器图像处理和 provider 调用，属于高风险单一运行闭环，
再拆会暴露不能独立使用的半接口。职责仍须落在多个不超过 300 行的文件中。

## 上下文

`RuntimeConfig` 已注入 `fetchImpl` 等产品端口，`buildToolContext` 负责 stale/abort/workspace 守卫。
新增可选 app-owned vision port，并由独立 `visionCapabilities.ts` 装配，不把 DeepSeek 厂商判断写入 core。
apps/web 实现可调用 `@einfach-agent/ai` 的 adapter 与 030 的图片读取结果；不得继承当前 conversation，
不得把当前工具 schema传给子请求。若静态宿主不支持读取，应返回明确中文错误。

新文件职责计划：
- `runtime/toolContext/visionCapabilities.ts` → 只把 app-owned vision port 安全挂到 ToolContext。
- `apps/web/src/vision/resizeVisionImage.ts` → 只实现 low/high 像素预处理。
- `apps/web/src/vision/deepseekImageViewer.ts` → 只编排读取、上传、隔离请求与清理。

## 覆盖矩阵行

- `C-006`：low 默认路径的 512 包围盒预处理。
- `C-007`：high 保留原图。
- `C-008`：隔离 DeepSeek 调用、清理与错误边界。

## 接口

### 消费
- `ToolContext.readWorkspaceImage` / `WorkspaceImageReadResult`：来自 030。
- `DEEPSEEK_VISION_MODEL`、上传/清理/消息投影：来自 010。
- DeepSeek Files API transport：来自 020。

### 产出
- `RuntimeConfig.viewImage?: ViewImageCapability`：由 app 装配。
- `ToolContext.viewImage?(input: {path:string; detail:'low'|'high'}) => Promise<{content:string;model:string}>`：供 060 工具调用。

## 验收标准

1. `pnpm exec vitest run apps/web/src/vision packages/agent-core/src/runtime --testNamePattern='viewImage|vision|视觉|图片'` → low/high、隔离请求、失败清理、stale/abort 通过。
2. `pnpm exec tsc -b packages/agent-core/tsconfig.json tsconfig.app.json` → 类型检查通过或只剩明确记录的共享 worktree 前置错误。
3. `wc -l packages/agent-core/src/runtime/toolContext/visionCapabilities.ts apps/web/src/vision/*.ts` → 普通文件均不超过 300 行且职责独立。
4. `git diff --check -- packages/agent-core apps/web/src/vision apps/web/src/main.tsx` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：010、020、030 均经独立审查通过，派发首轮实现。
- 2026-08-21：首轮独立审查 REJECTED 两项 Important。I-1：low Canvas 编码实际 Blob MIME 可能
  回退而上传仍沿用 source MIME；I-2：workspace 读取在安全错误边界外，custom/remote host 的绝对路径
  错误可原样穿出。进入 R1，要求 MIME 一致性 fail-closed 与读取阶段固定脱敏并补反例测试。
- 2026-08-21：R1 反例与定向 18/18 通过；独立复审 APPROVED。编排者复跑 vision runtime、core
  capability 与 main 装配 20/20 通过，C-006/C-007 的运行语义和 C-008 完成。
