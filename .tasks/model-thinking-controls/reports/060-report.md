# 060 全链路终审报告

## 结论

**REJECT — 需退回 050/045 交互链路修复后重审。**

- Blocker：无。
- Important：1 项。缺省 Thinking 按 provider 默认显示为 On 时，直接选择 effort 不会让该 effort 在实际
  请求中生效；DeepSeek V4 与 GLM-5.2 均可稳定复现。
- Minor：无新增。
- C-00、C-01、C-02 未闭合；C-03～C-12 有直接证据。任务树当前不能标 done。

## Important finding

### [Important] provider-default On 状态下直接选择 effort，UI 持久化的选择不会上行

定位与证据：

1. `packages/agent-ai/src/builtinModelDescriptors.ts:58-70` 为 DeepSeek V4 与 GLM-5.2 声明
   `defaultEnabled: true`；官方文档也分别声明 Thinking 默认 enabled。
2. `apps/web/src/agentNew/ui/ComposerControlBar.tsx:64-69` 因该默认值把缺省
   `settings.thinking` 显示为 On，并启用 effort radio。
3. 用户点 Max 后，`apps/web/src/agentNew/ui/composerModelSettings.ts:108-123` 写入 effort，却把
   `current.thinking`（仍为 `undefined`）原样传给 `writeSettings`，因而没有写入 `thinking:true`。
4. `packages/agent-core/src/runtime/modelTurnRequester.ts:74-77` 把缺省 thinking 投影为缺失字段；
   `packages/agent-ai/src/builtinProviders.ts:117-123` 又明确要求 canonical Thinking 为 enabled 才发送 effort。
   既有协议测试 `thinkingRequestProjection.test.ts:82-98` 也钉住“未显式 enabled 时不发 effort”。
5. 新增 `apps/web/src/agentNew/ui/ComposerModelControls.audit.test.tsx:25-53` 从真实 Composer 与
   command 路径覆盖 DeepSeek V4 Pro、GLM-5.2：两例都先断言按钮为 `aria-pressed=true`，点击 Max 后
   实际 settings 只有 `reasoning_effort:'max'`，缺少预期 `thinking:true`；**2/2 失败**。

用户影响：新会话、旧会话或切模型后仍采用 provider 默认 On 的 effort 模型，用户第一次直接选择
High/Max 等档位会看到选择被保存，但 adapter 会静默省略该 effort。必须先把 Thinking 点成 Off 再点回
On，档位才会生效；这是可见控件与真实 wire 行为不一致。

建议修复边界：由 045/050 明确收敛“默认 On 下选择具体 effort”的语义，并保留 020 的 fail-closed wire
防线。060 不修改产品实现。

## C-00～C-12 覆盖矩阵

| 编号 | 结论 | 直接证据 |
| --- | --- | --- |
| C-00 | **FAIL** | default capability 与首次 toggle 已由 `builtinThinkingCapabilities.test.ts`、`ComposerModelControls.integration.test.tsx:96-111` 证明；但新增 audit test 证明默认 On 后首次 effort 操作无效，见 Important。 |
| C-01 | **FAIL** | DeepSeek 仅暴露 Auto/High/Max、显式 enabled wire、Auto 省略均通过 `ComposerThinkingControl.test.tsx:26-39` 与 `thinkingRequestProjection.test.ts:47-69`；默认会话直接选 Max 的端到端路径失败。 |
| C-02 | **FAIL** | GLM-5.2 五个正向档位及脏值过滤由 `builtinThinkingCapabilities.test.ts`、`thinkingRequestProjection.test.ts:53-58` 证明；默认会话直接选 Max 的端到端路径失败。 |
| C-03 | PASS | `builtinModelDescriptors.ts:117-126` 将其余 GLM 设为 toggle-only；`thinkingRequestProjection.test.ts:59,135-146` 证明不发 effort/旧模型无 Thinking 字段。 |
| C-04 | PASS | `builtinModelDescriptors.ts:131-137` 为 Kimi K2.6 toggle-only；`thinkingRequestProjection.test.ts:148-155` 与 `kimiChat.test.ts` 证明只保留开关及既有消息编码。 |
| C-05 | PASS | `builtinModelDescriptors.ts:127-139`、`thinkingRequestProjection.test.ts:135-174` 与 Thinking 组件测试证明旧 GLM unsupported、未知/openai-compat 不冒充能力。 |
| C-06 | PASS | `modelSettingsCommands.test.ts` 覆盖 updated/no-op/missing、updatedAt、单次 persist 与 sibling 隔离；专项 core 5 files/31 tests 通过。 |
| C-07 | PASS | command 的 `modelSettingsCommands.ts:34-46` 与 UI 的 `Composer.tsx:75-77` 双层 fail closed；`ComposerModelControls.integration.test.tsx:113-133` 逐项覆盖全部 busy/settled 状态。 |
| C-08 | PASS | 新增 `modelSettingsPersistence.integration.test.ts` 使用共享内存 driver，真实执行 command 写盘并在全新 Core hydrate；完整 settings 精确恢复，sibling 保持不变，1/1 通过。ActiveSessionProvider/Composer 会话切换测试也通过。 |
| C-09 | PASS | `composerModelOptions.test.ts` 覆盖 17 个内置项、profile 多模型、稳定 key、秘密字段负断言；Composer 集成测试证明 `openai-compat + connectionId` 精确写入。 |
| C-10 | PASS | `composerModelSettings.test.ts` 12 tests 覆盖 profile A→B/A→legacy、跨 vendor 清袋、toggle-only/unsupported/unknown 收窄及 opaque bag 保留。 |
| C-11 | PASS | `composerModelSettings.test.ts` 证明 Auto 删除字段、Off 保留合法选择；`thinkingRequestProjection.test.ts:47-98` 证明 Auto 与 Off 均不上行 effort、脏值 fail closed。Important 是具体 effort 在默认 On 下未显式 enable 的另一条路径。 |
| C-12 | PASS | feature 专项 Web 9 files/58 tests 通过；native select、`aria-pressed`、唯一 radio name、disabled 与 Shift+Tab 有直接测试/源码证据。独立复核 050 三张宽/窄中英文截图及 CSS，详见下节。 |

## 视觉与可访问性复核

- 用原始分辨率实际打开 `/tmp/model-thinking-050-desktop-final2.png`（1440×900）、
  `/tmp/model-thinking-050-narrow-final3.png`（640×900）和
  `/tmp/model-thinking-050-narrow-en.png`（640×900）。桌面控件无覆盖；640px 中文/英文中模型、开关、
  六档 radio、授权状态、输入区、附件与发送按钮均换行完整，无可见横向溢出或文字截断。
- 050 的 CDP 记录为稳定后三次 console warning/error、runtime exception、非取消 request failure 均为 0；
  启动订阅前仅有已记录的 Lingui locale 加载时序提示。060 没有发现截图与记录不一致之处。
- `ComposerModelPicker.tsx:48-67` 使用有 label 的 native select/optgroup；长标签同时保留 title。
  `ComposerThinkingControl.tsx:41-87` 提供 group、`aria-pressed`、radio accessible name 与 disabled 语义。
- `ComposerModelPicker.css:16-19`、`ComposerThinkingControl.css:50-53,161-164` 有键盘 focus ring；
  `ComposerThinkingControl.css:166-191` 处理 ≤720px 换行，`:193-199` 关闭 reduced-motion 动画。
- 仓库没有 `.shared/visual-runtime`，因此无法追加 `visual_lint.mjs`；本次按 050 的 CDP 指标、原图人工复核、
  组件测试和源码检查闭合 C-12。未调用真实模型或产生模型 API 请求。

## 执行命令与结果

### 功能专项

- `pnpm exec vitest run packages/agent-ai/src` — **PASS**，28 files / 250 tests。
- core command/persistence/hydrate 专项（5 个文件）— **PASS**，5 files / 31 tests；包含新增的
  `modelSettingsPersistence.integration.test.ts` 1/1。
- 010～055 Web 专项（ActiveSessionProvider、Composer、Picker、Thinking、controls integration、options、
  settings、i18nConversation、AppShell）— **PASS**，9 files / 58 tests。
- `pnpm exec vitest run apps/web/src/agentNew/ui/ComposerModelControls.audit.test.tsx` —
  **FAIL（本树 Important）**，1 file / 2 tests，DeepSeek 与 GLM-5.2 均缺 `thinking:true`。

### 全套与全局门禁

- `pnpm exec vitest run packages/agent-core/src --reporter=dot` — **FAIL**，201 files / 1703 tests 通过，
  1 file / 1 test 失败。失败在 `modelRun.requestProjection.test.ts:53`：共享工作区当前发送
  `temperature:0.5`，存量断言仍要求不含 temperature；同用例的 Thinking/effort 断言未失败。该文件与
  采样投影不属于 010～060 files，归因于并行在途改动，不是上述 Important 的替代证据。
- `pnpm exec vitest run apps/web/src --reporter=dot` — **FAIL**，144 files / 943 tests 通过，4 tests 失败：
  两条是本树 audit Important；另两条为 `BrowserActionCard.test.tsx` 直接 render 缺 I18nProvider，
  `BrowserActionCard` 不在本树 files，归因于共享 i18n 在途改动。
- `pnpm exec tsc -b --pretty false` — **PASS**。
- `pnpm check:state` — **PASS**，扫描 882 个非测试 TS/TSX 文件。
- `pnpm check:boundaries` — **PASS**，仅输出登记过的 modelMigration/core subpath 观察项。
- `pnpm lingui:extract --clean` — **PASS**，zh-CN/en 各 483 条，English Missing 0；两份 PO 前后
  SHA-1 不变。
- `pnpm lingui:compile` — **PASS**。
- `pnpm build` — **PASS**；仅有既存 dynamic/static import 与大 chunk 警告。
- `git diff --check` — **PASS**；另对本树 21 个未跟踪源码/测试/catalog 逐个执行
  `git diff --no-index --check /dev/null <file>`，无 whitespace error。

## 行数与职责审计

- 010～055 新增/大改普通文件全部 ≤300 行。接近上限者：`builtinProviders.test.ts` 298、
  `packages/agent-core/src/index.ts` 296、`Composer.tsx` 293、`Composer.test.tsx` 280、
  `builtinProviders.ts` 260；均未越线。
- 两个 060 专责测试分别为 53 行（Web 缺省 effort 链路）与 58 行（core settings 持久化往返），职责单一。
- 两份 PO 各 2048 行，属于明确的 i18n 资源例外。
- `packages/agent-ai/src/deepseek.test.ts` 359 行是存量超限文件；本树没有修改它，020 已把新增协议场景放在
  独立的 175 行 `thinkingRequestProjection.test.ts`，本审计不越界重构。
- 未发现 `utils/common/partN` 假拆分或新增文件混合业务层与通用抽象。

## 本叶文件清单

- 新增 `apps/web/src/agentNew/ui/ComposerModelControls.audit.test.tsx`：暴露 Important，当前预期红 2 tests。
- 新增 `packages/agent-core/src/runtime/modelSettingsPersistence.integration.test.ts`：补 C-08 跨层证据，1 test passed。
- 新增本报告 `.tasks/model-thinking-controls/reports/060-report.md`。

未修改任何产品实现、任务文件、index/status；未提交、暂存、reset、stash、清理用户改动或调用真实付费模型。
