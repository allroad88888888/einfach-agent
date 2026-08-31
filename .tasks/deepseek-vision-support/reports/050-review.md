# 050 独立审查：接通视觉工具运行能力

## 结论

**REJECTED**

没有 Critical；发现 2 个 Important。core/app 分层、high 原字节路径、隔离调用和远端文件清理闭环基本正确，
但 low 重编码后的实际 Blob MIME 未与上传元数据对齐，且图片读取错误处在脱敏边界之外，分别使 C-006、
C-008 未完整满足。

本审查只读取任务说明、执行报告、指定范围 diff，并对本任务 6 个未跟踪文件逐个按 no-index 读取；没有
重跑执行报告声称已运行的测试。

## Findings

### Important 1：low 重编码可能上传“PNG bytes + WebP MIME/文件名”

位置：`apps/web/src/vision/resizeVisionImage.ts:48-51,93-100`

`canvas.toBlob` 的请求格式不受支持时可以回退到其他实际编码格式。这里 `encode` 只检查 Blob 是否非空，
随后 `resizeVisionImage` 无条件把 `source.mimeType` 作为返回元数据；它既不核对 `data.type`，也不据实际
编码调整 MIME/文件名。注入式 `VisionResizePlatform` 契约同样允许返回不同类型的 Blob，所以这不是只能
由特定浏览器触发的类型层假设。

精确反例调用序列：

1. host 返回一个大于 512 的 `image/webp`，文件名为 `secret.webp`；
2. low 路径调用 `platform.encode(..., 'image/webp')`；
3. 编码平台回退并返回 `Blob { type: 'image/png' }`；
4. 第 100 行仍返回 `mimeType: 'image/webp'` 与原 `.webp` 文件名；
5. `prepareDeepSeekImageBatch([image])` 收到 PNG bytes，却按 WebP 元数据上传。

这违反“尺寸/字节与上传元数据一致”。当前测试只用 `image/png` 输入和 `image/png` 编码结果，不能捕获该
分支。应在 resize 边界验证 `data.type === source.mimeType` 并明确失败，或统一采用实际 Blob MIME 且同步
修正文件名；同时增加编码器返回不同 MIME 的测试。

### Important 2：workspace 图片读取错误绕过安全错误边界，可原样泄露外部路径

位置：`apps/web/src/vision/deepseekImageViewer.ts:32-35`

读取发生在任何 `try/catch + safeFailure` 之前。除明确的静态宿主错误外，host/bridge 返回的任意错误文本
都会原样穿过 app port 和 ToolContext。实现因此没有兑现“外部路径不进错误/日志”；现有测试只覆盖了
“未提供命令桥”这一个安全固定文案。

精确反例调用序列：

1. Auto 会话调用 `viewImage({ path: '/outside/private/secret.png', detail: 'low' })`；
2. 受管 `readWorkspaceImage` 合法收到外部路径，但 host 拒绝读取并抛出
   `Error('cannot read /outside/private/secret.png')`；
3. 第 33 行的 await 直接 reject；
4. 该错误未经 `safeFailure` 进入工具错误/UI，绝对路径原样可见。

应给读取阶段增加独立的固定错误映射，保留 Abort/stale 语义，并把“当前宿主未提供命令桥”映射成不含
路径的明确静态宿主错误；增加一个 host 错误含绝对路径的脱敏测试。

## 验收标准逐条判定

1. ✅ 报告所列定向 vitest 命令：5 个文件、14 项通过；按要求本次未重跑。测试覆盖 low/high、隔离
   body、成功/模型失败/取消清理、stale/abort、权限注入和静态宿主错误。不过上面两项反例没有被现有
   测试覆盖。
2. ❌ 任务原文的 `pnpm exec tsc -b packages/agent-core/tsconfig.json apps/web/tsconfig.json` 没有
   通过：`apps/web/tsconfig.json` 不存在；继续执行还受范围外 `*.md?raw` TS2307 影响。报告中的两个
   实际配置隔离检查通过，但不能把原验收命令记为通过。⚠️ 这是任务配置/既有构建图问题，不是本 diff
   新增的 050 类型错误。
3. ✅ 指定行数验收满足：`visionCapabilities.ts` 39 行，app vision 源码 89/104 行、测试 156/63 行；
   文件均低于 300 行，职责分别为 core 能力装配、图像预处理、DeepSeek 观察编排，单一且清楚。
4. ✅ 报告称指定范围 `git diff --check` 以及 6 个未跟踪文件逐一 `--no-index --check` 均通过；本次
   未重跑。

⚠️ `packages/agent-core/src/tools/types.ts` 当前 352 行，超过普通文件 300 行上限。报告说明它在基线已
309 行且由 030 并行增加 workspace image 类型；050 是在 canonical ToolContext 上的小改，依规则本次
不顺手做范围外重构，但该存量超限仍需记录。

## C-006 / C-007 / C-008

### C-006：❌

- low 分支按长边等比缩入 512×512，`1600×900 → 512×288`；包围盒内保留原始 bytes 可接受。
- 未显式传 detail 时运行时代码也会落入非-high 的 low 分支；公开类型把 detail 设为必填，真正 schema
  默认值仍由 060 注册层负责，这一点不构成 050 阻断。
- 但重编码 Blob 的实际 MIME 与上传元数据未校验，故端到端 low 语义不完整，见 Important 1。

### C-007：✅

`high` 在像素 decode 之前直接从 host base64 构造 Blob，bytes、host MIME、文件名原样交给上传，完全
不经过 canvas。测试也断言 decode/encode 均为 0 次。

### C-008：❌

- ✅ core port 保持厂商中立；core diff 没有 DeepSeek 字面量或 provider import。app 仅得到
  `signal`、`assertFresh` 和受 workspace guard 保护的 `readWorkspaceImage`，Auto 外部只读权限仍由
  core 注入，调用方传入的权限字段会被覆盖。
- ✅ app 使用固定 `DEEPSEEK_VISION_MODEL`（010 契约为 `deepseek-v4-flash-vision-exp`），请求只含
  当前一条 user message 与本次 file block；实际 fetch body 测试确认无主历史、`tools`、
  `tool_choice`、`detail`。输出同时校验非空字符串 content 和实际 response model。
- ✅ Files API 交给 010 已审通过的 `prepareDeepSeekImageBatch`，由其提供 `purpose=user_data` 上传和
  `file_id` block；050 没有伪传 detail。
- ✅ helper 返回 batch 后，成功、无效响应、模型失败、Abort/stale 均进入 `finally` 的 best-effort
  rollback；DELETE 失败被吞掉且不遮蔽主结果。上传阶段部分成功回滚由 010 helper 契约负责；本调用
  实际只有一个文件。
- ✅ API key、file_id 不进入 050 固定错误且实现没有日志；静态宿主缺桥在上传前明确失败。
- ❌ 读取阶段错误未脱敏，可能把外部绝对路径送入错误，见 Important 2。
- ✅ main 在 `resolveHost` 与 `registerHostCommandBridge` 之后创建受管 fetch 并同步注入 viewer，且在
  persistence hydrate/恢复 run 之前完成；构造 viewer 不发请求。报告测试全部使用注入 fetch，没有
  真实联网。

## 修复后最小复审要求

1. resize 对编码结果 MIME 做一致性处理，并补“请求 WebP、编码器返回 PNG”的测试；
2. 图片读取阶段固定映射非生命周期错误，同时保留明确的静态宿主错误，补含绝对路径错误的脱敏测试；
3. 重跑 050 定向测试与有效的两个隔离 typecheck；任务树还需另行修正不存在的 web tsconfig 验收路径，
   才能让原第 2 条形式验收变绿。

---

## R1 独立复审

### R1 结论

**APPROVED**

本结论取代首轮 `REJECTED`；首轮内容保留为审计记录。2 个 Important 均已关闭，没有发现新的
Critical / Important / Minor。R1 只读取更新后的任务、执行报告、首轮 review 和同范围当前 diff，
没有重跑报告声称已运行的测试，也没有修改产品代码。

### Important 1 关闭：low MIME fail-closed

✅ `apps/web/src/vision/resizeVisionImage.ts:93-103` 在 canvas 编码完成后、返回
`DeepSeekLocalImage` 前比较实际 `data.type` 与 `source.mimeType`；不一致固定抛出
`重编码图片格式与原图不一致`。因此错误编码产物不可能进入 `prepareDeepSeekImageBatch`，也不会携带
原请求 MIME/文件名上传。

✅ `resizeVisionImage.test.ts:74-84` 构造 WebP 请求、PNG Blob 返回的精确反例，断言在目标尺寸
`512×256` 已计算后仍 fail-closed，并关闭 decoded surface。

✅ `deepseekImageViewer.test.ts:177-200` 把同一真实 resize 反例串入 viewer，断言对外是固定预处理
失败文案，且注入 `fetchImpl` 为 0 次调用；这个 fetch 同时承载 Files API 与 chat transport，所以可确认
上传和模型请求均未发生。

✅ 正常同 MIME 路径没有被误拒绝：`resizeVisionImage.test.ts:37-50` 同时断言实际 Blob type、返回
`mimeType`、文件名、`512×288` 尺寸以及 encode 请求 MIME 全为一致的 PNG 元数据；包围盒内 low 仍保留
原字节且不重编码。

### Important 2 关闭：读取阶段固定脱敏

✅ `apps/web/src/vision/deepseekImageViewer.ts:33-40` 已把 `readWorkspaceImage`、紧随其后的
`assertFresh` 与 abort 检查整体放入第一层安全边界。`safeFailure` 对任意非 Abort/精确 stale 错误完全
丢弃原消息，固定返回 `当前宿主不支持读取图片`；所以绝对路径、API key、file id 即使同时出现在 host
错误中也没有输出通路。

✅ `deepseekImageViewer.test.ts:138-160` 的外部绝对路径反例断言固定文案、原路径与底层文本均不存在，
并明确断言 `resizeImage` 和 `fetchImpl` 都为 0 次调用。静态无桥错误也在
`deepseekImageViewer.test.ts:122-136` 上传前映射成同一明确固定错误，不再透传 bridge 内部文案。

✅ `deepseekImageViewer.test.ts:162-175` 分别以同一个 `DOMException('AbortError')` 与
`Error('stale')` 对象作为读取 rejection，并用对象同一性 `toBe` 证明生命周期错误对象/语义未被固定
错误替换；读取失败时同样没有 fetch/upload。

### 覆盖矩阵回归核对

- **C-006：✅** low 仍按长边等比缩入 512×512，包围盒内保留原 bytes；新增 MIME 校验使实际
  重编码 bytes、请求/返回 MIME、文件名和尺寸元数据在 Files API 前闭合。WebP→PNG fallback 明确
  fail-closed，fetch/upload 为 0。
- **C-007：✅** `resizeVisionImage.ts:71-75` 的 high 分支仍在 decode/canvas 前从 host base64 构造
  Blob 并返回 host MIME/文件名；首轮的原字节与 decode/encode 0 次测试保持不变。
- **C-008：✅** 读取错误边界已关闭脱敏缺口；固定模型、单轮无主历史、无 `tools/tool_choice/detail`、
  响应 content/model 校验、成功/模型失败/取消/stale 的 finally rollback、上传部分失败继承 010
  rollback、静态宿主明确失败、core 中立窄能力与 main 装配时序均未回退。

### R1 验收判定

1. ✅ 报告称定向命令更新为 5 个文件、18 项测试全部通过；聚焦 vision 两文件为 13 项通过。本轮按要求
   未重跑。
2. ✅ 更新后的任务允许组合 typecheck 只剩明确记录的共享 worktree 前置错误；报告记录组合检查只剩
   `*.md?raw` TS2307，两个有效隔离 typecheck 均 exit 0。⚠️ 共享 ambient declaration 问题在本 diff
   外，未作为 050 阻断。
3. ✅ R1 后 core 装配 39 行，app 源码 94/107 行，测试 221/86 行，均小于 300 行；三份实现文件职责
   仍分别是 core 能力装配、图片预处理、隔离视觉编排，没有职责漂移。
4. ✅ 报告称指定范围 diff check 与 6 个未跟踪文件逐一 no-index check 均无 whitespace diagnostics；
   本轮未重跑。

⚠️ `packages/agent-core/src/tools/types.ts` 352 行的既有/并行超限记录仍成立，但 R1 没有继续改动该文件，
不影响本轮批准。
