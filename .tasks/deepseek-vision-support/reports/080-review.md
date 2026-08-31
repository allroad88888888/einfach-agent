# 080 最终独立审查：DeepSeek Vision

## 结论

**REJECTED**。080 记录的 TypeScript、state、boundaries、268 项聚焦测试、补充清理测试、生产构建与
diff-check 证据本身足以证明机械总门当前为绿；三态路由、fd-bound confinement、provider/core/app/tool
分层、Files 生命周期、隔离调用和标准工具目录也都能从当前代码得到印证。但终审发现 1 个未被测试覆盖的
Important：`view_image` 绕过了产品已有的“静态图片 + 尺寸预算”门禁，使 APNG / animated WebP 和
超出声明尺寸的 high 图片仍可进入 DeepSeek Files API。该缺口与任务树明确延期动画支持的安全裁决冲突，
因此 C-006～C-008、C-010、C-011 不能按当前 080 结论收口。

审查基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`。本次读取了 index、010～080 全部任务、全部执行报告与
review，并审阅任务范围内 tracked diff；38 个未跟踪源/测试/manifest 以当前完整内容按 no-index 语义
审阅。没有重跑 080 已记录的测试、构建或门禁，没有修改产品代码；唯一写入是本报告。

## 质量发现

### Critical

无。

### Important

#### I-1：`view_image` 绕过既有静态图与像素尺寸门禁，动画/超预算 high 图片可被原样上传

精确位置：

- `packages/host-node/src/workspace/workspace-image-read.ts:46-59,130-137` 只按文件头魔数把输入归类为
  JPEG/PNG/WebP；返回契约没有固有宽高或动画状态。
- `apps/web/src/vision/resizeVisionImage.ts:71-75` 的 high 在任何图片检查/解码前直接返回原 Blob，且
  不带 width/height；`:77-91` 的 low 虽取得尺寸，但只要图片已落在 512 包围盒内就同样返回原 Blob。
  两条分支都不检查 PNG `acTL`、WebP `ANIM` 或 `VP8X` animation flag。
- `packages/agent-ai/src/deepseekFiles.ts:55-57` 仅在调用方提供 width/height 时才能兑现 4096×2160
  限制；high 的两个字段为 `undefined`，`?? 0` 令它静默通过。随后
  `apps/web/src/vision/deepseekImageViewer.ts:50-78` 会上传并发起隔离请求。

可复现的静态反例：

1. 工作区内放一张 400×300、含 `acTL` 的 APNG，调用 `view_image({path, detail:'low'})`。host 将其认作
   PNG；low 解出 400×300 后走“包围盒内保留原字节”，动画原文件进入 `POST /files`。
2. 对含 `ANIM` 或 `VP8X` animation bit 的 animated WebP 调 high。high 完全不检查容器，直接上传原字节。
3. 对 8192×8192 的静态 PNG 调 high。返回对象没有尺寸，adapter 的 4096×2160 门禁被 `undefined ?? 0`
   绕过，仍会上传原图。

这不是新增 GIF 能力的文字争议：现有 Composer 明确用
`apps/web/src/agentNew/ui/imageAnimationDetector.ts:8-34,47-52` 识别 APNG/animated WebP，并在
`composerImageAttachmentState.ts:166-180` 拒绝动画及超尺寸图片。⚠️ 这两个既有 UI 文件不属于本树
产品 diff，此处只把它们作为“继续沿用现有静态图片安全策略”的基线证据；实际缺口全部位于上述新增
vision 路径。任务 index 又明确因缺少动画解码与像素预算保护而延期动画支持，所以当前路径扩大了已裁决
的安全边界。README 所称 low 处理“static image”也无法保证，文档因而不再完全准确。

最小修复边界：

- 在 app 层抽取/复用一个 provider-neutral 的静态图片检查器，统一识别 APNG/animated WebP 并取得固有
  width/height；不要把图片解析或 DeepSeek 判断放入 core，也不要让工具包越过 `ToolContext`。
- `resizeVisionImage` 在 low/high 分支前执行该检查。high 仍返回逐字节相同的原 Blob，但携带真实尺寸，
  让既有 `prepareDeepSeekImageBatch` 限制生效；low 只对已确认的静态图执行保留或 512 缩放。
- 若复用当前 Composer 检查器，应把纯容器检查下沉到中立 app 模块供两处消费，避免 vision 反向依赖 UI
  或复制两份会漂移的动画解析器。

不扩域的验收边界：

- APNG `acTL` 与 animated WebP 的 `ANIM` / `VP8X` flag 分别在 low、high 下都于上传前拒绝，Files/chat
  fetch 均为 0；静态 PNG/WebP 正向不回归。
- high 超过 4096×2160 时上传为 0；合法 high 的输出 Blob 字节仍与 host 原字节完全相同。测试不应再把
  “未做任何元数据检查”误当成“原字节语义”的必要条件。
- 保留 1600×900 → 512×288、包围盒内 low、WebP→PNG MIME fallback fail-closed、取消/错误 cleanup
  及 Composer 现有动画拒绝测试；重跑 050/060 聚焦集、`tsc -b`、build 与 diff-check 即可，不需要扩大
  core、route 或工具协议。

### Minor

#### M-1：060 的文件账本漏记实际 vision 配置接线

⚠️ `060-view-image-tool.md` 列的是 `tsconfig.json`、`apps/web/package.json`、`apps/web/vite.config.ts`，
但当前真正的 feature diff 在根 `tsconfig.app.json:37` 与 `vite.config.ts:276`；两处都增加
`@einfach-agent/tools-vision`，产品内容正确且 080 的 build exit 0 已覆盖它们。060 执行报告准确声称更新
了根配置，060 review 却因按错误 frontmatter 路径取 diff 而称“本范围没有变化”，080 也未纠正归属。
这不构成产品阻断，但任务账本应在收口前记为精确范围修正，避免以后把必要接线误当作无关在途改动。

## 其余重点核对

| 重点 | 终审判定 | 代码与证据摘要 |
|---|---|---|
| DeepSeek descriptor / Files / file block | ✅ | 精确视觉模型、1M context、JPEG/PNG/WebP capability 成立；上传固定官方 `/files`、multipart `file` + `purpose=user_data`；wire block 仅 `{type:'file',file_id}`，无伪 `detail`。 |
| 上传与丢弃清理 | ✅ | 部分失败/取消等待 settle 后删除已成功项；rollback 不继承取消 signal 且幂等；discarded-retained 差集、viewer `finally` 与 best-effort DELETE 闭合。 |
| 三态白名单 | ✅ | browser、host、preview 只开放官方 DeepSeek 的 chat POST、multipart files POST 与单 segment `file-api-*` DELETE；method/scope/query/nested/extra-field 均失败闭合。 |
| workspace 路径/FIFO/错误 | ✅ | 支持平台在 open 前判定，`O_NOFOLLOW|O_NONBLOCK`，原 handle `fstat().isFile()`，Linux `/proc/self/fd` / macOS 固定 pid+fd lsof 得到 handle path 后 confinement，随后只读同一 handle；大小、base64、MIME 魔数由 host/core 双检。对 viewer 可见的读取错误固定脱敏。 |
| core/app/tool 分层 | ✅ | core 仅定义中立 `ViewImageCapability` 并提供 signal/fresh/受管读取；app 固定 DeepSeek；`tools/vision` 生产实现只依赖 `@einfach-agent/core/tools` 的 Tool/ToolContext。 |
| low/high/detail | ❌（I-1 外其余 ✅） | schema 与执行层省略值均为 low；low 超界缩入 512；编码 MIME 漂移上传前拒绝；high 字节保持；file_id 无 detail。静态/尺寸门禁缺口见 I-1。 |
| 隔离请求 | ✅ | 固定视觉模型，恰好一条当前 user message，无主历史、tools、tool_choice、detail；成功、失败、Abort/stale 均在上传后走 finally rollback。 |
| Composer/Kimi / 标准工具 | ✅ | 精确 provider-model dispatcher、Kimi CN/global/`ms://` 规则、owner-based disposer 与历史投影保持；标准目录为 7 域 32 工具，`view_image` replayUnsafe。 |
| 文档 | ❌（受 I-1 影响） | 模型名、Files API、low/high、格式、清理与 zh-cn 官方链接均正确；但实现不能保证文档中的 static 语义。 |
| one-file-one-thing | ✅ | 本树新增/大改普通源与测试均 ≤300 行且职责清楚。`packages/agent-core/src/tools/types.ts` 基线 309、当前 352，属于已披露的存量超限 canonical 契约小改；未以本任务顺手大拆，披露方式合规。`pnpm-lock.yaml` 属生成/锁数据例外。 |

## 080 总门证据评价

- `tsc -b`、state、boundaries、33 个文件 268 项测试、2 个清理文件 11 项测试、build、tracked
  diff-check 与 38 个未跟踪文件 no-index check 都给出了精确命令、exit 与非 no-test 数量；这些证据足以
  采信机械门为绿，早期 `*.md?raw` 前置错误也已由最终总门消失。
- 测试组合覆盖 Kimi/DeepSeek 上传、路由、fd/FIFO、core guard、隔离请求、MIME fallback、工具 32 项与
  清理 reachability，范围合理；Linux fd 仅协议测试而非 Linux 实机的限制已准确披露，可接受为 fail-closed
  路径的非阻断残余。
- 但现有 268/11 项没有 APNG、animated WebP 或 high 超尺寸反例。build/type/state/boundaries 无法发现这类
  语义缺口。因此这些绿色证据不能推导 C-011 完成，也不能支持 080 的“无 Important、建议收口”。

## 最终回执

REJECTED — 先让 `view_image` 复用静态图与尺寸门禁并补 low/high 的动画、超尺寸零上传反例，之后再做范围内最小复审。

---

## R1 最终独立复审（supersede 原 REJECTED）

### R1 结论

**APPROVED。** 本节明确取代上方历史 `REJECTED`；原 I-1 已由 055 的共享静态图片 policy、完整容器
fail-closed 校验和 Files/chat 零请求串联反例彻底关闭。C-001～C-011 与 080 R1 总门证据可以采信，当前
没有 Critical 或 Important；仅保留一个不阻断的存量行数 Minor。

本轮只读取 055 task/report/R2 review、080 R1 report、当前范围实现与测试，没有修改产品代码，没有重跑
080 已记录的 TypeScript、state、boundaries、Vitest、build 或 diff-check；唯一写入是本 R1 复审结论。

### 原 I-1 关闭核验

- **唯一 policy owner 已闭合。** `apps/web/src/imageInput/staticImagePolicy.ts:38-68` 是 JPEG/PNG/WebP
  MIME dispatch、动画拒绝和 4096×2160 预算的统一入口；Composer 在
  `composerImageAttachmentState.ts:106-139` 消费它，`view_image` 的 low/high 在
  `resizeVisionImage.ts:73-86` 分支前消费同一入口。旧 `imageAnimationDetector` 源码/测试已删除，当前
  `apps/web/src` 没有 TS/TSX 引用，不存在第二套生产门禁。
- **动画、超尺寸和 malformed 均在网络前拒绝。** PNG parser 校 signature、首且唯一 IHDR、CRC、chunk
  闭合及 `acTL/fcTL/fdAT`；WebP parser 校 RIFF 精确长度、padding、VP8/VP8L/VP8X 必需头字段、feature
  一致性和 `ANIM/ANMF`；JPEG parser 校 SOF 固定字段并遍历 SOS/entropy 至文件末尾精确 EOI。
  `deepseekImageViewer.test.ts:235-274` 让 APNG、两种 animated WebP、8192×8192 high 及全部 review
  malformed 输入走默认 resize 路径，并对注入的同一 Files/chat `fetchImpl` 断言 0 次调用。
- **R2 三个精确反例逐层闭合。** `JPEG SOF sampling=00`、`Tq=04` 与 bitDepth=1 但 3-entry PLTE 的
  indexed PNG 原 bytes 保存在 `staticImagePolicy.testFixtures.ts:208-233`；JPEG/PNG policy 测试断言
  `invalid`，Composer 的 malformed table 断言附件为空，viewer high table 断言 `fetch=0`。对应实现分别
  在 `jpegStaticContainer.ts:50-72` 校 H/V 1～4、Tq 0～3，在
  `pngStaticContainer.ts:64-79` 校 `PLTE entries <= 2 ** bitDepth`。055 R2 review 对 I-1～I-5 的关闭
  结论与当前代码、fixture 和消费链一致。
- **detail 语义真实且未退化。** 工具 schema 与执行都令省略 detail 成为 low；low 在统一门禁之后解码，
  要求解码尺寸与容器尺寸一致，1600×900 缩为 512×288，且编码 MIME fallback 不一致时失败闭合。
  high 在统一门禁之后返回同一个由 host bytes 构造的 Blob 与必填固有尺寸，不做像素解码/重编码；合法
  4096×2160 测试逐字节相等。DeepSeek wire file block 仍只有 `{type:'file',file_id}`，没有伪 `detail`。

### 协议、隔离与安全防回退

| 项目 | R1 判定 | 当前证据 |
|---|---|---|
| descriptor / Files / cleanup | ✅ | 视觉模型固定为 `deepseek-v4-flash-vision-exp`；上传固定官方 `/files`，multipart 为 `file` + `purpose=user_data`；部分失败/取消清理成功项，rollback 幂等且不继承取消 signal，discarded-retained 差集与 viewer `finally` 均 best-effort DELETE。 |
| 三态 route | ✅ | browser、host、preview 仍只允许 DeepSeek chat POST、multipart files POST、锚定单段 `file-api-*` DELETE，origin/body kind/32–4–1 MiB 响应上限一致；query、nested、空/过长 ID、错 method/scope/extra key 仍失败闭合。055 未修改这些边界。 |
| workspace fd confinement | ✅ | 支持平台判定后以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开并对同一 handle `fstat().isFile()`；Linux `/proc/self/fd/<fd>` 或 macOS 固定 `/usr/sbin/lsof -a -p <pid> -d <fd> -Fn` 取得 handle-bound path，confinement 后只读原 fd，limit+1、MIME 魔数及 core 的严格 base64/size/MIME 复核仍在。FIFO 有界拒绝与 viewer 固定错误文案证据未漂移。 |
| 分层 | ✅ | core 的新增 vision 路径只定义中立 port、fresh/signal 和受管 workspace read；固定 DeepSeek 模型与 provider fetch 留在 app；`tools/vision` 生产代码只依赖 `ToolContext.viewImage`，不认识 provider、文件系统或 Files API。 |
| 隔离调用 | ✅ | app viewer 仅读取显式 path，固定视觉模型，仅构造一条当前 user message，不传主历史、tools、tool_choice 或 detail；成功、响应失败、Abort/stale 都在上传后执行 `finally` rollback，错误文案不暴露 key、file id 或路径。 |
| Composer / Kimi / 标准工具 / 文档 | ✅ | provider-model 精确 dispatch、Kimi CN/`ms://`/owner cleanup/历史投影保持；标准工具仍为 7 域 32 项且 `view_image` replayUnsafe；中英文 README 的格式、Files API、low 512、high 原像素和清理说明与实现一致。060 的配置账本 Minor 已在 task 中补记根 `tsconfig.app.json`/`vite.config.ts`。 |

### C-001～C-011 与机械总门

080 R1 report 给出可复现命令、逐项 exit 和非空测试计数：`tsc -b`、state（23 workspace / 900 files）、
boundaries（916 files）、build、tracked diff-check、49 个范围未跟踪文件 no-index whitespace check 均为绿；
合并集先验证 61 个显式测试文件存在，再得到 61 files / 531 tests，055 子集为 7 files / 86 tests，清理
补充为 2 files / 11 tests。测试集合覆盖 C-001～C-010 的 descriptor、Files/file block、Kimi、三态路由、
workspace fd/FIFO、Composer/shared policy、low/high、隔离/cleanup、tool 32 和文档接线；结合 055 R2 独立
APPROVED，证据足以完成 C-011。本复审按约束不重复执行这些机械门。

### 质量分级与 one-file-one-thing

- Critical：无。
- Important：无；历史 I-1 已由上述共享 owner、前置容器门禁与精确 `fetch=0` 反例关闭。
- Minor：`packages/agent-core/src/tools/types.ts` 基线 309 行、当前 352 行（本树 +43）。它是基线已超限的
  canonical ToolContext 公共契约，本树只在该契约追加 workspace/view-image 能力；按“路过存量超限小改”
  披露而不在横切任务中顺手重构，处理合规且不阻断批准。

本树其余新增/大改普通文件均不超过 300 行；当前代表性上界为 `Composer.tsx` 293、
`deepseek.test.ts` 280、viewer test 274，055 的 fixture 236、WebP parser 190、JPEG parser 153、PNG parser
104、dispatch 与 bounded reader 各 69。按格式 parser、统一 policy、resize、viewer、UI state 的职责拆分
清晰，没有假拆。

### R1 最终回执

APPROVED — 055 已彻底关闭原 I-1，C-001～C-011、协议/安全/分层与最终机械门证据足以收口。
