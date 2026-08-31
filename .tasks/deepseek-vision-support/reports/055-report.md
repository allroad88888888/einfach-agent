# 055 执行报告：统一静态图片门禁

## 摘要

- 新增 app 中立 `imageInput/staticImagePolicy.ts`，成为 Composer 与 `view_image` 唯一共享的静态图片
  owner。它在像素完整解码前从 JPEG、PNG、WebP 容器取得固有尺寸，并拒绝动画、未知尺寸、结构畸形及
  调用方尺寸预算外输入；模块不含 UI 文案或 DeepSeek 分支。
- Composer 删除原先分散的魔数、浏览器尺寸 decode 与 UI animation detector，直接用共享 policy 返回的
  width/height 建立附件；原有无效格式、动图、宽高、体积、批次数量和草稿保留提示语义保持。
- `resizeVisionImage` 在 low/high 分支前执行同一 policy。high 不做像素 decode/重编码，返回原 Blob 逐字节
  不变且 width/height 必填；low 在 decode 后要求实际尺寸与容器元数据完全一致，再决定保留原字节或缩入
  512×512 包围盒。
- viewer 增加 APNG、WebP `ANIM`、WebP `VP8X` animation flag 与 8192×8192 high 的反例；全部在
  `prepareDeepSeekImageBatch` 前失败，承载 Files/chat 的注入 fetch 调用数为 0。

## 容器解析安全说明

- 所有 16/32 位字段均通过 `DataView.getUint16/getUint32` 按格式指定端序无符号读取；24 位 WebP 尺寸用
  逐字节乘法组合，不使用会符号扩展的 chunk 长度位运算。
- 每次读取前统一用 `offset <= byteLength` 与 `length <= byteLength - offset` 检查剩余区间；PNG chunk、
  JPEG segment、WebP chunk/padding 均在验证后才推进 offset，避免先相加造成整数绕回或越界。
- PNG 要求正确签名、首块且唯一的 13-byte IHDR、合法 color mode/compression/filter/interlace、IDAT、
  零长度尾部 IEND；读取 IHDR width/height，并将 `acTL`、`fcTL`、`fdAT` 视为动画。
- JPEG 从 SOI 开始安全遍历 marker/segment length，拒绝截断、重复 SOI、在 SOF 前进入 SOS/EOI；从合法
  SOF marker 的无符号字段取得 width/height，并校验 component count 与 SOF 长度一致。
- WebP 要求 RIFF 声明长度与 Blob 精确一致，逐 chunk 校验 header、无符号 payload length、偶数字节
  padding 和尾部闭合；分别解析 VP8 frame header、VP8L packed dimensions、VP8X canvas dimensions，
  且拒绝重复/冲突尺寸、VP8X 非首块、reserved flag、重复 image data。`ANIM`、`ANMF` 或 VP8X animation
  bit 任一出现均视为动画。
- policy 统一验证 width/height 为正安全整数，并执行调用方 `maxWidth/maxHeight`；读取失败、未知 MIME、
  MIME/签名不符、无尺寸及所有结构错误均映射成 `StaticImagePolicyError('invalid')`，不会降级放行。

## 逐条验收

1. 聚焦 Vitest：
   `pnpm exec vitest run apps/web/src/imageInput apps/web/src/vision apps/web/src/agentNew/ui/imageAnimationDetector.test.ts apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts`
   - exit 0；4 个测试文件、53 项测试全部通过。旧 detector 测试路径已删除，Vitest 继续执行其余指定目录与
     Composer 测试，没有 no-test 失败。
   - 覆盖 PNG/JPEG/WebP 静态正向、JPEG SOF、WebP VP8/VP8L/VP8X 三条尺寸路径、APNG/WebP 动画、
     uint32 chunk 越界、截断/未知尺寸、尺寸上限、low decode 元数据不一致和 Composer 回归。
2. viewer 反例：同一聚焦命令通过；APNG、`ANIM`、VP8X animation bit 各自 low/high 均固定预处理失败，
   8192×8192 high 同样失败；每例注入 fetch 均为 0，故 Files 与 chat 都未发生。
3. app 类型检查：`pnpm exec tsc -p tsconfig.app.json --types vite/client,node` → exit 0。
4. 行数：`wc -l apps/web/src/imageInput/*.ts apps/web/src/vision/*.ts
   apps/web/src/agentNew/ui/composerImageAttachmentState.ts
   apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts` → 最大为 policy 262 行、viewer test 255 行；
   所有普通文件均不超过 300 行。policy 只负责容器元数据静态门禁，测试 fixture 只负责构造容器样本。
5. whitespace：`git diff --check -- apps/web/src/imageInput apps/web/src/vision apps/web/src/agentNew/ui` →
   exit 0；三个未跟踪 imageInput 文件及任务涉及的未跟踪 vision 文件另逐个执行
   `git diff --no-index --check /dev/null <file>`，无 whitespace diagnostics。

## 覆盖矩阵证据

### C-005：Composer 静态图片门禁

- `composerImageAttachmentState.ts` 唯一调用 `inspectStaticImage(file, file.type, limits)`，不再自有签名、动画
  parser 或浏览器尺寸 owner；policy 的 `animated` / `dimensions` / `invalid` code 分别投影回既有 UI 文案。
- Composer 现有 JPEG/WebP 接受、伪 MIME、APNG、width/height 边界、批次和附件保留测试全部通过。

### C-006：low 门禁与 512 缩放

- policy 在 `detail` 分支前运行；APNG、ANIM、VP8X flag 低档均在 decode/upload 前拒绝。
- 1600×900 仍重编码为 512×288；400×300 仍保留原字节。low decode 得到 1600×899 而容器声明
  1600×900 时 fail-closed，且不调用 encoder；WebP 请求却返回 PNG 的 MIME fallback 仍 fail-closed。

### C-007：high 原字节与真实尺寸

- 合法 4096×2160 high 返回 `{width:4096,height:2160}`，不调用 decode/encode，Blob bytes 与 host bytes
  逐字节相同。
- 8192×8192 high 由 policy 直接拒绝；width/height 已从可选改为 `ResizedVisionImage` 必填字段，不再以
  `undefined ?? 0` 绕过后续 Files 限制。

### C-008：违规输入零上传

- viewer 的 7 组串联反例覆盖三类动画各 low/high 及超尺寸 high；所有结果均在 resize 安全边界失败，
  注入 fetch 为 0，因此没有临时 file id，也没有 chat 请求或需补偿的远端文件。
- 既有成功/失败/Abort/stale cleanup、读取错误脱敏和隔离请求测试继续通过，取消与清理语义未回归。

## 删除项与可恢复性

- 删除 `apps/web/src/agentNew/ui/imageAnimationDetector.ts`：其 PNG/WebP parser 已由更严格的共享 policy
  取代；不保留无职责 re-export shim，也不存在 vision 反向依赖 UI。
- 删除 `apps/web/src/agentNew/ui/imageAnimationDetector.test.ts`：相同动画场景迁入共享 policy 单测，并在
  resize/viewer 增加 low/high 上传前反例。
- 两个删除项都是 Git 跟踪源码/测试，可从仓库历史恢复；未删除用户数据、远端文件或不可恢复资产。

## 未验证与范围外

- 未连接真实 DeepSeek 服务、未真实上传文件；任务禁止未授权联网，Files/chat 均由注入 fetch 验证。
- 未在真实浏览器对三种格式做 GPU/canvas 像素冒烟；low 的 decode/encode/close、尺寸一致性和 MIME
  fallback 由注入 platform 验证，浏览器实现通过 app TypeScript 检查。
- GIF、动画解码/帧预算与 Responses API 明确不在本叶范围，没有新增支持或协议分支。
- 工作区仍有大量并行在途改动，`apps/web/src/vision/` 也是 050 的未跟踪上游内容；本叶只增量叠加任务
  files，没有 reset、checkout、暂存或提交。i18n 等范围外改动均保留，未擅自处理。

## 回执（四态）

- 实现：完成
- 聚焦验证：完成（53/53）
- app 类型/结构门禁：完成
- 范围外变更：未处理，已保留

---

## R1 修复摘要

本节取代首轮报告中对容器“所有结构错误均拒绝”的过度结论。055 review 的 I-1～I-3 已关闭：

- `staticImagePolicy.ts` 从 262 行解析器拆成 69 行中立 dispatch/统一 error/limits owner；JPEG、PNG、WebP
  分别由独立 parser 负责，`boundedImageBytes.ts` 只提供有界无符号读取。Composer 与 vision 的公共入口仍是
  `inspectStaticImage`，没有复制解析器或产生 UI 反向依赖。
- JPEG 读到 SOF 后只保存尺寸，必须继续遇到合法 SOS 并将所有 scan 走到尾部精确 EOI 才成功。entropy
  扫描正确跳过 `ff 00` stuffing、RST0～RST7 与连续 `ff` fill，遇到下一 SOS/有长 marker 后继续验证，
  支持 progressive 多 scan；SOF 后 EOF、scan/segment 截断、无 SOS/EOI 均 fail-closed。
- PNG fixture 为每个 chunk 生成真实 CRC32，且测试用 IEND 固定 CRC `ae 42 60 82` 交叉确认；parser 对每个
  type+payload 计算 CRC32 并与 big-endian 字段比较，然后才消费 IHDR/acTL/IDAT/IEND。review 的全零 CRC
  PNG 在读取 IHDR 尺寸前即拒绝。
- WebP 的 VP8 现在要求 key frame、version 0～3、`show_frame=1`、start code、零 scale bits，且 first
  partition length 不超过剩余 payload；VP8L 要求 version bits 为 0；VP8X 除 flags reserved bits 外还要求
  三个 reserved bytes 为 0。
- WebP extended 路径按官方必要容器规则 fail-closed：VP8X 必须首块；ICCP/ALPH/EXIF/XMP/animation flags
  必须与实际 chunk 一致；这些 chunk 与静态 VP8/VP8L 或 ANIM+ANMF 的顺序、唯一性和互斥形态受检。
  ANMF 还验证画布范围、frame reserved flags、内嵌 ALPH/VP8/VP8L 的闭合与 frame 尺寸。

## R1 I-1～I-3 逐条关闭

### I-1：JPEG SOF 后截断

- review 精确 hex `ff d8 ff c0 ... 01 11 00` 现在返回 `StaticImagePolicyError('invalid')`。
- 正向测试证明 baseline JPEG 只有在 SOF、SOS、entropy、EOI 全部闭合后才返回 1600×900；另一正向覆盖
  progressive 两个 scan、`ff00`、RST0 与 fill bytes。
- 同一 review bytes 通过 viewer `detail:'high'` 串联时固定预处理失败，注入 Files/chat fetch 为 0。

### I-2：WebP 必需未压缩 header 与 feature 一致性

- review 的 VP8 inter-frame、VP8L non-zero version、VP8X non-zero reserved byte 三组精确 hex 均返回
  `invalid`，并分别在 viewer high 下断言 fetch 为 0。
- 合法 VP8、VP8L、VP8X 三条尺寸路径仍分别返回 800×600、1600×900、1024×512。
- 新增 extended 正向包含一致的 ICCP+ALPH+VP8+EXIF+XMP；反例覆盖缺 ICCP flag 对应块、metadata 逆序、
  duplicate XMP、animation 缺 frame、duplicate simple image，全部 fail-closed。
- 完整 ANIM+ANMF 与 VP8X animation flag 仍映射为 `animated`，原 low/high 零上传矩阵保持。

### I-3：PNG chunk CRC

- review 的 IHDR/IDAT/IEND CRC 全零精确 bytes 现在返回 `invalid`，viewer high 的 fetch 为 0。
- 所有 PNG/Composer/resize/viewer fixture 已切换真实 chunk CRC；4096×2160 静态 PNG、CRC 正确的 APNG
  `acTL`、width/height 边界与 Composer 既有格式/尺寸/草稿测试继续通过。

## R1 验收结果

1. `pnpm exec vitest run apps/web/src/imageInput apps/web/src/vision
   apps/web/src/agentNew/ui/imageAnimationDetector.test.ts
   apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts`
   - exit 0；7 个测试文件、73 项测试全部通过。
   - 保留首轮 APNG、animated WebP、8192×8192 high、1600×900→512×288、low 原字节、high 原字节+
     必填尺寸、decode 元数据不一致、WebP→PNG MIME fallback、Abort/stale/cleanup、Composer 回归。
   - 新增 review 5 个精确 malformed 容器的 policy 拒绝和 viewer high fetch=0。
2. `pnpm exec tsc -p tsconfig.app.json --types vite/client,node` → exit 0。
3. `wc -l apps/web/src/imageInput/*.ts apps/web/src/vision/*.ts
   apps/web/src/agentNew/ui/composerImageAttachmentState.ts
   apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts`
   - 最大为 `deepseekImageViewer.test.ts` 274 行；fixture 196、WebP parser 190、JPEG parser 146、PNG parser
     102、dispatch 69、bounded reader 69，全部普通文件不超过 300 行且职责按格式独立。
4. `git diff --check -- apps/web/src/imageInput apps/web/src/vision apps/web/src/agentNew/ui` → exit 0；所有
   未跟踪 imageInput/vision 任务文件另逐个执行 `git diff --no-index --check /dev/null <file>`，无
   whitespace diagnostics。
5. `rg -n "imageAnimationDetector|isAnimatedImage" apps/web/src --glob '*.ts' --glob '*.tsx'` → 无命中；
   旧 UI detector 删除与共享 owner 边界未回归。

## R1 C-005～C-008 证据

- C-005：Composer 继续唯一消费共享 policy；review JPEG/PNG malformed 不再成为附件，合法 JPEG/PNG/WebP、
  动画提示与宽高提示回归全绿。
- C-006：low 在 pixel decode 前获得已闭合容器结论，之后继续验证 decode 尺寸一致并缩入 512 包围盒；
  原动画/超尺寸/MIME fallback 门禁保持。
- C-007：合法 high 仍逐字节返回原 Blob 并携带必填固有尺寸；I-1～I-3 的 malformed high 均在返回前拒绝。
- C-008：首轮 7 组动画/超尺寸零 fetch 与 R1 5 组 review malformed high 零 fetch 同时通过，违规输入的
  Files/chat 上传面闭合；既有成功/失败/取消清理测试未回归。

## R1 未验证与范围外

- 按修复边界未完整验证 PNG deflate 数据、JPEG entropy 编码语义或 VP8/VP8L 压缩 payload；已验证容器
  闭合、CRC、marker/chunk 边界与任务要求的所有必需未压缩 header，low 的真实浏览器 decode 仍是二次门。
- 未连接真实 DeepSeek 服务或真实上传文件；全部网络证据来自注入 fetch，符合任务禁止未授权联网的约束。
- GIF、Responses API、core/tool/agent-ai、路由与协议层均未扩大；工作区其它并行在途改动保持原样。
- 首轮删除的 UI detector 源码/测试仍可从 Git 历史恢复；R1 未新增删除项，也没有不可恢复数据操作。

## R1 回执（四态）

- 实现：完成（I-1～I-3 已修复）
- 聚焦验证：完成（73/73）
- app 类型/结构门禁：完成
- 范围外变更：未处理，已保留

---

## R2 修复摘要

本轮只关闭 R1 review 的 I-4/I-5，没有扩大到 JPEG entropy、PNG deflate 或其它压缩流语义：

- JPEG `readStartOfFrame` 对每个 component descriptor 继续要求非零且唯一的 component id，并新增
  horizontal/vertical sampling nibble 各在 1～4、quantization table selector 在 0～3 的固定字段检查。
- PNG parser 保留 IHDR `bitDepth`；indexed color type 3 的 PLTE 除既有非空、三字节对齐、≤256 entries
  外，现在还要求 `entries <= 2 ** bitDepth`。
- review 的两组完整闭合 JPEG 与一组 CRC 正确 indexed PNG 已加入共享 fixture，因此 policy、Composer、
  viewer high 三层使用完全相同的精确 bytes。

## R2 I-4/I-5 逐条关闭

### I-4：JPEG SOF component 固定字段

- review `sampling=00` 完整 JPEG 返回 `StaticImagePolicyError('invalid')`；合法 `sampling=11` 但
  `Tq=04` 的第二组完整 JPEG也返回 `invalid`。
- Composer 对两组文件都保持附件数组为空并显示既有“不是有效的图片文件”文案。
- viewer 对两组 `detail:'high'` 均在 resize policy 阶段固定失败，承载 Files/chat 的注入 fetch 为 0。
- 原合法 JPEG、progressive 多 scan、SOS/EOI 闭合、stuffing/RST/fill、首轮 SOF 截断拒绝均继续通过。

### I-5：indexed PNG palette 上限

- review 的 1×1、bit depth 1、color type 3、3-entry PLTE 精确 bytes（四个 chunk CRC 均正确）现在返回
  `StaticImagePolicyError('invalid')`。
- Composer 对同一 File 不建立附件；viewer high 在上传前失败且 fetch 为 0。
- 正向 fixture 证明 bit depth 1 的最大 2-entry PLTE 被接受并返回 1×1；首轮真实 CRC、APNG、尺寸边界与
  chunk 越界测试保持通过。

## R2 验收结果

1. `pnpm exec vitest run apps/web/src/imageInput apps/web/src/vision
   apps/web/src/agentNew/ui/imageAnimationDetector.test.ts
   apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts`
   - exit 0；7 个测试文件、86 项测试全部通过。
   - R2 三组精确 bytes 各自覆盖 policy invalid、Composer invalid、viewer high fetch=0；R1 与首轮全部测试
     同时保留。
2. `pnpm exec tsc -p tsconfig.app.json --types vite/client,node` → exit 0。
3. `wc -l apps/web/src/imageInput/*.ts apps/web/src/vision/*.ts
   apps/web/src/agentNew/ui/composerImageAttachmentState.ts
   apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts`
   - 最大为 viewer test 274 行；fixture 236、WebP parser 190、JPEG parser 153、PNG parser 104、Composer
     source 195/test 180，其余更小；全部普通文件不超过 300 行且职责未漂移。
4. `git diff --check -- apps/web/src/imageInput apps/web/src/vision apps/web/src/agentNew/ui
   .tasks/deepseek-vision-support/reports/055-report.md` → exit 0；未跟踪任务文件另逐个执行
   `git diff --no-index --check /dev/null <file>`，无 whitespace diagnostics。

## R2 C-005～C-008 证据

- C-005：共享 owner 新增的 JPEG/PNG 固定字段约束由 Composer 直接消费；三组 R2 malformed 均不成为附件。
- C-006：同一前置 policy 在 low pixel decode 前执行；原缩放、尺寸一致、动画与 MIME fallback 测试全绿。
- C-007：合法 high 原 bytes/必填尺寸不变；R2 malformed high 不再从 resize 返回。
- C-008：R2 三组 viewer high 反例 fetch 均为 0；首轮/R1 零上传、隔离调用与 cleanup 测试未回归。

## R2 未验证与范围外

- 按任务边界未完整验证 JPEG entropy 或 PNG IDAT deflate；本轮只验证 review 指定的 SOF component 与
  IHDR/PLTE 固定未压缩字段。
- 未连接真实 DeepSeek 或执行真实 Files 上传；所有网络反例使用注入 fetch。
- WebP、GIF、Responses、core/tool/agent-ai、路由和协议层没有新增改动；其它并行在途内容保持原样。

## R2 回执（四态）

- 实现：完成（I-4/I-5 已修复）
- 聚焦验证：完成（86/86）
- app 类型/结构门禁：完成
- 范围外变更：未处理，已保留
