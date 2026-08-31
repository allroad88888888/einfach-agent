---
id: 060
title: 注册 view_image 工具
kind: leaf
parent: 300
depends_on: [050]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - tools/vision/**
  - tools/standard/src/index.ts
  - tools/standard/src/index.test.ts
  - tools/standard/README.md
  - package.json
  - pnpm-lock.yaml
  - tsconfig.json
  - tsconfig.app.json
  - vite.config.ts
  - apps/web/package.json
  - apps/web/vite.config.ts
---

# 注册 view_image 工具

## 目标

新增独立 vision 工具域并把 `view_image` 注册进标准工具集；schema 只含必填 `path` 与可选
`detail: 'low'|'high'`，默认 `low`，调用 050 的 `ToolContext.viewImage` 并返回文字结果。工具描述必须明确
OCR、截图小字、密集图表、精细比较选 high，其余优先 low。

## 粒度

预计 10–20 分钟；工具实现、说明、测试与标准注册是一个最小可见交付。包结构机械文件可同叶完成，但
不得把 provider 调用复制进工具包。

## 上下文

每个现有工具目录都包含实现、同名 `.md` 描述和 colocated test，再由域 `src/index.ts` 注册。
`tools/standard/src/index.ts` 的数量注释和 `index.test.ts` 的精确名称列表是权威总表。新包职责为“登记
依赖 ToolContext 视觉能力的图片观察工具”，不得混入通用 fs 工具。

新文件职责计划：
- `tools/vision/src/view-image/view-image.ts` → 只校验参数并调用 `ctx.viewImage`。
- `tools/vision/src/view-image/view-image.md` → 只描述模型可见用法和 detail 选择。
- `tools/vision/src/view-image/view-image.test.ts` → 只验证工具契约。
- `tools/vision/src/index.ts` → 只注册 vision 域工具。

## 覆盖矩阵行

- `C-006`：省略 detail 等价 low。
- `C-007`：high 精确透传。
- `C-009`：标准工具目录可见 `view_image`。

## 接口

### 消费
- `ToolContext.viewImage`：来自 050；工具不认识 DeepSeek、fetch 或图片字节。

### 产出
- 模型可见工具 `view_image({path, detail?})`。
- `registerVisionTools(registry)`，由 `registerStandardTools` 聚合。

## 验收标准

1. `pnpm exec vitest run tools/vision tools/standard/src/index.test.ts` → schema 默认、high 透传、缺能力错误、精确目录通过。
2. `pnpm exec tsc -b tools/vision/tsconfig.json tools/standard/tsconfig.json` → 类型检查通过。
3. `wc -l tools/vision/src/**/*.ts tools/standard/src/index.ts` → 普通文件均不超过 300 行。
4. `git diff --check -- tools/vision tools/standard package.json pnpm-lock.yaml tsconfig.json apps/web` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：050 已经独立审查通过，派发首轮实现。
- 2026-08-21：工具/标准目录 10/10、vision 独立 tsc 与 boundaries 通过；独立审查 APPROVED。
  编排者复跑 10/10 通过，C-006/C-007/C-009 完成。
- 2026-08-21：080 终审 Minor 纠正实际接线路径：根 `tsconfig.app.json` 与 `vite.config.ts` 属于本叶；
  初始 frontmatter 误列 app 内路径。产品接线与 build 已通过，不需代码修复。
