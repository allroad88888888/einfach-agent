# 080 DeepSeek Vision 覆盖审计报告

> **R1 supersession（2026-08-21 21:30 CST）**：下方“初次审计”中的 APPROVED 已被
> `080-review.md` 的 I-1 正式推翻，不再是有效结论。本节是在 055 R2 修复和独立 APPROVED 后亲自重跑的
> 最终审计；本报告的唯一有效结论以本节为准。

## R1 最终结论

**APPROVED，建议收口。** 旧 I-1（APNG、animated WebP、超尺寸 high 可绕过上传前门禁）已由
Composer 与 vision 共用的中立静态容器 policy 闭合；C-001～C-011 当前均有实现、断言和本轮命令证据。
未发现 Critical / Important；仅保留一个不阻断的存量行数 Minor。

基线 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1`。本轮只读当前 index、010～070 report/review、055
最终 R2 与当前范围 diff；未改产品代码、任务文档或 Git 状态，唯一写入为本报告。

## R1 总门

| 门 | exit | 精确结果 |
|---|---:|---|
| `pnpm exec tsc -b` | 0 | 无诊断；旧 `*.md?raw` 共享构建图问题已闭合。 |
| `pnpm check:state` | 0 | 23 workspace、900 个非测试 TS/TSX、5 条规则通过。 |
| `pnpm check:boundaries` | 0 | 916 个非测试 TS/TSX、7 条规则通过；只有登记豁免观察项。 |
| 010～060 + 055 合并 Vitest | 0 | 先逐个 `test -f` 验证 61 个展开后的显式文件均存在；`61 passed`、`531 passed`，无 no-test 假阳性。集合含 DeepSeek/Kimi、三态 route、workspace read、Composer、runtime/tool、4 个静态容器测试。 |
| 055 精确静态门禁子集 | 0 | 4 个 imageInput + 2 个 vision + Composer 的 7 个显式文件，`7 passed`、`86 passed`。 |
| 清理生命周期补充 Vitest | 0 | `userInputTransaction` + `userContentDisposal`：2 文件、11/11 通过。 |
| `pnpm build` | 0 | `tsc -b`、Vite 1262 modules、server tsup/web embed 全通过；dynamic-import/chunk-size 仅警告。 |
| `git diff --check` | 0 | 整个 tracked dirty worktree 无 whitespace 诊断。 |
| 任务范围 untracked no-index | 0 diagnostics | 49 个未跟踪任务源/测试逐文件检查，无 whitespace 诊断（`git diff --no-index` 的“有差异”原始 exit 1 不误判为 whitespace 失败）。 |

共享 worktree 仍混有 model profiles、i18n、desktop 等并行在途内容，但本轮没有失败需要归因；build 警告
和 boundaries 观察项均为非失败输出。

## R1 C-001～C-011 证据矩阵

| ID | 判定 | 当前精确证据 |
|---|---|---|
| C-001 | ✅ | `deepseek.ts:21-42` 固定 vision ID/label；`builtinModelDescriptors.ts:112-121` 为 1M context、DeepSeek high/max thinking；`imageCapability.ts:34-44` 只收 JPEG/PNG/WebP，8 张、20/40 MiB、4096×2160。`deepseekCatalog.test.ts`、`imageCapability.test.ts`、`builtinThinkingCapabilities.test.ts` 随 531/531 通过。 |
| C-002 | ✅ | `deepseekFiles.ts:73-123` 固定官方 `/files`、Bearer、multipart `file` + `purpose=user_data`、校验 `file-api-*`；`:125-159` 部分失败/取消/rollback 无取消 signal DELETE。`deepseekMessages.ts:15-18,30-48` wire block 只有 `type/file_id`，无伪 `detail`；测试 `deepseekMessages.test.ts:23-60` 直接断言。`deepseekFileDisposal.ts:35-55` discarded-retained 差集 best-effort DELETE。 |
| C-003 | ✅ | browser `providerRoute.ts:49-71`、host `providerRouteCatalog.ts:34-61`、preview `model-preview-relay-routes.ts:67-89` 都只开放官方 origin 的 chat POST、multipart files POST、单 segment `file-api-*` DELETE，响应上限 32/4/1 MiB；三态测试覆盖 query/nested/空/过长/错 method/scope/extra key。 |
| C-004 | ✅ | `workspace-image-open.ts:30-58` 先拒绝非 Linux/macOS，再以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开并对原 handle `fstat().isFile()`；`workspace-image-handle-path.ts:54-73` 仅 Linux `/proc/self/fd/<fd>` 或 macOS 固定 `/usr/sbin/lsof -a -p <pid> -d <fd> -Fn`；`workspace-image-read.ts:63-138` 对 handle path 做 root confinement、随后只读同一 fd、limit+1 与 MIME 魔数检查。真实无 writer FIFO 有界拒绝在 `workspace-image-read.test.ts:137-170`；core 在 `workspaceImageRead.ts:87-117` 二次核对严格 base64/size/MIME。 |
| C-005 | ✅ | `providerImageBatch.ts:37-65` 保留精确 Kimi CN 与精确 DeepSeek vision 分派；`prepareProviderUserInput.ts:27-41` 上传 Composer 原 Blob；`disposeProviderUserContent.ts:18-30` 不按当前模型猜 owner；`historyImageCompatibility.ts:45-100` 分别隔离 Kimi `ms://`/region 与 DeepSeek scope/ID。Composer 在 `composerImageAttachmentState.ts:106-139` 唯一消费共享 policy；Kimi/DeepSeek/Composer 测试均在 531/531 内。 |
| C-006 | ✅ | `view-image.ts:4-24` schema 与执行默认均为 low；`resizeVisionImage.ts:73-86` 在 low/high 分支前执行共享 policy，`:88-115` 要求 decode 与容器尺寸一致、缩入 512 包围盒并对编码 MIME fail-closed。`resizeVisionImage.test.ts:47-71,85-105,107-135` 钉住 1600×900→512×288、包围盒内原 bytes、MIME/尺寸 mismatch、APNG/WebP animation 与超尺寸拒绝。 |
| C-007 | ✅ | `resizeVisionImage.ts:78-86` high 先经静态/尺寸 policy，再返回原 Blob 与固有 width/height；`resizeVisionImage.test.ts:74-83` 逐字节相等且 decode/encode 0 次，`:130-135` 证明 8192×8192 high 在 decode/upload 前拒绝。high 没有映射为 file_id `detail`。 |
| C-008 | ✅ | `deepseekImageViewer.ts:32-92` 只读显式 path、固定 vision model、只构造一条当前 user message，不传历史/tools/tool_choice，并在 `finally` rollback。`deepseekImageViewer.test.ts:34-75` 直接断言单 user、无 tools/tool_choice/detail；`:77-130` 成功失败/取消 DELETE；`:235-274` 初始 7 组 + 055 review malformed 全在 Files/chat 前 `fetch=0`。 |
| C-009 | ✅ | `view-image.ts:40-102` 只依赖 `ToolContext.viewImage` 并 fail-closed；`view-image.md:1-13` 指明 low/high 场景；`tools/standard/src/index.ts:13-44` 注册第 7 域，`index.test.ts:11-64` 权威清单精确 32、逐名、幂等、`view_image` replayUnsafe。 |
| C-010 | ✅ | `README.md:147-153`、`README.zh-CN.md:139-143` 同步模型名、Composer 原 bytes、Files API、low 512、high 场景/原像素与 best-effort 清理；本轮计数每份 README 各恰有 1 条官方 vision 与 files_api 直链。060 旧账本 Minor 也已由 `060-view-image-tool.md:21-22,79-80` 纠正根 `tsconfig.app.json`/`vite.config.ts` 归属。 |
| C-011 | ✅ | 本节全部总门 exit 0；61/531 聚焦与 2/11 清理测试均为真实执行，055 R2 独立审查 `055-review.md:250-300` 已 APPROVED。 |

## 旧 I-1 的关闭证明

- 旧 `080-review.md:5-8,22-69` 的 REJECTED 是有效历史裁决；它指出旧 high 在静态 policy 前返回、low
  只靠 browser decode，导致 APNG、animated WebP、8192×8192 high 可上传。旧 080 APPROVED 因而已
  superseded，不能作为本次批准依据。
- 当前共享入口 `staticImagePolicy.ts:38-68` 按 MIME 分派、拒动画和越界；PNG 在
  `pngStaticContainer.ts:53-96` 校 CRC/`acTL`/闭合，WebP 在 `webpStaticContainer.ts:122-190` 校
  RIFF/features/ANIM+ANMF，JPEG 在 `jpegStaticContainer.ts:50-72,111-153` 校 SOF 固定字段和 SOS/EOI。
- 055 两轮 review 反例继续保留：JPEG 截断/采样/Tq、PNG CRC/PLTE-depth、VP8/VP8L/VP8X 必需字段；
  policy 测试 `jpeg:17-34`、`png:17-44`、`webp:25-82` 通过。viewer 对同一 malformed bytes 的 high
  串联在 `deepseekImageViewer.test.ts:257-273` 固定 `fetch=0`。
- `055-review.md:254-300` 的最终 R2 结论为 APPROVED、无 Critical/Important/Minor；本次又把这 7 个
  055 文件纳入 61 文件总集重跑，得到 86/86 的子集保持及总计 531/531。

## R1 行数与职责

按 `one-file-one-thing` 的 `wc -l` 物理行口径复核：任务范围新增/大改普通文件均 ≤300；代表性上界为
`Composer.tsx` 293、`deepseek.test.ts` 280、viewer test 274。055 拆分后 fixture 236、WebP parser 190、
JPEG parser 153、PNG parser 104、dispatch/bounded reader 各 69；各格式解析、统一 policy、resize、viewer
职责分离，没有 `partN`/`utils` 假拆。

唯一 Minor：`packages/agent-core/src/tools/types.ts` 基线 309、当前 352（本树 +43），是已超限的 canonical
ToolContext 公共契约文件；本任务只叠加 workspace image/view image 能力，按“路过存量超限小改”单独披露，
不在只读审计中扩大重构。其余范围文件均不超限。

## R1 质量分级与收口

- Critical：无。
- Important：无；旧 I-1 已由 055 的共享静态 policy 和零上传反例闭合。
- Minor：1 项，即上述存量 `tools/types.ts` 行数债务；不阻断本次能力收口。

建议以本 R1 APPROVED 取代旧审计结论，完成 C-011 并收口；真实 DeepSeek 网络、PNG deflate/JPEG entropy
语义和 Linux 实机 `/proc` 仍是已声明的验证边界，不削弱当前 fail-closed 容器/上传契约。

## R1 可机械复现命令

```bash
pnpm exec tsc -b
pnpm check:state
pnpm check:boundaries
pnpm exec vitest run packages/agent-ai/src/*.test.ts \
  apps/web/src/modelTransport/{providerRoute,modelEndpoint,devPreviewModelTransport}.test.ts \
  packages/host-node/src/model/providerRoute.test.ts \
  scripts/model-preview-relay-routes.test.ts scripts/model-preview-relay.test.ts \
  packages/agent-core/src/runtime/{toolContext.workspace-image-read,workspace-image-read}.test.ts \
  packages/host-node/src/workspace/workspace-image-*.test.ts \
  packages/host-node/src/{commandNames,createNodeHostInvoke}.test.ts \
  apps/web/src/modelInput/{prepareProviderUserInput,disposeProviderUserContent}.test.ts \
  apps/web/src/agentNew/ui/{HistoryImageCompatibilityGuard,MessageTimelineRenderer.images}.test.tsx \
  apps/web/src/vision/*.test.ts packages/agent-core/src/runtime/toolContext/visionCapabilities.test.ts \
  apps/web/src/main.serverHost.test.tsx apps/web/src/imageInput/*.test.ts \
  apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts \
  tools/vision/src/view-image/view-image.test.ts tools/standard/src/index.test.ts
pnpm exec vitest run packages/agent-core/src/runtime/userInputTransaction.test.ts \
  packages/agent-core/src/runtime/userContentDisposal.test.ts
pnpm build
git diff --check
```

---

## 初次审计（历史记录，已被上述 R1 supersede）

## 结论

**APPROVED，建议收口。** C-001～C-011 均有当前实现、精确断言或本轮命令证据；全仓类型、状态、边界、
聚焦测试、生产构建与 whitespace 总门全部 exit 0。未发现 Critical / Important；记录 1 个非阻断 Minor：
`packages/agent-core/src/tools/types.ts` 是基线即超限的公共契约文件，基线 309 行、当前 352 行。

审计基线为 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1`，执行时间为 2026-08-21 20:20～20:24 CST。
本轮只读任务树、010～070 报告与全部 review、当前范围 diff（未跟踪文件按 no-index 读取）；未改产品代码
或任务文档，唯一写入即本报告。

## 总门结果

| 门 | exit | 本轮结果与归因 |
|---|---:|---|
| `pnpm exec tsc -b` | 0 | 无输出；早期报告中的 `*.md?raw` 共享前置错误在当前树已消失。 |
| `pnpm check:state` | 0 | 扫描 23 个 workspace、896 个非测试 TS/TSX，5 条状态规则通过。 |
| `pnpm check:boundaries` | 0 | 扫描 912 个非测试 TS/TSX，7 条规则通过；输出只有登记过的既有豁免观察项，没有 vision 新违规。 |
| 010～060 合并去重 Vitest | 0 | 33 个显式存在的测试文件、268 项测试全部通过；Vitest 输出 `33 passed (33)` / `268 passed (268)`，不存在 no-test 假阳性。 |
| 清理生命周期补充 Vitest | 0 | 2 文件、11 项通过，直接覆盖准备取消/提交拒绝 rollback 与 session/run 内容丢弃 disposer。 |
| `pnpm build` | 0 | `tsc -b`、Vite（1258 modules）和 server `tsup`/web embed 全通过；只有非失败的既有 dynamic-import/chunk-size 警告。 |
| `git diff --check` | 0 | 整个 tracked worktree 无 whitespace diagnostics。 |
| 范围未跟踪文件 no-index check | 0 | 对本树 38 个未跟踪源/测试/manifest 逐个 `git diff --no-index --check /dev/null <file>`，0 个 whitespace 问题。 |

共享 worktree 同时含 model profiles、i18n、desktop 等大量在途改动；本轮没有门失败，故没有需要归为
“本树缺陷 / 共享 worktree 在途问题 / 存量问题”的红项。build 警告与 boundaries 已登记观察项均不由
DeepSeek Vision 路径新增，也不影响 exit/result。

## C-001～C-011 覆盖矩阵

| ID | 判定 | 精确实现与断言证据 |
|---|---|---|
| C-001 模型目录与能力 | ✅ | `packages/agent-ai/src/deepseek.ts:21-42` 声明精确模型 ID/标签；`builtinModelDescriptors.ts:112-121` 声明 1M context、与现有 DeepSeek 相同的 high/max thinking；`imageCapability.ts:34-44` 只允许 JPEG/PNG/WebP，并声明 8 张、20/40 MiB、4096×2160。`deepseekCatalog.test.ts:12-29` 与 `imageCapability.test.ts:7-22` 钉住精确目录和非视觉模型不获图片能力。 |
| C-002 Files 上传/引用/清理 | ✅ | `deepseekFiles.ts:73-123` 固定官方 `/files`、Bearer、multipart `file` + `purpose=user_data`、校验 `file-api-*`；`:125-159` 在部分失败、取消与显式 rollback 时无取消 signal 地 best-effort DELETE。`deepseekMessages.ts:15-18,26-48` 的 wire file block 只有 `type/file_id`，无伪 `detail`，并校验 provider/scope/ID。`deepseekFileDisposal.ts:35-55` 对 discarded 去重并减 retained 后 DELETE。`deepseekFiles.test.ts:24-171`、`deepseekMessages.test.ts:22-101`、`deepseekFileDisposal.test.ts:19-66` 分别钉住上传、无 detail、部分失败/取消/幂等 rollback 与 retained 差集。 |
| C-003 三态 route | ✅ | browser `apps/web/src/modelTransport/providerRoute.ts:49-71`、host `packages/host-node/src/model/providerRouteCatalog.ts:34-61`、preview `scripts/model-preview-relay-routes.ts:67-89` 均只开放固定官方 origin 的 `POST /chat/completions`、multipart `POST /files` 和安全单 segment `DELETE /files/file-api-*`，响应上限一致为 32/4/1 MiB。三态测试分别在 `providerRoute.test.ts:73-108`、host `providerRoute.test.ts:20-108`、preview `model-preview-relay-routes.test.ts:13-58` 覆盖允许/拒绝矩阵、query/嵌套/空后缀/过长/错误 scope/额外字段。 |
| C-004 工作区安全读取 | ✅ | `workspace-image-open.ts:30-58` 在 pathname open 前拒绝非 Linux/macOS，并以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开、对原 handle `fstat().isFile()`；`workspace-image-handle-path.ts:54-73` 只从 Linux `/proc/self/fd/<fd>` 或 macOS 固定 `/usr/sbin/lsof -a -p <pid> -d <fd> -Fn` 解析 handle 路径，失败闭合；`workspace-image-read.ts:63-138` 用 handle path 做 root confinement，随后只读同一 handle，limit+1 增量读取并按魔数识别三种 MIME；core `workspaceImageRead.ts:87-117` 二次复核 20 MiB/调用上限、严格 base64、实际大小与 MIME 魔数。真实 FIFO/no-writer 回归在 `workspace-image-read.test.ts:137-170`，unsupported/open flags/非普通文件在 `workspace-image-open.test.ts:33-78`。命令名/参数/registrar/invoke 接线由 `commandNames.ts:46`、`commandArgs.ts:73`、`workspace/read/index.ts:19-24` 及对应测试覆盖。 |
| C-005 Composer/Kimi | ✅ | `providerImageBatch.ts:37-65` 保留 Kimi 精确模型、CN gate，同时只为精确 DeepSeek vision model 分派；`prepareProviderUserInput.ts:27-41` 上传 Composer 原 Blob 且不引入 detail UI；`disposeProviderUserContent.ts:18-30` 不依赖当前模型，让 Kimi/DeepSeek owner 各自检查旧引用；`historyImageCompatibility.ts:45-100` 保留 Kimi region/`ms://`，并只恢复精确 DeepSeek model/provider/scope/ID。`prepareProviderUserInput.test.ts:32-125` 同时钉住 Kimi 与 DeepSeek 原图/rollback；`disposeProviderUserContent.test.ts:30-136` 钉住切模型后 owner 清理和 retained 保护；`historyImageCompatibility.test.ts:25-71` 钉住两家历史隔离。 |
| C-006 low 默认 | ✅ | `tools/vision/src/view-image/view-image.ts:4-12,22-24,50-83` 令省略 detail 在 schema 与执行层都成为 `low`；`resizeVisionImage.ts:77-103` 先 decode 尺寸，超界等比缩入 512 包围盒，再把产物交给调用方；重编码后 `data.type !== source.mimeType` 在上传前 fail-closed。`deepseekImageViewer.ts:42-56` 明确先 resize、后 `prepareDeepSeekImageBatch`。`resizeVisionImage.test.ts:36-61,74-85` 断言 1600×900→512×288、包围盒内保留原 bytes、WebP→PNG 拒绝；`deepseekImageViewer.test.ts:177-200` 进一步断言 MIME mismatch 时 Files/chat fetch 为 0。 |
| C-007 high | ✅ | `resizeVisionImage.ts:71-75` 在任何 decode/canvas 前把 host base64 原字节装入同 MIME Blob 并直接返回；`resizeVisionImage.test.ts:64-72` 逐字节相等且 decode/encode 均 0 次；`view-image.test.ts:47-50` 证明 `high` 精确透传。没有把 high 转成 file_id `detail`。 |
| C-008 隔离视觉请求 | ✅ | `deepseekImageViewer.ts:32-92` 只读显式 path，固定 `DEEPSEEK_VISION_MODEL`，构造恰好一条当前 user message，不传主历史/tools/tool_choice，且 batch 后所有结果都在 `finally` rollback。`deepseekImageViewer.test.ts:25-120` 对实际 JSON 断言单 user、file block、无 tools/tool_choice/detail，并覆盖成功、无效响应、取消与 DELETE；`:122-175` 覆盖无宿主、外部路径错误脱敏及 Abort/stale 保留。core `visionCapabilities.ts:11-38` 只向 app port 暴露 signal/assertFresh/受管 read，测试 `:18-110` 钉住 Auto 权限注入、前后 stale/abort。`apps/web/src/main.tsx:161-203` 在 bridge 后、hydrate 前装配 viewer 与受管 provider fetch。 |
| C-009 标准工具注册 | ✅ | `view-image.ts:40-102` 只依赖 `ToolContext.viewImage`，缺能力/坏参数/坏返回 fail-closed；模型可见说明 `view-image.md:1-13` 明确普通图 low、OCR/小字截图/密集图表/精细比较 high。`tools/standard/src/index.ts:13-44` 注册并 re-export 第七个 vision 域；`index.test.ts:11-64` 权威清单精确 32、逐名存在、幂等且 `view_image` replayUnsafe。 |
| C-010 README | ✅ | `README.md:147-153` 与 `README.zh-CN.md:139-143` 同步模型名、Composer JPEG/PNG/WebP 原图、临时 Files API、low 512 包围盒、high 场景/原像素与 best-effort 清理。本轮 `rg -c` 证明每份 README 各恰有 1 条 `/zh-cn/guides/vision` 和 1 条 `/zh-cn/guides/files_api` 官方直链。未宣传 GIF、Responses API、64 MiB 或服务端 file_id detail。 |
| C-011 全链路总门 | ✅ | 上表全部仓库门 exit 0；聚焦 33/33 files、268/268 tests，无 no-test；补充清理契约 2/2 files、11/11 tests。 |

## 清理生命周期专项复核

- 上传阶段失败/取消：`deepseekFiles.ts:143-149` 等待全部上传 settle，收集成功项后 DELETE，再保留原失败或
  AbortError；`deepseekFiles.test.ts:83-139` 直接断言部分失败删两项、取消删已成功项。
- Composer 提交失败/取消：`preparedUserInputTransaction.ts:14-47,50-80` 对 commit rejection/throw 和
  preparation abort 调 prepared rollback；补跑 `userInputTransaction.test.ts:140-158,182-195,211-255`
  证明设置变更、run blocked、stopRun、removeSession 都 rollback。
- 已持久化内容丢弃：`userContentDisposal.ts:78-110` 计算全局 reachability 差集后调用 app disposer；补跑
  `userContentDisposal.test.ts:65-133` 证明 session remove/run stop 传 discarded + retained；app disposer
  再由 `disposeProviderUserContent.ts:27-30` 交 DeepSeek owner，最终 `deepseekFileDisposal.ts:41-54` DELETE。
- `view_image` 临时文件：上传后成功、无效响应、网络失败、Abort/stale 都经过
  `deepseekImageViewer.ts:61-92` 的 finally；DELETE failure 被吞掉且不遮蔽主结果。

## 可机械复现命令

```bash
pnpm exec tsc -b
pnpm check:state
pnpm check:boundaries

pnpm exec vitest run \
  packages/agent-ai/src/builtinThinkingCapabilities.test.ts \
  packages/agent-ai/src/deepseek.retry.test.ts \
  packages/agent-ai/src/deepseek.test.ts \
  packages/agent-ai/src/deepseekCatalog.test.ts \
  packages/agent-ai/src/deepseekFileDisposal.test.ts \
  packages/agent-ai/src/deepseekFiles.test.ts \
  packages/agent-ai/src/deepseekIdentity.test.ts \
  packages/agent-ai/src/deepseekMessages.test.ts \
  packages/agent-ai/src/imageCapability.test.ts \
  apps/web/src/modelTransport/providerRoute.test.ts \
  packages/host-node/src/model/providerRoute.test.ts \
  scripts/model-preview-relay-routes.test.ts \
  apps/web/src/modelTransport/modelEndpoint.test.ts \
  apps/web/src/modelTransport/devPreviewModelTransport.test.ts \
  scripts/model-preview-relay.test.ts \
  packages/agent-core/src/runtime/toolContext.workspace-image-read.test.ts \
  packages/agent-core/src/runtime/workspace-image-read.test.ts \
  packages/host-node/src/workspace/workspace-image-handle-path.test.ts \
  packages/host-node/src/workspace/workspace-image-open.test.ts \
  packages/host-node/src/workspace/workspace-image-read.test.ts \
  packages/host-node/src/commandNames.test.ts \
  packages/host-node/src/createNodeHostInvoke.test.ts \
  apps/web/src/modelInput/prepareProviderUserInput.test.ts \
  apps/web/src/modelInput/disposeProviderUserContent.test.ts \
  apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.test.tsx \
  apps/web/src/agentNew/ui/MessageTimelineRenderer.images.test.tsx \
  packages/agent-ai/src/historyImageCompatibility.test.ts \
  apps/web/src/vision/deepseekImageViewer.test.ts \
  apps/web/src/vision/resizeVisionImage.test.ts \
  packages/agent-core/src/runtime/toolContext/visionCapabilities.test.ts \
  apps/web/src/main.serverHost.test.tsx \
  tools/vision/src/view-image/view-image.test.ts \
  tools/standard/src/index.test.ts

pnpm exec vitest run \
  packages/agent-core/src/runtime/userInputTransaction.test.ts \
  packages/agent-core/src/runtime/userContentDisposal.test.ts

pnpm build
git diff --check
```

## 质量发现

### Critical

无。

### Important

无。

### Minor

1. `packages/agent-core/src/tools/types.ts` 当前 352 行，超过普通文件 300 行上限；基线实测已经 309 行，
   本树只在 canonical ToolContext 契约内追加 workspace image / view image 类型与两个可选能力。按规则这是
   “路过存量超限文件的小改”，不在本横切审计中扩大为公共类型拆分，也不阻断本次收口；建议后续独立按
   契约职责拆分，避免继续增长。

## 残余验证边界

- 按任务约束未调用真实 DeepSeek 网络；所有 Files/chat 行为都由注入 fetch 验证。
- 本机为 macOS；macOS 真实 handle path 与真实 FIFO 已运行，Linux `/proc/self/fd/<fd>` 在本轮是协议级
  单测而非 Linux 主机实跑。Linux 路径失败闭合、fd 数字校验和后续只读原 handle 的代码证据完整，不列为
  阻断项。
- GIF/动画与 Responses API 明确延期；当前实现与 README 都只承诺 JPEG/PNG/WebP Chat/Files 路径。

## 收口建议

建议将 C-011 标记完成并收口本任务树。没有需要返工的本树缺陷；唯一 Minor 是已披露的公共类型文件存量
行数债务，可独立排期，不应阻塞 DeepSeek Vision 交付。
