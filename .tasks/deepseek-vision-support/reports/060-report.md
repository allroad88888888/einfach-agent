# 060 执行报告：注册 view_image 工具

## 摘要

- 新增独立 `@einfach-agent/tools-vision` 域，唯一工具为 `view_image`；生产实现只依赖工具抽象与
  `ToolContext.viewImage`，不导入 provider、`@einfach-agent/ai`、fetch、fs 或 host。
- `path` schema 为必填且 `minLength: 1`；`detail` 仅接受 `low`/`high`，schema 默认 `low`，执行层也
  在直接调用时默认化。工具将默认后的 `low` 与显式 `high` 原样传给 context。
- 成功结果只投影 `{ content, model }`；缺少能力时返回 fail-closed 的
  `VIEW_IMAGE_UNAVAILABLE`，异常与畸形返回不会泄漏内部对象。
- 新增模型可见指南，明确普通图片选 `low`，OCR、截图小字、密集图表/图形和精细比较选 `high`；未暗示
  file_id 有服务端 detail 参数。
- 标准工具集注册 vision 域，权威清单从 6 域 31 工具变为 7 域 32 工具，更新 package、lockfile、
  TypeScript 路径、Vite alias 与 README。

## 逐条验收

1. `pnpm exec vitest run tools/vision tools/standard/src/index.test.ts`
   - 通过：2 个测试文件、10 项测试。
   - 覆盖 registry schema 默认、执行层默认、high 精确透传、path/detail 拒绝、无 capability fail-closed、
     结果白名单、畸形返回与任意错误不泄漏，以及标准域的精确清单、幂等与 replayUnsafe。
2. `pnpm exec tsc -b tools/vision/tsconfig.json tools/standard/tsconfig.json`
   - 未通过：标准聚合经源码 path 拉入既有六域时，复现 agents/fs/interaction/planning/shell/skills 的
     `*.md?raw` TS2307；这也是 050 已记录的共享构建图前置问题。vision 自己的同类 raw 声明已存在且
     `pnpm exec tsc -p tools/vision/tsconfig.json` 通过。
3. `wc -l tools/vision/src/**/*.ts tools/standard/src/index.ts`
   - 通过：生产实现 102 行、域 index 9 行、标准 index 44 行；测试 104 行，均小于 300 行。各文件均有
     单一职责。
4. `git diff --check -- tools/vision tools/standard package.json pnpm-lock.yaml tsconfig.json tsconfig.app.json vite.config.ts apps/web`
   - 通过，无 whitespace diagnostics。
   - 所有未跟踪 `tools/vision` 文件另逐个以 `git diff --no-index --check /dev/null <file>` 检查，无
     whitespace diagnostics。
5. `pnpm check:boundaries`
   - 通过：扫描 912 个非测试 TS/TSX 文件；仅输出仓库既有观察项。vision 生产代码没有 provider/fetch/fs/
     host import。

## 覆盖矩阵证据

### C-006：low 默认

- `view-image.test.ts` 经真实 `ToolRegistry.run('view_image', { path })` 验证 schema 默认，并断言 context
  收到精确 `{ path: 'images/dashboard.png', detail: 'low' }`。
- 同测试断言 schema 的 `detail.enum` 精确为 `['low', 'high']`、`default` 为 `'low'`；执行层另有未经过
  registry 的默认化逻辑，避免直接调用遗漏低细节语义。

### C-007：high 透传

- `view-image.test.ts` 以 `{ detail: 'high' }` 调用，断言 context 收到精确 `{ path: 'chart.png', detail:
  'high' }`，未缩写、映射或回退为 low。

### C-009：模型可见注册

- `tools/vision/src/index.ts` 导出 `viewImageTool` 与 `registerVisionTools`；标准聚合调用并 re-export 该域。
- `tools/standard/src/index.test.ts` 的权威名称表包含 `view_image`，并实测完整 registry 为 32 个工具且重复
  注册不增加数量。

## 未验证

- 未执行真实网络图片观察；本叶只适配 050 已审核的 capability，测试以注入 context 验证工具契约。
- 未重跑全仓 TypeScript、构建或状态门禁；按任务边界只运行聚焦检查。

## 范围外

- 组合 TypeScript 的 `*.md?raw` TS2307 是既有标准域源码 path 构建图问题，不在本叶 files 内；本叶没有
  修改其它域的 raw 声明。
- 工作区含大量并行 UI、依赖与 lockfile 在途改动；本叶只在 lockfile 中增补 vision importer/依赖，未覆盖
  其它变更，也没有 reset、checkout、暂存或提交。

## 疑虑与后续

- 产品行为无阻断项。080 总门应在共享 `*.md?raw` 类型解析问题收敛后复跑组合 `tsc -b` 与全仓门禁。
- 070 可以直接引用 `view-image.md` 的 detail 选择口径，无需暴露 provider 或 file_id 实现细节。

## 回执（四态）

- 实现：完成
- 聚焦验证：完成
- 组合类型检查：受既有 `*.md?raw` 前置错误阻断，已精确记录
- 范围外变更：未处理，已保留
