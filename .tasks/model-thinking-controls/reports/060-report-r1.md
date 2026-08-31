# 060 R1 全链路终审报告

## 结论

**APPROVE**

- Blocker：无。
- Important：无。原 060 的 1 项 Important 已由 065 在产品边界真实闭合，未弱化审计断言或 adapter
  fail-closed 防线。
- Minor：无新增。
- C-00～C-12 全部有直接源码、测试及必要视觉证据，当前任务树可进入独立 review。

## 原 Important 闭合证据

DeepSeek V4 与 GLM-5.2 的 default-On→具体 effort 链路现已完整闭合：

1. `builtinModelDescriptors.ts:58-70` 仍将两家声明为 `defaultEnabled:true`，合法档位表未放宽。
2. `composerModelSettings.ts:108-129` 只在当前 `thinking === undefined`、capability 为 default-enabled
   effort、且选中合法具体 effort 时物化 `thinking:true`；显式 false/true、Auto、非法 effort、
   toggle-only、unsupported、unknown 均保留原语义。纯转换测试 `composerModelSettings.test.ts:175-214`
   逐项覆盖这些正负分支。
3. 原 060 强断言 `ComposerModelControls.audit.test.tsx:28-51` 未改弱：真实
   `ActiveSessionProvider → Composer → command` 对 DeepSeek/GLM 都先验证 UI 为 On，再点击 Max，最终
   Session settings 精确包含 `thinking:true` 与 `reasoning_effort:'max'`；R1 为 **2/2 PASS**。
4. core 的持久化审计 `modelSettingsPersistence.integration.test.ts:21-56` 真实 command 写盘并由全新 Core
   hydrate，完整 settings 精确恢复且 sibling 不变；**1/1 PASS**。
5. adapter `builtinProviders.ts:108-123` 仍只有在 canonical Thinking 为 enabled 且 effort 合法时发送
   effort。`thinkingRequestProjection.test.ts:47-69` 直接捕获最终 fetch body，DeepSeek/GLM 合法档位均上行；
   `:82-98` 继续证明缺显式 enabled 时两家都不发送 Thinking/effort。三段闭环组合 **3 files / 24 tests
   PASS**。

因此 Composer 写出的 `thinking:true + effort` 会经 command/persistence 保留，并满足 adapter 的最终 wire
前置条件；原先“界面显示 On，但第一次选档位被静默丢弃”的路径不再存在。

## C-00～C-12 逐行裁决

| 编号 | 结论 | 直接证据 |
| --- | --- | --- |
| C-00 | PASS | capability 默认值与首次 toggle 由 `builtinThinkingCapabilities.test.ts`、`ComposerModelControls.integration.test.tsx:96-111` 覆盖；default-On 首次具体 effort 由 060 audit 的 DeepSeek/GLM 2/2 正向闭合。 |
| C-01 | PASS | DeepSeek 仅有 Auto/High/Max，显式 enabled/Auto wire 由 Thinking 组件与 `thinkingRequestProjection.test.ts:47-69` 覆盖；default-On→Max 审计通过。 |
| C-02 | PASS | GLM-5.2 的 low/medium/high/xhigh/max、disabled alias 与脏值过滤均有 capability/wire 断言；default-On→Max 审计通过。 |
| C-03 | PASS | `builtinModelDescriptors.ts:117-126` 将其余 GLM 设为 toggle-only；wire 用例证明不发 effort，旧 GLM 无 Thinking 字段。 |
| C-04 | PASS | `builtinModelDescriptors.ts:131-137` 将 Kimi K2.6 设为 toggle-only；wire 与 `kimiChat.test.ts` 证明无伪造 effort且消息编码不变。 |
| C-05 | PASS | 老 GLM 为 unsupported，未知/openai-compat 为 unknown；capability、组件与 wire 负断言证明不会冒充 DeepSeek 能力。 |
| C-06 | PASS | `modelSettingsCommands.test.ts` 覆盖 updated/no-op/missing、updatedAt、单次 persist 与 sibling 隔离；core 专项通过。 |
| C-07 | PASS | command 的 `modelSettingsCommands.ts:34-53` 与 UI 的 `Composer.tsx:75-77` 双层 fail closed；controls integration `:113-133` 覆盖全部 busy/settled 状态。 |
| C-08 | PASS | 060 persistence integration 精确验证新 Core hydrate 与 sibling 隔离；ActiveSessionProvider/Composer 会话切换测试同时通过。 |
| C-09 | PASS | `composerModelOptions.test.ts` 覆盖 17 个内置项、profile 多模型、稳定 key 与秘密字段负断言；Composer integration 精确写入 `openai-compat + connectionId`，既有 route 身份测试保持通过。 |
| C-10 | PASS | `composerModelSettings.test.ts` 13 tests 覆盖 profile identity、跨 vendor 清袋、toggle-only/unsupported/unknown 收窄、opaque bag 保留及 065 的 default-On 物化边界。 |
| C-11 | PASS | Auto 删除 effort、Off 不上行 effort、脏值 fail closed 均有纯转换和最终 fetch body 断言；adapter 防线未放宽。 |
| C-12 | PASS | Web 专项 10 files / 61 tests 通过；native select、aria、radio name、busy、Shift+Tab、focus、窄窗与 reduced-motion 均有测试/源码/视觉证据。 |

## 视觉与可访问性复核

- 065 只改纯 settings 转换及其测试，没有 DOM/CSS 变化。R1 仍以原始分辨率重新打开
  `/tmp/model-thinking-050-desktop-final2.png`（1440×900）、
  `/tmp/model-thinking-050-narrow-final3.png`（640×900）与
  `/tmp/model-thinking-050-narrow-en.png`（640×900）。桌面与窄窗中英文均无控件覆盖、文字截断或可见横向
  溢出，模型、On/Max、radio、授权、输入、附件与发送动作完整可见。
- 050 稳定态 CDP 记录的 console warning/error、runtime exception、非取消 request failure 均为 0；仅有
  启动订阅前已登记的 Lingui locale 时序提示。R1 没有改变该表面，也没有调用真实模型。
- `ComposerModelPicker.tsx` 使用有 label 的 native select/optgroup；`ComposerThinkingControl.tsx` 提供 group、
  `aria-pressed`、radio accessible name 与 disabled。对应 CSS 保留 `:focus-visible`、≤720px 换行及
  `prefers-reduced-motion`。
- 仓库没有 `.shared/visual-runtime`，故没有伪称运行 visual lint；本项由原图复核、组件测试、源码语义和
  050 CDP 记录共同闭合。

## 执行命令与结果

### 专项与闭环

- `pnpm exec vitest run packages/agent-ai/src` — **PASS，28 files / 250 tests**。
- `pnpm exec vitest run packages/agent-core/src/runtime/commands/modelSettingsCommands.test.ts packages/agent-core/src/runtime/modelSettingsPersistence.integration.test.ts packages/agent-core/src/runtime/persistenceBridge.test.ts packages/agent-core/src/state/persistence/hydrate.test.ts packages/agent-core/src/state/persistence/hydrate.modelMigration.test.ts` — **PASS，5 files / 31 tests**。
- Web 010～065 专项（ActiveSessionProvider、Composer、Picker、Thinking、controls integration/audit、options、
  settings、i18nConversation、AppShell）— **PASS，10 files / 61 tests**。
- `pnpm exec vitest run apps/web/src/agentNew/ui/ComposerModelControls.audit.test.tsx packages/agent-core/src/runtime/modelSettingsPersistence.integration.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts` — **PASS，3 files / 24 tests**。

### 全局门禁

- `pnpm exec tsc -b --pretty false` — **PASS**。
- `pnpm check:state` — **PASS**，882 个非测试文件。
- `pnpm check:boundaries` — **PASS**，897 个非测试文件；仅有已登记的 modelMigration/core subpath 观察项。
- `pnpm lingui:extract --clean` — **PASS**，zh-CN/en 各 483 条，English Missing 0；catalog 前后 SHA-1
  分别保持 `6794ed3be54a02d5dedbe8e702c884005bc5c84a` 与
  `93d85b784a3efd108442217bc7dedaf92cdb8b3f`。
- `pnpm lingui:compile` — **PASS**。
- `pnpm build` — **PASS**；仅有既存 dynamic/static import 与 chunk >500 kB 警告。
- `git diff --check` — **PASS**；全树 23 个未跟踪声明源码/测试/catalog 逐个执行
  `git diff --no-index --check /dev/null <file>`，0 whitespace failures。

按 parent 与 `060-review.md` 的更正，本 R1 不重复耗时全仓测试：core 全套 temperature 红项是基线
`c7befb48...` 已同时存在投影与相反断言的树外矛盾，不是并行改动；BrowserActionCard 两条缺
I18nProvider 红项来自树外工作区改动。两类均不属于 010～065 文件面，也不影响上述专项与闭环证据。

## 行数与职责审计

- 全树新增/大改普通文件均 ≤300 行。接近上限者为 `builtinProviders.test.ts` 298、core `index.ts` 296、
  `Composer.tsx` 293、`Composer.test.tsx` 280、`builtinProviders.ts`/`deepseek.ts` 各 260；职责未混合。
- 065 两个文件为 138/215 行，分别只负责设置转换及其纯函数测试；060 两个实际新增审计测试为 53/58 行，
  分别只负责 Composer default-On command 闭环与 core settings 持久化往返。
- 预留的 `thinkingControls.integration.test.ts` 未创建，因为现有 Composer audit、core persistence 与最终
  fetch body 测试已给出完整三段证据；不制造重复测试。任务声明中的 `glm.test.ts` 同样由专责的 175 行
  `thinkingRequestProjection.test.ts` 承载协议覆盖。
- 两份 PO 各 2048 行，属于 i18n 资源例外；`deepseek.test.ts` 359 行是未修改的存量超限文件。本审计未
  越界重构，未发现 `utils/common/partN` 假拆分。

## 本叶文件清单与范围

- 保持不变：`apps/web/src/agentNew/ui/ComposerModelControls.audit.test.tsx`（53 行，2/2 PASS）。
- 保持不变：`packages/agent-core/src/runtime/modelSettingsPersistence.integration.test.ts`（58 行，1/1 PASS）。
- 新增：`.tasks/model-thinking-controls/reports/060-report-r1.md`。

未修改任何产品实现、审计断言、task/index/status；未提交、暂存、reset、stash、清理共享改动或派发子 agent。
