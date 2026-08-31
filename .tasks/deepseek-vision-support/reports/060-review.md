# 060 审查：注册 `view_image` 工具

## 结论

**APPROVED**。未发现 Critical / Important / Minor 问题。

审查基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`。仅审阅任务规定的范围 diff，以及未跟踪的
`tools/vision/` 文件；未重跑执行报告中的测试或类型检查。

## 验收

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| `path` 必填且非空 | ✅ | schema 将 `path` 放入 `required` 并设 `minLength: 1`；执行层对非字符串、空串和全空白路径 `trim()` 后 fail-closed。 |
| `detail` 仅为 `low` / `high` | ✅ | schema enum 精确为这两项；执行层再次拒绝其他值。 |
| C-006：省略值实际传 `low` | ✅ | schema 默认 `low`；`normalizeDetail(undefined)` 返回 `low`，随后以 `{ path, detail }` 调用 `ctx.viewImage`；契约测试经 registry 覆盖此路径。 |
| C-007：`high` 精确透传 | ✅ | 执行层不映射 `high`，直接传入 capability；测试断言 `{ path: 'chart.png', detail: 'high' }`。 |
| 缺少 capability fail-closed | ✅ | `ctx.viewImage` 不存在或非函数时返回不可重试的 `VIEW_IMAGE_UNAVAILABLE`，未降级到 provider、fs 或网络调用。 |
| 工具边界 | ✅ | 生产实现仅从 `@einfach-agent/core/tools` 引入 `Tool` / `ToolContext`，以及本地指南；未导入 provider、AI 包、fs、fetch 或 host。 |
| 成功结果稳定 | ✅ | runtime 结果只在 `content`、`model` 都是字符串时投影为 `{ content, model }`；其余字段不外泄，畸形结果闭合失败。 |
| 模型可见 detail 指引 | ✅ | `.md` 与 tool skill 均明确：普通图优先 `low`；OCR、小字截图、密集图表/图形、精细比较用 `high`。 |
| C-009：标准目录注册 | ✅ | `registerStandardTools` 注册并 re-export `registerVisionTools`；标准权威表从 31 项更新为精确 32 项并包含 `view_image`。计数、逐名、幂等、`replayUnsafe` 测试均同步更新。 |
| 包与锁接线 | ✅ | vision 包仅依赖 core；standard 新增一次且仅一次 workspace 依赖；lockfile 有相应 `tools/vision` importer 与 `tools-vision` link。未见重复依赖。 |
| TypeScript / Vite 接线 | ✅ | 本范围相对基线对 `tsconfig.json`、`apps/web/package.json`、`apps/web/vite.config.ts` 无改动；新包具备与既有 workspace 包一致的独立 tsconfig/build 配置，标准包经 workspace 依赖解析它。 |
| 单一职责与行数 | ✅ | 新生产文件：工具实现 102 行、域注册 9 行；测试 104 行；标准聚合 44 行、聚合测试 65 行，均低于 300 行。各自职责清晰。 |

## 测试记录

未重跑。采信执行报告的聚焦 Vitest 通过记录；其中组合 `tsc -b` 被既有其它工具域的 `*.md?raw` 解析问题阻断，非本叶引入。新增 vision 包的 raw 声明与其本地 TypeScript 检查已在报告中记录通过。

## 范围外观察

⚠️ `package.json` 与 `pnpm-lock.yaml` 相对该基线还混入 Lingui、Tauri、esbuild 及其大量传递依赖的并行在途改动；它们不属于 060 的 vision 接线，亦未被本审查修改。060 自身的 package/lock 变动（新增 `tools/vision` importer 和 standard → vision workspace link）完整且未与这些改动重复。

⚠️ 任务列出的 `tsconfig.json`、`apps/web/package.json`、`apps/web/vite.config.ts` 在本范围 diff 中没有变化；执行报告中“更新 TypeScript 路径、Vite alias”的表述不能归因于 060，可能是先前或并行在途内容。当前审查未发现它妨碍 vision 的 workspace 接线。
