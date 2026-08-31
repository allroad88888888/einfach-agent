# 055 独立审查：统一静态图片门禁

## 结论

**REJECTED**。共享 owner、目标动画/尺寸反例和 low/high 接线方向正确，但容器 parser 仍会把若干结构非法的
JPEG/PNG/WebP 判成合法静态图；这直接违背任务要求的 malformed fail-closed，并使 high 能把原字节继续交给
Files/chat 路径。

审查基线为 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1`。本次只读取 055 任务、055 执行报告、080 review 的
I-1，以及任务列出的 tracked diff 和未跟踪文件 no-index 内容；没有修改产品代码，也没有重跑报告测试。

## 质量发现

### Critical

无。

### Important

#### I-1：JPEG 在首个 SOF 后提前成功，缺失 SOS/EOI 的截断容器可绕过 policy

`apps/web/src/imageInput/staticImagePolicy.ts:108-134` 的 marker/segment 边界读取使用无符号长度且区间检查
正确，但 `:123-129` 读到 SOF 后立即返回尺寸。因而 SOF 后的 marker、scan 数据和 EOI 完全不再检查。

下面是完整反例 bytes（hex）：

```text
ff d8 ff c0 00 0b 08 00 01 00 01 01 01 11 00
```

偏移含义：`0..1` 是 SOI，`2..3` 是 SOF0，`4..5` 的 segment length 为 11，`7..8` / `9..10` 声明
1×1，`11` 的 component count 为 1，SOF 恰好在 `14` 结束；文件随后直接 EOF，没有 SOS，也没有 EOI。
现代码在 `:129` 返回 `{width:1,height:1,animated:false}`。这不是未知尾部的兼容问题，而是明确截断的 JPEG。

影响：Composer 不再像旧的浏览器 decode 那样拒绝这类无效文件；low 会在 policy 已错误放行后才进入像素
decode；high 则不 decode，直接返回该原 Blob 和 1×1 尺寸，随后现有 viewer 上传路径没有第二个容器校验。
055 的“读取失败、所有结构错误均 invalid”报告结论因此不成立，现有 `missing dimensions` / `truncated
segment` 测试也没有覆盖“完整 SOF 后截断”。

最小修复应保存 SOF 尺寸后继续验证 JPEG 结构至合法 EOI；处理 SOS 后必须正确跳过 entropy-coded data 中的
`ff 00` stuffing 和 restart marker，并兼容 progressive JPEG 的后续 scan。至少补上上述 bytes 的 policy
拒绝与 high 零 fetch 串联反例。

#### I-2：WebP 只读取尺寸，没有验证 VP8/VP8L/VP8X 的必需保留字段

`staticImagePolicy.ts:136-164` 的三个 bitstream header parser 不完整：

- VP8（`:136-143`）只检查 `offset+3` 的 key-frame start code 和两个尺寸字段；没有检查 3-byte frame tag
  的 `frame_type`。以下 RIFF/chunk 长度全部闭合，但 payload offset `20` 的 bit 0 为 1，声明 inter frame；
  WebP 静态图不能以没有参考帧的 inter frame 开始。现代码仍返回 1×1：

  ```text
  52 49 46 46 16 00 00 00 57 45 42 50 56 50 38 20 0a 00 00 00
  01 00 00 9d 01 2a 01 00 01 00
  ```

- VP8L（`:146-153`）把 payload offset `+1` 的 32 bits 只用于宽高，没有要求 bits 29..31 的 version 为 0。
  以下 1×1 文件把 bit 29 置 1（全文件 offset `24 = 0x20`），仍被接受：

  ```text
  52 49 46 46 12 00 00 00 57 45 42 50 56 50 38 4c 05 00 00 00
  2f 00 00 00 20 00
  ```

- VP8X（`:155-164,191-195`）检查了 flags byte 的 reserved bits，却没有检查 payload offset `+1..+3`
  三个 reserved bytes 必须为 0。以下文件全文件 offset `21` 为 1，并带尺寸一致的 1×1 VP8L image data；
  RIFF size、chunk size 和 padding 都合法，现代码仍接受：

  ```text
  52 49 46 46 24 00 00 00 57 45 42 50
  56 50 38 58 0a 00 00 00 00 01 00 00 00 00 00 00 00 00
  56 50 38 4c 05 00 00 00 2f 00 00 00 00 00
  ```

这三个反例都会通过 `parseWebp` 的 RIFF 精确长度、chunk range、padding、尾部闭合和正尺寸检查。它们说明
offset/无符号算术本身是安全的，但“header 畸形 fail-closed”没有兑现。尤其 high 不做浏览器 decode，会把
这些原 bytes 当作已验证静态 WebP 返回。现有测试覆盖了 RIFF/chunk 越界、缺 image data、三条正常尺寸路径
和动画标记，却没有覆盖上述字段；执行报告所称 VP8 frame header / VP8L / VP8X 结构完整校验过度陈述。

应补齐 VP8 key-frame/帧头及分区长度边界、VP8L version bits、VP8X reserved bytes（以及已声明 feature 与
chunk 的必要一致性），并为上述反例补 policy 与 high 零 fetch 测试。

#### I-3：PNG chunk CRC 完全未验证，测试中的“静态正向”本身是损坏容器

`staticImagePolicy.ts:73-99` 为每个 chunk 预留并跳过尾部 4-byte CRC，却从未计算或比较 CRC。下面就是
当前 fixture 生成的 1×1 “PNG”：IHDR、IDAT、IEND 三个 CRC 都写成 0；至少 IEND 的规范 CRC 固定为
`ae 42 60 82`，所以这是可确定的损坏容器，现代码仍返回 1×1：

```text
89 50 4e 47 0d 0a 1a 0a
00 00 00 0d 49 48 44 52 00 00 00 01 00 00 00 01 08 06 00 00 00 00 00 00 00
00 00 00 00 49 44 41 54 00 00 00 00
00 00 00 00 49 45 4e 44 00 00 00 00
```

CRC 是 PNG 容器 chunk 的结构字段，不要求像素 decode 即可验证。忽略它意味着任意损坏/篡改的 IHDR、
acTL 或 chunk type 只要同步修改可见 bytes 就会被当成“已验证”；high 不再有浏览器 decode 兜底。现有
`staticImagePolicy.testFixtures.ts:17-19` 固定输出四个零，故 PNG 正向、Composer 与 viewer 测试没有使用
结构有效的 PNG 证明 policy。应为 fixture 生成真实 CRC32，并在 parser 中逐 chunk 校验 type+payload CRC；
补上述反例的 policy/high 零 fetch 测试。像素压缩流的完整 decode 不属于此条要求，CRC 校验属于容器层。

### Minor

无。

## 逐项验收

| 项目 | 判定 | 静态证据 |
|---|---|---|
| PNG signature / 首且唯一 IHDR / acTL | **失败** | signature、IHDR、无符号范围和动画遍历正确，但所有 chunk CRC 被跳过；I-3 的确定损坏 PNG 被放行。 |
| JPEG marker / SOF | **失败** | SOF 前的边界检查正确，但首个 SOF 即返回；I-1 的截断容器被放行。 |
| WebP RIFF size / chunk padding | 通过 | RIFF size 必须精确等于 `bytes.length-8`，chunk 用 `getUint32`，奇数 padding 和尾部闭合均检查。 |
| WebP VP8 / VP8L / VP8X | **失败** | 尺寸偏移正确，ANIM/ANMF/animation bit 会拒绝；必需 frame/version/reserved 字段缺校验，见 I-2。 |
| decode/upload 前门禁 | **部分失败** | `resizeVisionImage.ts:78-88` 确实在 high 分支和 low pixel decode 前调用共享 policy；但 policy 对 I-1～I-3 输入返回成功，所以这些输入仍进入 low decode 或 high 上传。 |
| 4096×2160 | 通过 | vision 调用生产 `DEEPSEEK_VISION_IMAGE_INPUT.limits`；policy 用调用方 limits，测试钉住 4096×2160 接受、越一像素拒绝和 8192×8192 拒绝。 |
| high 原 bytes + 必填尺寸 | 结构通过、边界失败 | `ResizedVisionImage.width/height` 必填；high 在 policy 后原样返回且不 decode，字节保持机制成立。但当前 4096×2160 正向 fixture 的 PNG CRC 也无效，且 malformed high 会被错误当成已校验输入原样返回。 |
| low decode 与容器尺寸一致 | 通过 | `resizeVisionImage.ts:91-95` 对正安全整数和 metadata exact match fail-closed，之后才保留或缩放。 |
| APNG / animated WebP / 8192 high 零 fetch | 通过 | viewer 的 7 组串联反例使用默认 resize 路径且断言 injected fetch 为 0；报告记录相同结果。此结论不能扩展到 I-1～I-3 malformed high。 |
| Composer 共享 owner / 删除旧 detector | 共享成立、拒绝边界失败 | Composer 唯一消费 `inspectStaticImage`，旧 detector 源码/测试已删除，`apps/web/src` 无 TS import 残留；只有生成 PO 中的旧 source-reference 注释，不是 import。共享 owner 自身对 malformed 放行，故原无效图片拒绝语义未完整保持。 |
| ≤300 行 / 单一职责 | 通过 | 最大 `staticImagePolicy.ts` 262 行、viewer test 255 行；其余均低于 300。policy、resize、UI state、测试 fixture 职责分离合理。 |

## C-005～C-008

- **C-005：失败。** owner 已统一且动画/尺寸 UI 文案映射保留，但 I-1 的无效 JPEG 与 I-3 的损坏 PNG 会
  被 Composer 接受，旧 decode 所提供的无效图片拒绝没有完整保持。
- **C-006：失败。** 目标 APNG/animated WebP/超尺寸确实在 low decode 前拒绝，512 缩放及 decode 尺寸一致
  也正确；I-1～I-3 malformed 输入却可越过共享门禁进入 decode，不满足统一 fail-closed 前置检查。
- **C-007：失败。** 必填真实尺寸和合法 high 原字节语义成立，但“校验后”这一前提不成立；上述 malformed
  high 会被原样返回。
- **C-008：失败。** APNG、ANIM、VP8X flag、8192 high 的记录证实 fetch 为 0；I-1～I-3 high 反例会从
  resize 成功返回并进入 Files/chat 路径，违规输入零上传尚未闭合。

## 报告证据评价

055 报告记录的 53/53、app TypeScript、行数与 whitespace 门禁可采信，本审查未重复运行。它们充分证明
目标动画/尺寸回归和机械质量为绿，但测试集没有覆盖上述反例，不能支撑“所有结构错误均 invalid”的结论。
080 I-1 要求的共享 owner、三类动画和 high 尺寸缺口已按正确方向修复；本次拒绝仅针对 055 自己新增的
malformed fail-closed 验收边界，不要求扩大 core、route 或协议层。

## 最终回执

REJECTED — 补全 JPEG 终止结构、PNG chunk CRC 与 VP8/VP8L/VP8X 必需头字段校验，并为精确 malformed bytes 增加 high 零上传反例。

---

## R1 独立复审

### R1 结论

**REJECTED**。首轮 I-1～I-3 的五个精确反例已经逐项关闭，parser 拆分、JPEG scan 闭合、PNG CRC 和
WebP 未压缩头/extended 形态均明显改善；但 JPEG SOF component descriptor 与 indexed PNG 的 PLTE
约束仍会放行结构非法容器。这两类输入同样可从 high 原字节路径进入上传，malformed fail-closed 尚未收口。

R1 只读取更新后的 055 task、055 report、本 review 和相同 files 的当前 tracked/no-index diff；没有修改
产品代码，没有重跑报告测试。R1 报告记录的 7 文件 73 项测试、TypeScript、whitespace 门禁作为既有证据
采信。

### R1 质量发现

#### Critical

无。

#### Important

##### I-4：JPEG SOF component descriptor 未校验 sampling factor 与 quantization selector

`apps/web/src/imageInput/jpegStaticContainer.ts:50-65` 校验 precision、宽高、component count、segment
length 和 component ID 唯一性，却只读取每个 component 的第一个 byte。其后两个 byte 中，水平/垂直
sampling factor 必须各在 1～4，quantization table selector 必须在 0～3；当前均未检查。

以下 JPEG 的 SOF/SOS/entropy/EOI 完整闭合，offset `13` 的 sampling byte 为 `00`（H=0、V=0），属于
非法 SOF；现 parser 会返回 1×1：

```text
ff d8 ff c0 00 0b 08 00 01 00 01 01 01 00 00
ff da 00 08 01 01 00 00 3f 00 00 ff d9
```

同一 bytes 若把 offset `13` 改为合法 `11`、offset `14` 改为 `04`，则是 quantization selector 越界的
第二个被放行形态。两者不是 R1 明确排除的 entropy 编码语义，而是 SOF 的固定未压缩字段。Composer 会把
它们建成附件；low 会在错误 policy 结论后才 decode；high 会直接返回原 Blob 与 1×1，当前 viewer 测试
没有相应零 fetch 反例。

修复应在 `readStartOfFrame` 的 component 循环中验证 `H/V ∈ [1,4]`、`Tq ∈ [0,3]`，并为上述完整 hex
补 policy invalid、Composer invalid 与 viewer high fetch=0。

##### I-5：indexed PNG 未按 bit depth 限制 PLTE entry 数量

`apps/web/src/imageInput/pngStaticContainer.ts:64-76` 验证 IHDR bit-depth/color-type 组合，也验证 PLTE
非空、三字节对齐和总长不超过 768；但 parser 没有保存 `bitDepth`，所以没有落实 indexed-color PNG 的
PLTE entry 数不得超过 `2^bitDepth`。以下 1×1、bit depth 1、color type 3 的 PNG 放了 3 个 palette
entries（上限应为 2）；四个 chunk CRC 均正确，现 parser 返回 1×1：

```text
89 50 4e 47 0d 0a 1a 0a
00 00 00 0d 49 48 44 52 00 00 00 01 00 00 00 01 01 03 00 00 00 25 db 56 ca
00 00 00 09 50 4c 54 45 00 00 00 ff ff ff ff 00 00 cd 5e b7 9c
00 00 00 00 49 44 41 54 35 af 06 1e
00 00 00 00 49 45 4e 44 ae 42 60 82
```

这同样属于 PNG critical chunk 的未压缩结构约束，不涉及 R1 范围外的 IDAT deflate 语义。它会绕过
Composer/shared policy，high 也不会再 decode。修复应保存 IHDR bit depth，并对 color type 3 要求
`PLTE.length / 3 <= 2 ** bitDepth`；补该精确 bytes 的 policy invalid 与 viewer high fetch=0。

#### Minor

无。

### 首轮 I-1～I-3 关闭核对

- **I-1 已关闭。** JPEG 在 SOF 后保存尺寸而不返回；只有已见 SOS 且精确 EOI 位于文件末尾才成功。
  entropy scanner 能跳过 `ff00` stuffing、RST0～RST7 和连续 `ff` fill；有长 marker 后继续 marker
  traversal，后续 SOS 会重新进入 entropy，progressive 多 scan 正向成立。首轮截断 hex 有 policy invalid
  与 viewer high fetch=0。
- **I-2 已关闭。** VP8 要求 key frame、version≤3、show-frame、partition 边界、start code 和零 scale；
  VP8L version 为零；VP8X flags 与三个 reserved bytes 均验证。extended 路径约束 VP8X 首块、feature
  flags 与 ICCP/ALPH/EXIF/XMP/ANIM 形态一致、顺序/唯一性、ANIM+ANMF frame 闭合。三组首轮 WebP hex
  均有 policy invalid 与 viewer high fetch=0。
- **I-3 已关闭。** PNG 在消费 chunk 前计算 `CRC32(type+payload)` 并与 big-endian stored CRC 比较；fixture
  生成真实 CRC，IEND `ae426082` 有独立断言。首轮全零 CRC hex 有 policy invalid 与 viewer high fetch=0。

### 其余 R1 验收

| 项目 | R1 判定 | 证据摘要 |
|---|---|---|
| parser 拆分 / 单一职责 | 通过 | `boundedImageBytes` 只负责有界无符号读取；JPEG/PNG/WebP 各一 parser；`staticImagePolicy` 只做 MIME dispatch、统一 error 与 limits。没有按行数机械切片或跨 UI/provider 依赖。 |
| 每文件 ≤300 | 通过 | 最大 `deepseekImageViewer.test.ts` 274 行；fixture 196、WebP 190、JPEG 146、PNG 102、dispatch 69、bounded reader 69；范围内全部低于 300。 |
| 初始动画/尺寸门禁 | 通过 | CRC 正确 APNG 与结构完整 animated WebP 仍映射 animated；4096×2160 边界和 8192 high 拒绝保持。 |
| Composer / 旧 detector | 共享成立、malformed 边界未闭合 | Composer 唯一消费 shared policy，旧 detector 无 TS/TSX import 残留；首轮 JPEG/PNG 反例已拒绝，但 I-4/I-5 会被接受。 |
| low/high | 机制通过、校验边界失败 | low 的 decode/container 尺寸 exact match、512 缩放、原字节保留和 MIME fallback 未回退；high 的 bytes/必填尺寸未回退。I-4/I-5 在共同前置 policy 被错误放行。 |
| 原动画/尺寸与 review 零 fetch | 通过 | 首轮 7 组动画/尺寸与 R1 5 组 review malformed high 都有 fetch=0；I-4/I-5 尚无零 fetch 串联测试，代码路径会成功返回 resize。 |
| cleanup / 生命周期 | 通过 | viewer 成功、失败、Abort、stale 与 best-effort delete 测试仍保留，R1 diff 未改变产品 cleanup 实现。 |

### R1 C-005～C-008

- **C-005：失败。** shared owner 和首轮回归成立，但 I-4/I-5 仍会成为 Composer 附件，无效图片拒绝未完整保持。
- **C-006：失败。** 目标动画/超尺寸及 low 缩放正确；I-4/I-5 会越过 policy 才进入 pixel decode。
- **C-007：失败。** 合法 high 的原 bytes 与必填尺寸成立；I-4/I-5 malformed high 也会被原样返回。
- **C-008：失败。** 已有 12 组违规输入均为零 fetch，但 I-4/I-5 会从默认 resize 成功返回并进入现有
  Files/chat 路径，违规输入零上传边界仍有缺口。

### R1 最终回执

REJECTED — 补齐 JPEG SOF sampling/quantization 字段与 indexed PNG 的 PLTE/bit-depth 一致性，并增加精确 high 零 fetch 反例。

---

## R2 独立复审

### R2 结论

**APPROVED**。R1 的 I-4/I-5 已在 parser、共享 policy 消费者和 viewer 上传边界三层彻底关闭；R1 已关闭的
I-1～I-3 均保留原精确反例与实现约束，没有回退。未发现 Critical、Important 或 Minor。

本轮只审阅更新后的实现、测试和 055 报告，没有修改产品代码，没有重跑执行者记录的测试；报告中的
86/86、TypeScript 与 whitespace 结果作为既有机械证据采信。

### I-4 关闭证据

- `jpegStaticContainer.ts:50-72` 的 SOF component 循环逐项读取 id、sampling、Tq：id 必须非零且唯一，
  horizontal/vertical nibble 各在 1～4，Tq 在 0～3。校验位于尺寸返回前，适用于每一个 component。
- fixture 精确保留 R1 的闭合 `sampling=00` bytes，并另有 `sampling=11,Tq=04` bytes；JPEG policy test
  分别断言 `invalid`。Composer 的 non-WebP malformed table 覆盖两例并断言附件为空；viewer 对完整
  malformed table 逐例执行 high，断言预处理失败且 injected fetch 从未调用。
- 原 SOF 后截断、合法 baseline、progressive 多 scan、`ff00`、RST、fill 与精确 EOI 测试仍在；新增检查
  只作用于 SOF 固定字段，没有扩张到 entropy 编码语义。

### I-5 关闭证据

- `pngStaticContainer.ts:39-79` 保存 IHDR bit depth；PLTE 继续要求非空、三字节对齐、至多 256 entries，
  并对 color type 3 额外要求 `entries <= 2 ** bitDepth`。
- R1 给出的 CRC-correct、bitDepth=1、3-entry PLTE 精确 bytes 仍由同一 fixture 供 policy、Composer、
  viewer high 三层消费，分别断言 `invalid`、附件为空、fetch=0。`indexedPngBytes(1,2)` 正向返回 1×1，
  证明边界不是一概拒绝 indexed PNG。
- CRC32(type+payload)、big-endian stored CRC、全零 CRC 反例与 APNG/尺寸测试均保留；没有进入 IDAT
  deflate 语义。

### 防回退与结构验收

- I-1：JPEG 仍须见 SOS 并从 entropy scanner 到文件末尾精确 EOI；截断 hex 仍在 policy/viewer table。
- I-2：三组 WebP review hex 仍在 policy malformed table 与 viewer high table；VP8/VP8L/VP8X 头、feature
  flags、chunk 顺序/唯一性和 ANIM+ANMF 形态实现未被 R2 改动。
- I-3：PNG 每 chunk CRC 在消费前比较；全零 CRC hex 仍有 policy、Composer、viewer 三层拒绝。
- 职责仍为 bounded reader、每格式 parser、dispatch/limits、UI、resize 各自独立。当前最大范围文件为
  viewer test 274 行；fixture 236、WebP 190、Composer source 195/test 180、JPEG 153、PNG 104，其余更小，
  全部普通文件 ≤300。
- 原 APNG/animated WebP/8192 high、4096×2160、low 512 缩放、decode/container 尺寸一致、high 原字节+
  必填尺寸、WebP→PNG MIME fallback、Abort/stale/cleanup 测试均保留。

### R2 C-005～C-008

- **C-005～C-008：通过。** Composer 继续唯一消费共享 owner；low/high 在 decode/upload 前共用完整容器
  结论；合法 high 保持原 bytes 与固有尺寸；初始 7 组、I-1～I-3 五组及 I-4/I-5 三组违规输入均有
  Files/chat fetch=0 证据。

### R2 最终回执

APPROVED — I-4/I-5 已三层闭合，I-1～I-3、职责拆分、行数及原 low/high/动画/清理行为均未回退。
