# 060 最终执行审计

状态：`DONE_WITH_CONCERNS`

基线：`5ad0f617571f96de36305019c531a258c0fb4e25`

## 结论

C-01～C-13 均有源码与可执行测试证据，最终类型、全量测试、状态/边界、Lingui、build、diff、
退役 ID 与文件行数门全部通过。没有发现需要退回 010～055 的产品缺陷，也没有真实跨层测试缺口，
因此未创建任务卡预留的两个 060 测试文件，未修改产品代码。

浏览器使用注入 `fetch` 的假凭据进入本地服务，全程没有发送模型请求。`pnpm build` 后成功复验新版
六模型 DOM、DeepSeek 与 Kimi 控件；随后原服务 PID 45068 退出且 4765 不再监听。遵守“不重启、
不占新端口”，GLM 浏览器切换、窄窗与键盘未继续做存活页面人工操作，改用已经通过的真实 Composer
组件测试、语义 DOM 与响应式 CSS 作为可重复证据。这是验收环境可用性疑虑，不是产品 finding。

## C-01～C-13 evidence matrix

| 行 | 判定 | 证据 |
| --- | --- | --- |
| C-01 | ✅ | `builtinModelDescriptors.ts:96-120` 只登记 3 DeepSeek + 2 GLM + 1 Kimi；`builtinThinkingCapabilities.test.ts:5-29` 精确数组断言顺序/显示名；`composerModelOptions.test.ts:23-31` 对拍 registry；新版浏览器 a11y DOM 的 combobox 也精确显示六项。 |
| C-02 | ✅ | descriptor `:53-58` 给三个 DeepSeek `low/high/max` 且非 required；`builtinThinkingCapabilities.test.ts:32-50` 与 `ComposerThinkingControl.test.tsx:31-46` 断言 Auto/Low/High/Max；新版 DOM 实见四档与可操作 pressed On。 |
| C-03 | ✅ | `builtinProviders.ts:110-145` 只在 enabled + 合法档位时投影；`deepseekThinkingEffort.test.ts:40-58` 与 `thinkingRequestProjection.test.ts:47-65` 用注入 fetch 覆盖 low/high/max、Auto、Off、历史/脏值。 |
| C-04 | ✅ | descriptor `:60-66,107-110` 将两个 GLM 标为 required 三档；`builtinThinkingCapabilities.test.ts:52-74` 验证两个实际 SKU；`ComposerThinkingControl.test.tsx:48-64,91-110` 验证 disabled + pressed On、Auto/Low/High/Max 仍可选。 |
| C-05 | ✅ | `builtinProviders.ts:147-167` 强制 `thinking:{type:'enabled'}` 并白名单 effort；`glm53Protocol.test.ts:40-74` 对两个 SKU 覆盖缺失/disabled/非法 thinking、三档、Auto 与脏 effort。 |
| C-06 | ✅ | descriptor `:68-74,111-117` 将 K3 标为 required 三档；`builtinThinkingCapabilities.test.ts:82-98` 断言真实 capability；新版浏览器切到 Kimi K3 后实见 disabled + pressed 的“Thinking 始终开启”和 Auto/Low/High/Max。 |
| C-07 | ✅ | `builtinProviders.ts:169-191` 删除 K2.x `thinking`、仅发送合法 effort；`kimiK3Protocol.test.ts:40-151` 覆盖 low/high/max、Auto、脏值、direct call/stream、CN/global，全部注入 fetch。 |
| C-08 | ✅ | `kimiFiles.ts:66-168` 验证 CN 上传、`ms://`、部分失败/取消 cleanup 与幂等 rollback；`kimiMessages.ts:25-56` 验证最终引用；`historyImageCompatibility.ts:45-61` 验证历史引用/降级。对应 7 个图片专项测试在前叶通过，本轮全量测试继续全绿。公开 build flag 默认关闭 UI rollout，不改变 adapter 链路证据。 |
| C-09 | ✅ | descriptor `:100-105` 保留 Vision 与图片 capability；`deepseekCatalog.test.ts`、`deepseekMessages.test.ts`、`prepareProviderUserInput.test.ts`、`apps/web/src/vision/deepseekImageViewer.test.ts` 在本轮全量测试中通过，后者使用注入 fetch 验证 `view_image`。 |
| C-10 | ✅ | `defaultTierRoutingTable.ts:26-74` 只引用当前 DeepSeek/GLM/Kimi 常量；`defaultTierRouting.test.ts:43-94,97-190` 对拍 registry 并验证 GLM/Kimi 实际抽取 wire。 |
| C-11 | ✅ | `modelThinkingCapability.ts:59-65` 精确查询、未知即 unknown；`modelThinkingCapability.test.ts:13-44` 覆盖未知 vendor/model 与伪装官方 ID 的 openai-compat；`composerModelOptions.test.ts:34-86` 保留 profile identity 与 missing current，不静默冒充内置模型。 |
| C-12 | ✅ | 退役 ID 扫描在 `packages apps -g '!**/gen/**'` 为零命中；全仓 hidden 扫描剩余项仅历史账本、`.project-lines` 学习记录和三份文档 allowlist，见下节。 |
| C-13 | ✅* | 新版 a11y DOM 证明中文 combobox、button、radio 名称/pressed/disabled 正确；`ComposerModelControls.integration.test.tsx:57-133` 覆盖真实模型切换、会话隔离与 busy keyboard control 状态；`ComposerThinkingControl.tsx:45-92` 使用原生 button/radio/group/aria，`ComposerThinkingControl.css:166-191` 与 `ComposerModelPicker.css:74-79` 提供 ≤720px 换行/全宽布局，`:50-53,161-164` 提供 focus-visible。Lingui extract/compile 验证中英文目录。`*` 剩余人工窄窗/键盘操作因服务退出用可重复组件/DOM/CSS 证据收口，未声称截图。 |

## 命令结果

| 命令 | 结果 |
| --- | --- |
| 代表性 Vitest（目录、三家 wire、图片、routing、Composer/fallback 16 files） | 16 files / 102 tests 全过。 |
| `pnpm exec vitest run` | 708 files：705 passed / 3 skipped；5927 tests：5924 passed / 3 skipped；无失败。 |
| `pnpm exec tsc -b --pretty false` | exit 0，无诊断。 |
| `pnpm check:state` | 5 rules 通过；22 workspaces / 902 非测试 TS/TSX。 |
| `pnpm check:boundaries` | 7 rules 通过；918 非测试 TS/TSX；仅既有 migration/public-surface 豁免。 |
| `pnpm lingui:extract --clean` | 通过；zh-CN/en 均 483 条，en 既有 missing 1。 |
| `pnpm lingui:compile` | 通过；两份生成 `messages.js` 在验证后精确恢复，无新增工作树差异。 |
| `pnpm build` | 通过；Vite 1262 modules，server tsup 与 web-dist embed 成功；仅既有 chunk/dynamic-import warnings。 |
| `git diff --check 5ad0f61...` | 通过，无输出。 |

## 退役 ID allowlist

执行的产品扫描模式包括旧 `glm-4.7[-flash]`、`glm-4.5-flash/4.6/4-long/5.1/5.2/5-turbo`
及 `kimi-k2.6`/`Kimi K2.6`/`KIMI_K2_6`。`packages/`、`apps/`（排除 `gen`）零命中。

全仓 `--hidden` 复扫共 96 行，唯一文件类别为：

- 旧 `.tasks/` 任务卡/报告（含本树前叶对历史 ID 的审计叙述）；
- 用户既有 `.project-lines/SKILL.md` 与模型 adapter 学习记录；
- `docs/image-input-rfc.md`、`docs/kimi-provider-integration-blueprint.md`（历史设计）；
- `docs/launch/competitor-facts.md`（竞品事实）。

当前 README、文档索引、repo metadata 与 `docs/model-adapter-compatibility.md` 均无退役目录陈述，不在
allowlist。

## 视觉 / DOM 验收

- 环境：`http://127.0.0.1:4765/`，以页面初始化脚本只截获
  `/api/invoke/model_credential_status` 并返回 `{configured:true,source:'config'}`；其余 fetch 原样。
  未输入真实 Key、未点击发送、未调用模型。
- build 前服务曾显示旧 GLM/Kimi 静态产物；完成要求的 `pnpm build` 后硬刷新，同一 URL 立即显示精确
  六模型，证明审计对象是新产物而非旧缓存。
- DeepSeek V4 Pro：combobox 选中，Thinking button `pressed=true` 且可关闭；Auto checked，Low/High/Max
  存在；Vision 也在选择器中。
- Kimi K3：模型切换成功；Thinking button accessible name/title 均为“Thinking 始终开启”，
  `disabled=true`、`pressed=true`；Auto/Low/High/Max 均存在且 effort radio 可用。
- 未保存截图。原服务随后退出，故 GLM 选择、English 点击、窄窗 resize 与实际 Tab/Arrow 操作没有继续
  声称为浏览器实测；相应可重复组件/DOM/CSS 证据已列在 C-04/C-13。

## 文件规则与工作树隔离

- 060 没有新增/修改产品或测试文件；两个预留测试文件不存在，因为没有证据缺口。
- 本树新增/大改的普通源码/测试均 ≤300 行；复核集合最大为既有
  `packages/agent-ai/src/builtinProviders.test.ts` 298 行，生产 `builtinProviders.ts` 290 行；专项新测试
  最大 `kimiK3Protocol.test.ts` 153 行。文件职责均可单句描述。PO 为 i18n 资源例外。
- 已识别并未触碰用户脏改：`.gitignore`、`CLAUDE.md`、`.project-lines/**`、UndoBar 删除、
  `agentnew.css`/`agentnew.shell.css`/`agentnew.subagent-trace.css`、未跟踪
  `agentnew.workspace-sidebar.css` 与 `apps/desktop/gen/**`。
- 055 的未提交测试/文档/PO 差异按 base 审计并保留；未暂存、未提交、未 reset/checkout。
- 本叶只新增本报告；`wc -l` 低于 300 行。

## Verdict

`DONE_WITH_CONCERNS`

产品覆盖与全部发布门通过，无需回退原叶。唯一疑虑是 build 后既有本地 Web 服务退出，导致最后几项
人工浏览器操作只能由已经通过的组件 DOM 测试与响应式源码证明；应由后续独立 reviewer 在服务恢复后
选择是否补一次窄窗/键盘人工抽查，不影响当前产品审计结论。
