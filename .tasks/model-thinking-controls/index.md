# 模型 Thinking 控件实装

创建：2026-08-21

基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`

状态：功能完成；全树集成收口已通过

## 目标边界

把输入框上方现有的模型下拉与 Thinking 原型接到真实会话设置：每个对话独立选择模型、独立开关
Thinking、独立选择该模型官方支持的档位；变更写进当前 `SessionMeta.settings` 并走既有会话持久化，应用
重启与切换会话后仍保持。

“落本地配置”指在 `packages/agent-ai` 建立受类型约束的逐模型能力表，界面和 adapter 共用它，不能继续
在 React 组件里硬编码档位。它不是远程配置，不在运行时联网抓官方文档，也不把用户选择上传到额外
服务。

本树只修改主对话的当前会话设置。它不改变全局新会话默认、子 Agent 的 tier routing、历史 run 的模型
快照、API Key/endpoint 配置或服务端模型发现协议。模型运行中禁用控件且命令层拒绝变更，防止界面显示
的新模型与正在执行的旧快照不一致。

## 官方能力裁决

`Auto` 是本产品的界面选项：Thinking 开启但不发送 `reasoning_effort`，由服务商使用模型默认值；它
不是上游 API 的字面量。Thinking 的 On/Off 始终写 `settings.thinking`，档位写
`settings.vendorSettings.reasoning_effort`。

| 模型 | Thinking | 界面档位 | 本地配置说明 |
| --- | --- | --- | --- |
| DeepSeek V4 Pro / Flash | On / Off | Auto、High、Max | 官方原生值仅 `high|max`；旧 low/medium/xhigh 继续由既有迁移归一 |
| GLM-5.2 | On / Off | Auto、Low、Medium、High、XHigh、Max | 官方接受这些值；Low/Medium 实际映射 High，XHigh 映射 Max |
| GLM-5.1 / 5 / 5-Turbo | On / Off | 无分档 | 官方支持 `thinking.type`，未声明 `reasoning_effort` |
| GLM-4.7 / 4.7-FlashX / 4.7-Flash | On / Off | 无分档 | 官方支持轮级 Thinking，未声明 `reasoning_effort` |
| GLM-4.6 / 4.5-Air / 4.5-AirX / 4.5-Flash | On / Off | 无分档 | 官方支持 `thinking.type`，未声明 `reasoning_effort` |
| GLM-4-Long / 4-FlashX-250414 / 4-Flash-250414 | 不提供控件 | 无 | 官方 Thinking 支持边界为 GLM-4.5 及以上 |
| Kimi K2.6 | On / Off | 无分档 | 官方资料证明 Thinking 能力但未公布固定 `support_efforts`，不伪造档位 |
| 自定义 OpenAI-compatible 模型 | 能力未知 | 无 | profile 没有受审 capability manifest，不能按模型名字猜厂商能力 |

GLM 官方还接受 `minimal|none`，但两者都会放弃思考；本产品已有独立 Off 按钮，因此不再把同一语义
重复成两个“档位”。adapter 仍要对持久化脏值 fail closed，不把未知字符串原样发上游。

官方依据：

- DeepSeek Thinking Mode：<https://api-docs.deepseek.com/guides/thinking_mode>
- DeepSeek Chat Completion：<https://api-docs.deepseek.com/api/create-chat-completion>
- GLM 深度思考：<https://docs.bigmodel.cn/cn/guide/capabilities/thinking>
- GLM 思考模式：<https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode>
- GLM-4.5：<https://docs.bigmodel.cn/cn/guide/models/text/glm-4.5>
- Kimi Code Providers and Models：<https://moonshotai.github.io/kimi-cli/en/configuration/providers.html>
- Kimi Code Thinking 配置：<https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#thinking>

## 全局约束

- 编排者只写本目录、审查和调度；所有产品与测试代码由执行 agent 修改。
- 工作区已有用户在途改动和未跟踪的模型控件原型；禁止 reset、checkout、暂存、提交、覆盖无关文件。
  UI 叶必须在原型上收敛，不能删除后重做；未跟踪文件用 `git diff --no-index` 纳入审查。
- 普通文件只负责一件事且不超过 300 行；新增能力表、设置转换、模型选项、React 视图必须按职责拆分。
  `Composer.tsx` 当前 287 行，只允许最小接线，若改动会超过 300 行必须先按职责抽出逻辑。
- 会话设置只能经 core command 修改；React 不直接写 root store，不新增 React 本地业务状态或第二套状态库。
- 模型能力只来自本地受审表；不按 model 字符串猜 provider，不给 `openai-compat` 偷套官方 DeepSeek、GLM、
  Kimi 的档位或私有请求字段。
- 切模型必须保留 connection identity；profile 模型仍是 `vendor: 'openai-compat'` 加
  `vendorSettings.connectionId`。不能把 Base URL、Key 或 profile label 写入会话设置。
- 切到不支持分档的模型时删除不兼容 `reasoning_effort`；切到不支持或能力未知的模型时不发送
  `thinking`。Thinking 关闭时可保留会话内上次选择供再次开启，但 adapter 不得把 effort 发上游。
- `Auto` 以缺省字段表达，不持久化字面量 `auto`。无效、过期或跨厂商 effort 必须在 UI 转换和 adapter
  边界各自收窄。
- 用户未授权不得调用真实付费模型、发布、push、上传 artifact 或提交。协议测试使用注入 fetch。
- 执行 agent 不得派子 agent、不得 commit；只写声明的产品文件和 `reports/NNN-report.md`。独立 reviewer
  只写 `reports/NNN-review.md`。

## 任务树

- 100 能力与协议 (`group`)
  - [010](010-model-thinking-capabilities.md) 建立逐模型 Thinking 能力表 (`leaf`，依赖：无)
  - [015](015-model-thinking-defaults.md) 声明内置模型默认 Thinking 状态 (`leaf`，依赖：010，发现自：050)
  - [020](020-provider-thinking-projection.md) 收窄厂商 Thinking 请求 (`leaf`，依赖：010)
- 200 会话命令 (`group`)
  - [030](030-session-model-settings-command.md) 持久化当前会话模型设置 (`leaf`，依赖：无)
- 300 界面投影 (`group`)
  - [040](040-composer-model-options.md) 生成模型下拉选项 (`leaf`，依赖：010)
  - [045](045-composer-thinking-transitions.md) 归一模型 Thinking 变更 (`leaf`，依赖：010)
- 400 交互与交付 (`group`)
  - [050](050-bind-composer-model-controls.md) 绑定输入框模型控件 (`leaf`，依赖：030、040、045)
  - [055](055-composer-model-catalogs.md) 更新模型控件翻译目录 (`leaf`，依赖：050)
  - [065](065-materialize-default-thinking-effort.md) 让默认开启模型的具体档位真实生效 (`leaf`，依赖：015、045、050，发现自：060)
  - [060](060-thinking-controls-audit.md) 审核模型控件全链路 (`leaf`，依赖：020、030、050、055、065)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 建立逐模型 Thinking 能力表 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 015 | 声明内置模型默认 Thinking 状态 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 020 | 收窄厂商 Thinking 请求 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 030 | 持久化当前会话模型设置 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 040 | 生成模型下拉选项 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 045 | 归一模型 Thinking 变更 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 050 | 绑定输入框模型控件 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 055 | 更新模型控件翻译目录 | gpt-5.6-luna | done | 2026-08-21 | 2026-08-21 |
| 065 | 让默认开启模型的具体档位真实生效 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 060 | 审核模型控件全链路 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |

## 就绪集与模型分配

确认后先并行派 010（能力契约，Sol）与 030（会话命令，Terra）；始终预留一槽给独立 reviewer。010
审查通过后并行派 020（adapter，Terra）、040（模型选项，Terra）、045（纯设置转换，Terra），文件面
互不相交。三项通过后派 050（跨状态与视觉接线，Sol），再由 055（目录机械更新，Luna）收翻译；最后
060 用 Sol 做协议、持久化、界面和视觉的独立总审计。

## 跨层覆盖矩阵

| 编号 | 场景 | 实现 owner | 最终证据 owner |
| --- | --- | --- | --- |
| C-01 | DeepSeek V4 仅暴露 High/Max 并正确省略 Auto | 010、020 | 060 |
| C-00 | 缺省 thinking 按官方默认显示且首次点击语义正确 | 015、050 | 060 |
| C-02 | GLM-5.2 暴露官方正向档位并过滤无效值 | 010、020 | 060 |
| C-03 | GLM 4.5+ 非 5.2 模型只有开关且不发 effort | 010、020 | 060 |
| C-04 | Kimi K2.6 只有开关且保留既有消息编码 | 010、020 | 060 |
| C-05 | 老 GLM 与 openai-compat 不冒充 Thinking 能力 | 010、040 | 060 |
| C-06 | 当前会话修改成功、相等 no-op、无会话拒绝 | 030 | 060 |
| C-07 | 运行中命令拒绝且 UI 控件禁用 | 030、050 | 060 |
| C-08 | 会话切换、应用恢复后模型与 Thinking 不串话 | 030、050 | 060 |
| C-09 | 内置模型与 profile 多模型均进入下拉且 identity 不丢 | 040、050 | 060 |
| C-10 | 切模型清理跨厂商 effort 并保留兼容开关 | 045、050 | 060 |
| C-11 | Auto 以缺省表达，Off 时 effort 不上行 | 020、045 | 060 |
| C-12 | 中文、英文、键盘、窄窗口与 reduced-motion 可用 | 050、055 | 060 |

060 必须逐行给出通过证据；任何一行没有测试、源码证据或实机视觉证据都不能完成任务树。

## 验收总门

1. 模型下拉显示本地内置 catalog 与已配置 profile 的全部模型；切换后当前会话的 vendor、model、
   connectionId 精确更新，另一个会话不受影响。
2. Thinking 是独立 On/Off 按钮；档位随模型能力实时变化。DeepSeek V4、GLM-5.2、仅开关模型、
   不支持模型和能力未知模型五类状态都有测试。
3. 切换与重启恢复走既有 session persistence；不新增 UI-only 真值源，不改变未来新会话默认或子 Agent
   routing。
4. DeepSeek、GLM、Kimi 的 fetch 注入测试证明 wire body 与官方协议一致；disabled、Auto、脏 effort、
   跨模型 effort 均不产生非法请求字段。
5. 控件在空闲时可操作，任何 active/paused run 状态都不可改变设置；命令层即使绕过 UI 也拒绝。
6. 桌面宽窗口与 720px 以下窄窗口均无截断/溢出，原有授权模式、排队状态、附件和发送快捷键不回归；
   键盘 focus、aria 状态和 reduced-motion 合格。
7. `pnpm exec tsc -b`、`pnpm check:state`、`pnpm check:boundaries`、`pnpm lingui:extract --clean`、
   `pnpm lingui:compile`、相关 Vitest、`pnpm build` 及 `git diff --check` 全部通过。
8. 所有新增/大改普通文件经 `wc -l` 不超过 300 行；路过的存量超限只报告，不借机重构。

## 决策与变更

- 裁决：能力表进入 agent-ai descriptor，而不是 web 常量 — adapter 与 UI 必须读取同一事实源；错了的
  代价是公共 descriptor 多一个只读字段，但避免两份档位长期漂移。
- 裁决：按当前会话持久化，不修改全局默认 — 用户明确要求“针对每个 agent/对话框”；错了的代价是新建
  对话不会自动继承刚才的选择，若以后需要可另加“设为默认”动作而不混淆本控件。
- 裁决：自定义兼容连接能力未知 — profile 当前没有可信 capability manifest，按模型字符串猜测会错误
  发送私有字段；错了的代价是部分兼容服务暂时不能在此切 Thinking，未来需扩 profile manifest。
- 裁决：GLM 的 `minimal|none` 归 Off，不作为档位 — 两者官方语义都是放弃思考；错了的代价是不能逐字
  选择这两个别名，但界面只有一个明确的关闭语义。
- 裁决：Kimi K2.6 只给开关 — 官方资料没有给该模型固定 `support_efforts` 列表；错了的代价是若服务端
  后续公布分档，需要更新本地能力表后才显示。
- 2026-08-21：用户确认开工；010 与 030 已按首个就绪集并行派发。
- 2026-08-21：030 执行及独立审查通过；当前会话命令的 busy/no-op/missing、CoreInstance 持久化与
  opaque vendor bag 保留均闭合。`packages/agent-core/src/index.ts` 现为 296 行，后续任务不得继续扩写。
- 2026-08-21：010 执行及独立审查通过；17 个内置模型的 capability、精确 lookup、稳定只读枚举与
  unknown 不继承执行 fallback 均闭合。020、040、045 已按第二个就绪集并行派发。
- 2026-08-21：040 执行及独立审查通过；内置全量、profile 多模型、稳定 key、缺失当前模型与秘密字段
  边界均闭合。045 首轮审查因同 vendor identity bag 合并风险拒绝，已退回原执行者做限定 R1。
- 2026-08-21：020 首轮审查因 Thinking object extra 字段上行及两条全套装配断言未收敛而拒绝；将直接
  相关的 `builtinProviders.test.ts` 加入该叶 files 后做限定 R1，文件不得超过 300 行。
- 2026-08-21：045 R1 经独立复审通过；profile A→B、profile→legacy 与显式 identity bag 保留合法
  effort/opaque settings 均有直接回归证据，High/Medium findings 闭合。
- 2026-08-21：020 R1 经独立复审通过；Thinking object canonicalization、装配断言与 28 files / 235 tests
  的 agent-ai 全套门闭合，`builtinProviders.test.ts` 保持 298 行。050 已解锁并派发。
- 2026-08-21：050 首轮独立审查 REJECT：`settings.thinking === undefined` 被显示成显式 Off，默认开启
  模型首次点击无法关闭。根因包含 010 未填 `defaultEnabled`；发现 015 补官方默认，050 随后做限定 R1。
- 2026-08-21：015 执行及独立审查通过；14 个 supported 内置模型显式 `defaultEnabled:true`，
  unsupported/unknown 不获得默认。050 已交原执行者做 provider-default 限定 R1。
- 2026-08-21：050 R1 经独立复审通过；provider-default、首次点击 Off、显式 true/false 与宽/窄中英文
  视觉均闭合。055 已解锁并派发。
- 2026-08-21：055 执行发现任务中的 catalog 路径为旧路径，已按 Lingui 配置更正到
  `apps/web/src/i18n/locales/`；当前 CLI 不支持 `lingui status`，用 extract 的 English Missing 0 验收。
- 2026-08-21：055 执行及独立审查通过；5 条模型控件英文文案、中文原文、extract Missing 0 与 compile
  均闭合。060 最终 coverage audit 已派发。
- 2026-08-21：060 执行与独立复核均确认 REJECT：DeepSeek V4/GLM-5.2 在 provider-default On 下直接
  选择具体 effort 时未物化 `thinking:true`，adapter 会按 fail-closed 契约丢弃档位；C-00～C-02 未闭合。
  新增发现叶 065 做限定修复，060 回到 pending，待 065 独立审查后重新终审。core 全套 temperature 红测
  经 reviewer 更正为基线已有矛盾，不归因于并行改动，也不影响本树缺陷裁决。
- 2026-08-21：065 执行及独立审查通过；仅在 default-enabled effort capability、缺省 thinking 与合法具体
  effort 同时成立时物化 `thinking:true`，显式 Off/On、Auto、非法值及无档位能力均不放宽。原 060 审计
  从 2/2 fail 转为 2/2 pass；060 已重新派发 R1 全树终审。
- 2026-08-21：060 R1 执行及独立复审通过；C-00～C-12 全部闭合，10 个跨层重点文件 90 tests、类型、
  state/boundaries、Lingui（English Missing 0）、生产构建、diff 与文件行数经编排者最终复跑通过。任务树
  标记完成；未提交、发布或调用真实付费模型。
- 2026-08-31：全量测试发现 GLM Turbo toggle-only 与 DeepSeek 精确模型能力的旧跨包夹具仍按旧契约断言，
  测试同步交由 `integration-closure/020`。用户授权审查后分批 commit。
- 2026-08-31：`integration-closure/050` 全量门与最终独立审查 APPROVED，跨树收口完成。
