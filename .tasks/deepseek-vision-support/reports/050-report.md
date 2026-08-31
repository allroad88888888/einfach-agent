# 050 执行报告：接通视觉工具运行能力

## 改动摘要

- core 新增可选 app-owned `RuntimeConfig.viewImage` port；`ToolContext.viewImage` 由独立
  `visionCapabilities.ts` 装配，只向 app 暴露 `signal`、`assertFresh` 与已受 workspace/Auto
  权限、stale/abort 守卫保护的 `readWorkspaceImage`，没有任何 DeepSeek 厂商分支。
- web 新增 `resizeVisionImage.ts`：`low` 解码真实尺寸，超过边界时用 canvas 等比重编码进
  512×512 包围盒；已在包围盒内保留原字节。`high` 在像素解码前直接返回由 host 原始 base64
  构造的 Blob，不经过 canvas，保持上传字节与像素。
- web 新增 `deepseekImageViewer.ts`：只经 capability context 的 `readWorkspaceImage` 读取图片；经
  010 transport 上传后，固定 `deepseek-v4-flash-vision-exp` 发起仅含当前图片的一轮非流式调用，
  不继承会话消息，不发送 `tools` / `tool_choice`，返回响应文字与响应中的实际 `model`。
- 上传完成后的成功、无效响应、网络失败、取消与 stale 路径都在 `finally` 调用幂等 rollback；
  cleanup 不继承已取消 signal 且 best-effort。上传阶段的部分成功仍复用 010 的回滚语义。
- app 所有视觉阶段错误均收敛为固定文案，生命周期 `AbortError` / `stale` 原样保留；没有日志路径，
  API key 与 `file-api-*` 不进入错误。静态/无桥宿主返回固定且明确的“当前宿主不支持读取图片”。
- main 在既有受管模型传输装配点注入 viewer，API key 继续只使用既有宿主管理标记，不进入前端状态。

## 逐条验收

1. `pnpm exec vitest run apps/web/src/vision packages/agent-core/src/runtime --testNamePattern='viewImage|vision|视觉|图片'`
   - 通过：5 个测试文件命中，14 项测试全部通过（其余 959 项因 name pattern 跳过）。
   - 覆盖 low/high、固定隔离请求、无 detail、成功/失败/取消清理、错误脱敏、无图片宿主、
     stale/abort 与 workspace 权限注入。
2. `pnpm exec tsc -b packages/agent-core/tsconfig.json apps/web/tsconfig.json`
   - 未通过：仓库不存在 `apps/web/tsconfig.json`（TS5083）；此外继续出现 030 已披露的
     `tools/{agents,fs,interaction,planning,shell,skills}` 多处 `*.md?raw` TS2307。输出中没有 050
     文件的类型错误。
   - 用实际 web 配置补跑
     `pnpm exec tsc -b packages/agent-core/tsconfig.json tsconfig.app.json`，只剩同一批范围外
     `*.md?raw` TS2307。
   - 隔离验证通过：
     - `pnpm exec tsc -p packages/agent-core/tsconfig.json --types vite/client,node`
     - `pnpm exec tsc -p tsconfig.app.json --types vite/client,node`
3. `wc -l packages/agent-core/src/runtime/toolContext/visionCapabilities.ts apps/web/src/vision/*.ts`
   - 通过：core 装配 39 行；app 实现 88/104 行；app 测试 136/63 行；全部普通文件不超过
     300 行且职责独立。
   - `packages/agent-core/src/index.ts` 经紧凑类型 re-export 保持 299 行，没有被本次接线顶破上限。
4. `git diff --check -- packages/agent-core apps/web/src/vision apps/web/src/main.tsx`
   - 通过，无 whitespace diagnostics。
   - 对 6 个本任务未跟踪新文件另逐一执行
     `git diff --no-index --check /dev/null <file>`，均无 whitespace diagnostics。

补充验证：

- `pnpm exec vitest run apps/web/src/main.serverHost.test.tsx apps/web/src/vision packages/agent-core/src/runtime/toolContext/visionCapabilities.test.ts`
  通过：4 个文件、14 项测试；最终 viewer 增补 stale 用例后，vision 三文件单独复跑为 12/12，
  规定的带 name pattern 命令最终复跑为 14/14。
- `pnpm check:boundaries` 通过，扫描 909 个非测试 TS/TSX 文件；输出仅含仓库既有豁免观察项，
  新 core 文件没有 DeepSeek 字面量或 provider import。

## 覆盖矩阵证据

### C-006：low 默认细节的 512 包围盒预处理

- `resizeVisionImage.test.ts` 证明 1600×900 经真实编码平台调用变为 512×288，宽高均不超过 512；
  400×300 已在包围盒内时保留原字节。
- viewer 测试证明调用输入的 `detail:'low'` 精确传给预处理，预处理产物再进入 Files API 上传。
- 请求体递归断言不含 `detail`，因此不是把无效 detail 伪传给 `file_id`。

### C-007：high 保留原图

- `resizeVisionImage.test.ts` 证明 `high` 上传 Blob 字节与 host 原始字节逐字节一致，同时
  `decode` / canvas `encode` 调用次数均为 0；不存在有损重编码或尺寸变化。

### C-008：隔离视觉调用、清理与错误边界

- 请求捕获证明固定模型为 `deepseek-v4-flash-vision-exp`，messages 只有本次观察的一条 user
  message，且 body 不含 `tools`、`tool_choice`、`detail`；返回 assistant 文字与响应实际 model。
- 成功、无效视觉响应、AbortError 三类路径都观察到
  `DELETE https://api.deepseek.com/files/file-api-*`；DELETE 自身失败不遮蔽原始调用错误。
- 错误断言证明对外文案不含测试 API key 或 file id；实现无日志调用。
- core 测试证明 app port 只得到三个窄能力，Auto 外部只读权限由 ToolContext 注入，stale 在调用前
  拒绝、调用中迟到结果丢弃；app 还在读取、预处理、上传、模型响应各阶段调用 `assertFresh`，并在
  每个耗时阶段尊重 `AbortSignal`。
- 无 host bridge 时，读取错误在任何预处理或上传前映射为明确且固定的中文错误。

## 未验证项

- 未连接真实 DeepSeek 服务，未上传真实文件；任务禁止未授权联网，网络协议均通过注入 fetch 验证。
- 未在真实浏览器 GPU/canvas 对 JPEG、PNG、WebP 各做像素级端到端截图测试；单测通过注入的浏览器
  surface 契约验证精确目标尺寸与编码调用，实际 DOM canvas 路径通过 TypeScript 检查。
- 正式组合 `tsc -b` 未绿，原因仅为已知范围外 `*.md?raw` 声明加载与任务中不存在的 web tsconfig
  路径；两个目标配置的隔离类型检查已通过。

## 范围外发现

- `packages/agent-core/src/tools/types.ts` 是 030 已披露的存量超限文件：基线 309 行，并行 030 增加
  workspace image 类型后，本次在 canonical ToolContext 契约内小改，当前 352 行。按规则未在 050
  顺手重构公共工具类型。
- 任务验收写的 `apps/web/tsconfig.json` 不存在，实际 web 配置是根目录 `tsconfig.app.json`。
- 工作区仍含大量并行在途改动；本次只在 050 files 内增量叠加，没有 reset、checkout、暂存或提交。

## 疑虑

- 无产品行为阻断项。正式 TypeScript 总门仍为红色，需由拥有工具包构建图的任务修复 `*.md?raw`
  ambient declaration 后复跑。
- 浏览器对 WebP `canvas.toBlob('image/webp')` 的支持若缺失会明确失败，不会用错误 MIME 静默上传；
  若未来要兼容不支持 WebP 编码的浏览器，应单独设计安全的 PNG fallback 与文件名/MIME 投影。

## 建议后续动作

1. 060 注册 `view_image` 时令 `detail` schema 默认 `low`，并明确 OCR、小字截图、密集图表、细节比较
   使用 `high`；工具只调用 `ctx.viewImage`，不自行读文件或访问 provider。
2. 080 修复/加载 `*.md?raw` ambient declaration 后复跑全仓 `tsc -b`、build/state/boundaries 与真实
   浏览器 canvas 冒烟测试。

## R1 修复记录

### 两项 Important 修复

1. low 重编码 MIME fail-closed：
   - `resizeVisionImage` 在 canvas 编码后验证实际 `Blob.type` 必须与 host `source.mimeType` 精确一致；
     不一致固定抛出 `重编码图片格式与原图不一致`，不把原 MIME/文件名继续附到错误编码字节上。
   - 单元反例模拟请求 `image/webp`、编码平台返回 `image/png`，验证 1024×512 虽已计算为
     512×256，但在产物返回前拒绝并关闭 decoded surface。
   - viewer 串联反例使用同一 WebP→PNG fallback，验证对外只返回固定预处理失败文案，注入 fetch
     调用次数为 0，即 Files API 上传未发生。
   - 正常同 MIME 用例补充验证输出 `Blob.type:'image/png'`、上传 `mimeType:'image/png'`、原文件名与
     512×288 尺寸元数据一致。
2. host/bridge 读取错误脱敏：
   - `readWorkspaceImage` 与紧随其后的 `assertFresh`/abort 检查进入独立安全错误边界；
     `AbortError` 与精确 `stale` 原对象保留，其余错误统一为 `当前宿主不支持读取图片`。
   - 无桥宿主不再透传 `read_workspace_image` command bridge 内部文案，但仍给出明确固定能力错误。
   - 精确反例令 host 抛出 `cannot read /outside/private/secret.png`，验证错误不含绝对路径或
     `cannot read` 原文，且 resize 与 fetch/Files API 均为 0 次调用。
   - 读取阶段的 AbortError/stale 另以对象同一性测试证明未被固定错误替换。

### R1 验收结果

1. `pnpm exec vitest run apps/web/src/vision packages/agent-core/src/runtime --testNamePattern='viewImage|vision|视觉|图片'`
   - 通过：5 个测试文件、18 项测试全部通过。
2. 有效隔离类型检查：
   - `pnpm exec tsc -p packages/agent-core/tsconfig.json --types vite/client,node` → exit 0。
   - `pnpm exec tsc -p tsconfig.app.json --types vite/client,node` → exit 0。
   - 按编排要求未反复运行已知只会被 `*.md?raw` 与不存在的 `apps/web/tsconfig.json` 阻断的正式
     组合命令；原报告的范围外归因不变。
3. 补充聚焦：
   - `pnpm exec vitest run apps/web/src/vision/deepseekImageViewer.test.ts apps/web/src/vision/resizeVisionImage.test.ts`
     → 2 个文件、13 项测试全部通过。
4. 行数与 whitespace：
   - core 装配 39 行；app 源文件 94/107 行；app 测试 221/86 行，均不超过 300 行。
   - 指定范围 `git diff --check` 与 6 个未跟踪源/测试文件逐一 `git diff --no-index --check` 均通过。

### R1 覆盖结论

- C-006：完成。low 的像素尺寸与上传 MIME/文件名元数据现在同时闭合；浏览器格式 fallback 不会
  形成错配上传。
- C-007：保持完成。high 分支仍在任何 decode/canvas 之前返回原始 Blob，本轮未改变。
- C-008：完成。所有非生命周期读取错误在 resize/upload 前固定脱敏；隔离调用和 finally DELETE
  语义保持通过。

### R1 未验证与疑虑

- 未进行真实 DeepSeek 网络调用或真实浏览器 WebP fallback 探测；两项仍由注入 fetch/platform 的
  确定性反例验证。
- 正式组合 TypeScript 总门的既有 `*.md?raw` / 错误 tsconfig 路径问题保持不变，不属于 R1 修复范围。
- 本轮两个审查 Important 均已关闭，无新增产品行为疑虑。
