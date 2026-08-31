---
id: 055
title: 统一静态图片门禁
kind: leaf
parent: 300
depends_on: [050]
discovered_from: 080
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/imageInput/**
  - apps/web/src/vision/resizeVisionImage.ts
  - apps/web/src/vision/resizeVisionImage.test.ts
  - apps/web/src/vision/deepseekImageViewer.test.ts
  - apps/web/src/agentNew/ui/imageAnimationDetector.ts
  - apps/web/src/agentNew/ui/imageAnimationDetector.test.ts
  - apps/web/src/agentNew/ui/composerImageAttachmentState.ts
  - apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts
---

# 统一静态图片门禁

## 目标

把 Composer 既有的静态图片/尺寸策略下沉为 app 中立检查器，并让 `view_image` 的 low/high 在任何
解码或上传前共同复用：拒绝 APNG、animated WebP 和超过 4096×2160 的原图；high 仍保持原始字节但
携带真实尺寸，low 只对已确认静态且预算内的图片保留或缩放。

## 粒度

预计 15–25 分钟；容器检查器、Composer 消费和 vision 消费是同一安全策略的完整闭环，拆开会留下
一条可绕过路径。纯解析、UI 状态和视觉缩放必须落在不同职责文件，普通文件均不超过 300 行。

## 上下文

080 终审发现：host 只按 JPEG/PNG/WebP 魔数收窄，`resizeVisionImage` 的 high 在检查/解码前返回且
没有尺寸；low 对 512 包围盒内图片也保留原字节。APNG `acTL`、WebP `ANIM` / `VP8X` animation bit
因此可上传，8192×8192 high 也因 width/height undefined 绕过 agent-ai 4096×2160 检查。

现有 UI `imageAnimationDetector.ts` 能识别动画，但属于 UI 层且尺寸依赖浏览器 decode。将纯容器解析
下沉到 `apps/web/src/imageInput/staticImagePolicy.ts`：从 JPEG/PNG/WebP 容器头在完整解码前取得固有
width/height并识别动画；格式畸形、未知尺寸、动画、超尺寸均 fail-closed。Composer 与 vision 都消费
它，禁止复制解析器或让 vision 反向依赖 UI。

新文件职责计划：
- `apps/web/src/imageInput/staticImagePolicy.ts` → 只解析 JPEG/PNG/WebP 静态容器元数据并执行尺寸门禁。
- 对应 test → 只覆盖容器头、动画标记、畸形与尺寸预算。

## 覆盖矩阵行

- `C-005`：Composer 静态图片拒绝保持且改用共享 owner。
- `C-006`：low 在上传前拒绝动画/超尺寸，再执行 512 缩放。
- `C-007`：high 校验后保留原 bytes 并携带真实尺寸。
- `C-008`：违规输入 Files/chat fetch 均为 0。

## 接口

### 消费
- `DEEPSEEK_VISION_IMAGE_INPUT.limits`：4096×2160 边界；不要在解析器写 DeepSeek 分支，调用方传限额。
- `WorkspaceImageReadResult`：050 的受限 JPEG/PNG/WebP bytes。

### 产出
- `inspectStaticImage(blob, mimeType, limits) => Promise<{width:number;height:number}>`：供 Composer 与 vision 共同使用。
- `ResizedVisionImage.width/height` 改为必填，high 用解析的真实尺寸，low 用缩放后的尺寸。

## 验收标准

1. `pnpm exec vitest run apps/web/src/imageInput apps/web/src/vision apps/web/src/agentNew/ui/imageAnimationDetector.test.ts apps/web/src/agentNew/ui/composerImageAttachmentState.test.ts` → APNG/WebP 动画、超尺寸、静态正向、Composer 回归全部通过。
2. viewer 反例测试 → low/high 的 APNG、`ANIM`、`VP8X` animation bit 与 8192×8192 high 均在上传前拒绝，Files/chat fetch 为 0。
3. `pnpm exec tsc -p tsconfig.app.json --types vite/client,node` → app 类型检查通过。
4. `wc -l apps/web/src/imageInput/*.ts apps/web/src/vision/*.ts apps/web/src/agentNew/ui/composerImageAttachmentState.ts` → 普通文件均不超过 300 行且职责独立。
5. `git diff --check -- apps/web/src/imageInput apps/web/src/vision apps/web/src/agentNew/ui` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：由 080 最终独立审查 I-1 发现并立即派发。
- 2026-08-21：首轮独立审查 REJECTED 三项 Important：JPEG 在 SOF 后提前返回而不验证 SOS/EOI；
  PNG 跳过 chunk CRC；WebP 漏验 VP8 frame tag、VP8L version、VP8X reserved/feature 一致性。进入 R1，
  按 JPEG/PNG/WebP 职责拆 parser 以保持每文件 ≤300，并补每个精确 malformed high 零上传反例。
- 2026-08-21：R1 复审确认原 I-1～I-3 关闭，但 REJECTED 两项同类固定 header 约束：JPEG SOF 的
  H/V sampling 与量化表 selector，indexed PNG 的 PLTE entries/bit-depth 一致性。进入 R2，补精确
  policy/Composer/high 零上传反例，不扩大到压缩流语义。
- 2026-08-21：R2 独立复审 APPROVED；编排者复跑 7 个文件 86/86 项聚焦测试及 app TypeScript
  全绿。JPEG sampling/Tq 与 indexed PNG PLTE/bit-depth 均在 policy、Composer、viewer high
  三层闭合，违规输入上传 fetch 为 0；055 完成。
