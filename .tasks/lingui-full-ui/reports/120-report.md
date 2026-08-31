# 120 时间线固定框架报告

## 完成范围

- `BrowserActionCard.tsx`：浏览器动作卡片 aria label 接入 Lingui；浏览器卡片 title/body 保持动态原文。
- `CompletedPlanRecord.tsx`：计划记录、阶段完成计数、展开动作、交付物、结果 aria 与证据插值框架接入 Lingui；计划/阶段标题、目标、交付物、结果和证据数据保持原样。
- `RunDurationStatus.tsx`：运行标签、耗时单位框架、可见耗时句式与 aria label 接入 Lingui，计时与 run 状态计算未改。
- `SaveArtifact.tsx`：系统文件选择器描述、字符数、保存动作、取消/失败状态与待保存区 aria 接入 Lingui；文件名、文件内容与浏览器原始错误信息保持原样。
- `SubagentRunInline.tsx`：子 agent/工具/thinking 的固定标签、状态、空状态与计数框架接入 Lingui；节点目标、工具名、工具参数/结果、模型 reasoning/content、节点错误、JSON preview 与产物路径保持原样。
- 审核后未改 `BrowserCardTimelineRenderer.tsx`、`ThinkingTimelineRenderers.tsx`、`TimelineItemView.tsx`：三者只委派动态 timeline item，没有静态用户文案；registry resolve 与 renderer 委派逻辑保持不变。
- 未修改 tests、PO/catalog、任务定义、index、timeline registry/store/tool execution；未运行 extract/compile。

## 文件职责与行数

- 8 个目标文件均保持原有单一展示职责；未新增文件，也无需拆分。
- `SubagentRunInline.tsx` 由 260 行增至 273 行，仍低于普通文件 300 行上限；其余目标文件最高 161 行。

## 验证

- `pnpm exec tsc -b`：通过，退出码 0，无诊断。
- 8 个目标文件的 `git diff --check -- ...`：通过，退出码 0，无输出。
- `wc -l`：`24 / 8 / 102 / 63 / 161 / 273 / 25 / 20`，全部不超过 300 行。
- scoped diff：仅 5 个实际含静态文案的目标源码文件有产品改动；另有本报告。其余工作树改动均为既有并行工作，本任务未触碰。
