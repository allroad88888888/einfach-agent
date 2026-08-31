# 最新内置模型与 Thinking 协议

创建：2026-08-31

基线：`1776760`

状态：完成

## 目标边界

内置官方模型只保留当前六个模型：DeepSeek V4 Pro、DeepSeek V4 Flash、DeepSeek V4 Flash
Vision Experimental、GLM-5.3、GLM-5.3-Flash、Kimi K3。三家 Thinking 的正向手动档位统一为
`low | high | max`；`Auto` 仍是本产品的缺省表达，不作为上游字面量发送。

本树同时收口模型目录、请求投影、子 Agent tier routing、Composer 控件与既有 Kimi/DeepSeek 图片
链路。自定义 OpenAI-compatible profile 不受影响，仍按能力未知处理。用户确认没有存量会话需要兼容，
因此不新增旧 GLM/Kimi 模型迁移。

GLM-5.3-Flash 的新增多模态输入协议不在本树实现：目录会如实标记当前应用尚未审计其图片输入，避免
未经验证就发送图片。DeepSeek Vision 与 Kimi K3 的既有图片能力必须继续工作。

## 官方协议裁决

| 模型 | 手动档位 | Thinking 开关 | Auto 的上游效果 |
| --- | --- | --- | --- |
| DeepSeek V4 Pro / Flash / Vision Exp | Low、High、Max | 可开关 | 省略 effort，默认 High |
| GLM-5.3 / 5.3-Flash | Low、High、Max | 强制开启 | 省略 effort，默认 Max |
| Kimi K3 | Low、High、Max | 始终开启 | 省略 effort，默认 Max |

官方依据：

- DeepSeek Thinking Mode：<https://api-docs.deepseek.com/guides/thinking_mode/>
- DeepSeek Models & Pricing：<https://api-docs.deepseek.com/quick_start/pricing/>
- DeepSeek Vision：<https://api-docs.deepseek.com/guides/vision/>
- GLM 核心参数：<https://docs.bigmodel.cn/cn/guide/start/concept-param>
- GLM-5.3：<https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3>
- GLM-5.3-Flash：<https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash>
- Kimi 模型参数：<https://platform.kimi.ai/docs/api/models-overview>

## 全局约束

- 编排者只写本目录、调度、审查与分批 commit；产品代码全部交执行 agent，执行 agent 不得 commit。
- 工作区已有用户改动：`.gitignore`、`.project-lines/`、`CLAUDE.md`、UndoBar、若干 CSS 与
  `apps/desktop/gen/`。禁止 reset、checkout、覆盖、暂存或提交这些无关改动。
- 普通文件不超过 300 行且只负责一个业务点或抽象；新增文件先给出一句话职责。现有
  `builtinProviders.test.ts` 为 298 行，禁止继续塞测试；新增协议断言放专责测试文件。
- 模型能力表是 UI 与 adapter 的唯一事实源；不得在 React 中按模型名猜 Thinking 能力。
- `Auto` 用缺省 `reasoning_effort` 表达。GLM/Kimi 的强制思考是模型能力，不允许 UI 写入 Off。
- Kimi K3 请求不得发送 K2.x 专用 `thinking` 字段；GLM-5.3 请求只允许
  `thinking:{type:'enabled'}`；DeepSeek 保留 enabled/disabled。
- 未经用户授权不得调用真实付费模型、发布、push 或上传 artifact；协议测试统一注入 fetch。
- 每个非机械叶完成后必须由独立 reviewer 审查；最终 reviewer 固定使用 `gpt-5.6-sol`。

## 任务树

- 100 能力语义 (`group`)
  - [010](010-required-thinking-contract.md) 建立强制 Thinking 能力语义 (`leaf`，依赖：无)
- 200 厂商升级 (`group`)
  - [020](020-deepseek-v4-efforts.md) 让 DeepSeek V4 支持三档 effort (`leaf`，依赖：010)
  - [030](030-glm-5-3-family.md) 仅支持 GLM-5.3 系列 (`leaf`，依赖：020)
  - [040](040-kimi-k3-protocol.md) 仅支持 Kimi K3 (`leaf`，依赖：030)
  - [045](045-kimi-k3-images.md) 续接 Kimi K3 图片链路 (`leaf`，依赖：040)
- 300 兼容与收口 (`group`)
  - [055](055-latest-model-fixtures.md) 清理退役模型的可执行引用 (`leaf`，依赖：045)
  - [060](060-latest-model-audit.md) 审核最新模型全链路 (`leaf`，依赖：055)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 建立强制 Thinking 能力语义 | gpt-5.6-sol | done | 2026-08-31 | 2026-08-31 |
| 020 | 让 DeepSeek V4 支持三档 effort | gpt-5.6-terra | done | 2026-08-31 | 2026-08-31 |
| 030 | 仅支持 GLM-5.3 系列 | gpt-5.6-sol | done | 2026-08-31 | 2026-08-31 |
| 040 | 仅支持 Kimi K3 | gpt-5.6-sol | done | 2026-08-31 | 2026-08-31 |
| 045 | 续接 Kimi K3 图片链路 | gpt-5.6-terra | done | 2026-08-31 | 2026-08-31 |
| 055 | 清理退役模型的可执行引用 | gpt-5.6-terra | done | 2026-08-31 | 2026-08-31 |
| 060 | 审核最新模型全链路 | gpt-5.6-sol | done | 2026-08-31 | 2026-08-31 |

## 调度与分批 commit

010 先建立 `required Thinking` 契约。020、030、040 因共享 catalog 与 provider 装配文件顺序执行；040
通过后执行 045 续接图片链路。055 做机械收口，060 最终审计。

每批审查通过且编排者亲验后提交：

1. `feat: model required thinking modes`（010）
2. `fix: expose all DeepSeek V4 effort levels`（020）
3. `feat: upgrade builtin GLM models to 5.3`（030）
4. `feat: upgrade builtin Kimi model to K3`（040、045）
5. `test: close latest model catalog coverage`（055、060 与任务账本）

这些提交是有依赖的交付批次；只保证最终序列整体可发布，不为制造“可单独 cherry-pick”复制兼容代码。

## 跨层覆盖矩阵

| id | 表面 / 状态 | 精确入口或路径 | 归属叶子 | 验证证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| C-01 | 内置选择器恰好六个最新模型 | `builtinModelDescriptors.ts`、`composerModelOptions.ts` | 030、040、055 | registry/UI tests | passed |
| C-02 | DeepSeek 三模型显示 Auto/Low/High/Max | Thinking capability + Composer | 020 | capability/UI tests | passed |
| C-03 | DeepSeek 正确发送 low/high/max 与 On/Off | DeepSeek request projection | 020 | fetch body tests | passed |
| C-04 | GLM 两模型只显示三档且不能关闭 | capability + Composer | 010、030 | capability/UI tests | passed |
| C-05 | GLM 强制发送 enabled 且只发三档 | GLM request projection | 030 | fetch body tests | passed |
| C-06 | Kimi K3 只显示三档且不能关闭 | capability + Composer | 010、040 | capability/UI tests | passed |
| C-07 | Kimi K3 省略 thinking 并发送 effort | Kimi request projection | 040 | fetch body tests | passed |
| C-08 | Kimi K3 图片上传、历史引用与清理继续有效 | Kimi image pipeline | 045 | image transaction tests | passed |
| C-09 | DeepSeek Vision 仍可选且视觉工具不回归 | DeepSeek image/view_image paths | 020、055 | vision tests | passed |
| C-10 | 子 Agent routing 只产出最新模型 ID | `defaultTierRoutingTable.ts` | 030、040 | routing tests | passed |
| C-11 | profile/current fallback 不冒充官方模型能力 | OpenAI-compatible selector path | 055 | selector tests | passed |
| C-12 | 退役 ID 不再存在于可执行产品与夹具 | 全仓静态扫描 | 055、060 | `rg` allowlist | passed |
| C-13 | 中英文、键盘、窄宽布局与 aria 不回归 | Composer model controls | 010、060 | UI/visual audit | passed |

## 验收总门

1. `defaultProviderRegistry.listModels()` 精确返回六个目标模型，无其它内置模型。
2. DeepSeek 手动档位为 low/high/max 且可关闭；GLM-5.3 系列与 Kimi K3 同为三档但不可关闭。
3. 三家最终 fetch body 符合各自官方协议；Auto、Off、脏值和历史别名均 fail closed。
4. 自定义连接与未知 vendor/model 保持能力未知，不被官方目录或请求投影误认。
5. DeepSeek Vision 与 Kimi K3 的现有图片发送、历史图片兼容、清理事务和 `view_image` 通过回归。
6. `pnpm exec tsc -b --pretty false`、目标 Vitest、`pnpm check:state`、`pnpm check:boundaries`、
   `pnpm lingui:extract --clean`、`pnpm lingui:compile`、`pnpm build`、`git diff --check` 全部通过。
7. 新增/大改普通文件经 `wc -l` 不超过 300 行；路过存量超限只报告，不顺手重构。

## 决策与变更

- 裁决：DeepSeek Vision Experimental 属于目标最新模型并保留 — 官方当前仍单列该模型且它承载现有视觉
  链路；错了的代价是目录比“纯文本主模型”多一项，但不会拆掉已经交付的图片能力。
- 裁决：强制思考进入 capability contract — UI 与 adapter 必须共享同一事实；错了的代价是公共能力类型
  多一个字段，但避免 React 和 provider 各自维护黑名单。
- 裁决：GLM-5.3-Flash 新增图片协议暂不接入 — 本需求源于模型目录与 Thinking 档位，未验证的新图片线上
  协议不应顺带开放；错了的代价是该模型首版仅文本可用，后续可单开多模态树。
- 2026-08-31：用户确认目标目录仅保留最新模型，并补充 DeepSeek Vision 也是目标最新模型。
- 2026-08-31：用户确认没有存量会话需要迁移；删除兼容迁移叶与相关验收面，旧 GLM/Kimi ID 直接退出
  产品支持范围。
- 2026-08-31：用户确认开工；010 以当前 HEAD `177676017b4f183fb9c10cbe3b92550c526d6b16`
  派发，后续叶在各自派发前复写实际 base。
- 2026-08-31：010 执行 DONE_WITH_CONCERNS；实现与专项门通过。编排者修正计划裁剪迁移叶后遗留的
  覆盖编号 C-14→C-13；仓库无 eslint 命令不是任务验收项，进入独立审查。
- 2026-08-31：010 独立审查 APPROVED；编排者复跑 3 files / 23 tests 通过，首批可提交。
- 2026-08-31：010 已提交 `9d994a3 feat: model required thinking modes`；020 以该提交为 base 派发。
- 2026-08-31：020 执行与独立审查通过；编排者复跑 3 files / 74 tests 通过，第二批可提交。
- 2026-08-31：020 已提交 `e146e46 fix: expose all DeepSeek V4 effort levels`；030 以该提交为 base 派发。
- 2026-08-31：030 执行 DONE_WITH_CONCERNS；本叶 45 tests、类型、state/boundaries、diff 与行数门通过。
  额外包级回归的 4 个旧 GLM 夹具失败已归属 055；编排者同步修正任务矩阵编号 C-11→C-10，进入审查。
- 2026-08-31：030 独立审查 APPROVED；编排者复跑 3 files / 30 tests 通过，第三批可提交。
- 2026-08-31：030 已提交 `98816b0 feat: upgrade builtin GLM models to 5.3`；040 以该提交为 base 派发。
- 2026-08-31：040 首轮执行专项门通过，但编排者审查发现 K3 descriptor 仍是 K2.6 的 256K context；
  依据官方 K3 1M 契约退回原执行者做限定 R1，未进入独立审查。
- 2026-08-31：040 R1 已把 K3 descriptor 与 Kimi vendor fallback 的 context 统一为 1M，并补齐断言；
  专项门再次通过，进入独立审查。
- 2026-08-31：040 独立审查 APPROVED；编排者复跑 5 files / 60 tests 通过。045 以当前提交
  `98816b041b42d55ee3308a909af8e8cf7f646f36` 为 base 派发；040 与 045 将合并为同一批 K3 commit。
- 2026-08-31：045 执行发现图片 capability 定义在本叶、唯一消费者 K3 descriptor 原列于 040；为避免
  生产代码保留 K2.6 兼容别名，将 `builtinModelDescriptors.ts` 显式纳入 045 范围。
- 2026-08-31：045 执行与独立审查 APPROVED；编排者复跑 7 files / 32 tests 通过，040+045 的 K3
  协议、目录、routing 与图片链路可合并提交。
- 2026-08-31：040+045 已提交 `5ad0f61 feat: upgrade builtin Kimi model to K3`；055 以该提交为
  base 派发，只清理测试、界面文案与翻译中的退役模型引用，不做存量迁移。
- 2026-08-31：055 静态预扫发现两份当前 README 仍宣称 Kimi K2.6；它们不是历史账本，显式纳入
  机械文案同步。历史蓝图/RFC、旧任务账本与 `.project-lines` 项目学习记录继续作为历史证据保留。
- 2026-08-31：055 执行者复核确认 `docs/README.md` 与 `docs/launch/repo-metadata.md` 也在陈述当前
  状态，纳入同一机械文案同步；竞品事实、历史 RFC/蓝图不改。
- 2026-08-31：055 全仓扫描又发现当前 `docs/model-adapter-compatibility.md` 仍声明 GLM-5.2 与
  Kimi 未接入；将该兼容契约纳入同步，更新当前目录、thinking 与 wire 语义，不改历史蓝图。
- 2026-08-31：055 独立审查 APPROVED，无实现 finding；编排者复跑 406 files / 3100 tests 全绿。
  审查指出任务 glob 漏写 `.test.tsx` 且报告目标计数少计一文件，账本已修正为 32 files / 204 tests。
- 2026-08-31：060 以 `5ad0f617571f96de36305019c531a258c0fb4e25` 为 base 派发，消费未提交的
  055 夹具/文档收口结果，逐行审核 C-01～C-13 并执行最终 build/视觉门。
- 2026-08-31：060 首轮终审 NEEDS_CHANGES：C-13 的英文 `Thinking 始终开启` msgstr 为空；C-12
  的退役扫描漏掉 exact `glm-5`，三个 agent-core 测试仍有五处。退回 055 做限定 R1，不改生产逻辑。
- 2026-08-31：055 R1 补齐英文 required toggle 翻译与组件断言，五处 exact `glm-5` 夹具切到
  `glm-5.3`；060 R1 独立复审 APPROVED，C-01～C-13 与全部发布门最终通过。
