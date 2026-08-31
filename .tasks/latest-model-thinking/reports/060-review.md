# 060 最终独立审查

结论：`NEEDS_CHANGES`。

六个内置模型、三家 Thinking/wire、两条图片链路、自定义 profile/fallback、routing、当前文档与
构建门均闭合；但 C-12 与 C-13 各有一项 Important 缺口。两项都属于 055 的夹具/i18n 收口范围，
应由 055 R1 限定修复后重审。执行者因服务退出留下的浏览器 concern 已被真实浏览器复验解除；终审
不批准的原因是复验新发现的产品英语可访问名称缺失，以及扩大静态模式后发现的退役 fixture 残留。

## 审查范围

- 完整阅读了内嵌 `AGENTS.md` 规则、`task-tree` 与 `one-file-one-thing` skill、任务树 index、
  010～060 全部任务卡、执行报告与独立 review。
- 审查范围为初始 base `177676017b4f183fb9c10cbe3b92550c526d6b16` 到当前 HEAD
  `5ad0f617571f96de36305019c531a258c0fb4e25` 的四个产品提交，以及 HEAD 后 055 工作树收口。
- 严格排除用户脏改：`.gitignore`、`CLAUDE.md`、`.project-lines/**`、UndoBar 删除、
  `agentnew.css` / `agentnew.shell.css` / `agentnew.subagent-trace.css`、
  `agentnew.workspace-sidebar.css` 与 `apps/desktop/gen/**`。
- 未修改产品、测试或用户脏改，未调用真实模型，未提交；本审查只新增本报告。

## 按严重性 findings

### Critical

无。

### Important

1. **C-13：English 下 required Thinking 的可访问名称与 title 仍为中文。**
   - `apps/web/src/i18n/locales/en/messages.po:242-244` 的新增 msgid
     `Thinking 始终开启` 仍是空 `msgstr`。
   - 真实浏览器切到 English 后，模型选择器、Thinking group、Auto 说明、消息框与发送按钮均已英文，
     但 GLM-5.3-Flash 的 disabled + pressed toggle 仍暴露 accessible name/title
     `Thinking 始终开启`。这不是仅视觉文案问题；屏幕阅读器也会读出错误语言。
   - `pnpm lingui:extract --clean` 独立复跑显示 en 483 条中 `Missing 1`，与浏览器现象精确对应。
   - 建议归属 055 R1：补英文翻译（例如 `Thinking is always on`），重新 extract/compile/build，
     并在 English 浏览器或组件测试中钉住 required toggle 的 accessible name/title。

2. **C-12：扩大退役 ID 扫描后，三个可执行测试文件仍有五处 exact `glm-5` fixture。**
   - `packages/agent-core/src/state/persistence/settingsBagMigration.test.ts:85`。
   - `packages/agent-core/src/state/persistence/hydrate.modelMigration.test.ts:109,112`。
   - `packages/agent-core/src/state/persistence/modelMigration.test.ts:160,171`。
   - 055/060 原扫描列举了多数旧 GLM ID，却遗漏 exact `glm-5`；使用带尾界的完整 retired-ID
     模式复扫 `packages/`、`apps/`（排除 `gen`）会稳定得到以上五处，而不是零命中。
   - 这些用例验证设置袋/非 DeepSeek 搬移语义，不需要旧官方 SKU；继续使用退役 ID 违反
     “退役 ID 不再存在于可执行产品与夹具”的 C-12 明文要求。
   - 建议归属 055 R1：按用例意图改为当前 `glm-5.3` 或明确的中性未知模型 fixture，并把 exact
     `glm-5`、旧 `air/airx/flashx` 等完整旧目录加入可复跑的静态模式，避免再次漏扫。

### Minor

无新增 Minor。前序 055 的 glob/计数追踪性 Minor 不影响本次两项否决。

## C-01～C-13 最终矩阵

| 行 | 判定 | 独立核验证据 |
| --- | --- | --- |
| C-01 | ✅ 批准 | `builtinModelDescriptors.ts:96-119` 精确登记 3 DeepSeek + 2 GLM + 1 Kimi；能力与 Composer option 测试对拍固定六项；浏览器 combobox 也精确六项。 |
| C-02 | ✅ 批准 | 三个 DeepSeek capability 精确 `low/high/max` 且 optional；浏览器实见 Auto/Low/High/Max 与可关闭 toggle。 |
| C-03 | ✅ 批准 | adapter 只在 enabled 时发送合法 `low/high/max`；注入 fetch 测试覆盖 Auto、Off、历史值与脏值 fail closed。 |
| C-04 | ✅ 批准 | GLM-5.3 与 GLM-5.3-Flash 均 required + 三档；真实浏览器逐一确认 toggle disabled/pressed 与四个 UI 选项。 |
| C-05 | ✅ 批准 | GLM 请求边界强制 `thinking:{type:'enabled'}`，effort 白名单为三档；两个 SKU 的注入 fetch 协议测试通过。 |
| C-06 | ✅ 批准 | Kimi K3 required + `low/high/max` + default max；capability、Composer 与设置转换测试通过。 |
| C-07 | ✅ 批准 | K3 adapter 与最终 call/stream 边界均删除 K2.x `thinking`，只发送合法 effort；CN/global 注入 fetch 测试通过。 |
| C-08 | ✅ 批准 | K3 CN 上传、`ms://` 编码、历史引用、跨 scope 降级、失败/取消/幂等 rollback 的专项测试通过。 |
| C-09 | ✅ 批准 | Vision descriptor 与图片 capability 保留；图片准备和 `view_image` 注入-fetch 回归通过。 |
| C-10 | ✅ 批准 | tier routing 只引用当前 DeepSeek/GLM/Kimi 常量；routing 测试对拍 registry 并验证最终 vendor wire。 |
| C-11 | ✅ 批准 | exact capability 查询对未知 vendor/model 返回 unknown；profile identity 与 missing-current 仍保留，不冒充官方能力。 |
| C-12 | ❌ 否决 | 生产目录无旧 ID，但三个 agent-core 可执行测试仍有五处 exact `glm-5`；完整静态门失败。 |
| C-13 | ❌ 否决 | 中文、窄窗、原生 radio 键盘与 ARIA 状态通过；English required toggle 的 accessible name/title 未翻译。 |

## 独立命令证据

| 命令 / 检查 | 结果 |
| --- | --- |
| 目录、三家 wire、图片、routing、Composer/fallback 代表性 Vitest | 17 files / 149 tests 全过。 |
| `pnpm exec tsc -b --pretty false` | 通过，无诊断。 |
| `pnpm check:state` | 5 条规则通过；22 workspaces / 902 非测试 TS/TSX。 |
| `pnpm check:boundaries` | 7 条规则通过；仅既有 migration/public-surface 观察项。 |
| `pnpm build` | 通过；Vite 1262 modules、server tsup 与 web-dist embed 完成；仅既有 chunk/dynamic-import warnings。 |
| base→工作树、排除指定用户脏改后的 `git diff --check` | 通过，无输出。 |
| `pnpm lingui:extract --clean` | 命令 exit 0，但语义门不通过：en 483 条中 Missing 1。 |
| 完整 retired-ID `rg -P`（`packages apps`，排除 `gen`） | 不通过：exact `glm-5` 共 5 行 / 3 files。 |
| 相关改动 TS/TSX/CSS `wc -l`（排除用户 CSS） | 全部 ≤300；最大 `builtinProviders.test.ts` 298，生产最大 `builtinProviders.ts` 290。 |

执行者记录的全量 708 files / 5927 tests 与 Lingui compile 结果也已阅读并与当前工作树抽查对照；本次
独立代表性集合、类型、state/boundaries、build、diff 与静态门足以复现两项否决，未重复调用付费模型。

## 真实浏览器证据

- 使用已重启的本地 4765 服务进入当前 build；一次性 token 只用于本次内部验收，未写入报告、代码或
  截图。网络记录只有本地 health/invoke/events/sqlite 请求，未点击发送，也没有供应商模型请求。
- 选择器精确显示六模型，含 DeepSeek Vision；DeepSeek V4 Pro 实见 optional toggle 与
  Auto/Low/High/Max。
- GLM-5.3 与 GLM-5.3-Flash 均实见 toggle `disabled=true`、`aria-pressed=true`，四个 effort radio
  均可用。原生键盘 `ArrowRight` 从 Auto 依次切到 Low、High、Max，焦点与 checked 状态同步。
- 640×760 窄窗口下模型选择器全宽，Thinking toggle 与四档换到下一行，所有控件位于 viewport 内，
  没有横向溢出或遮挡。
- 切到 English 后，`Models`、`Thinking settings`、`Use the model default`、`Message`、`Send` 等均
  正确切换；只有 required toggle 的 accessible name/title 留在中文，复现 Important finding 1。

## 执行者 concern 是否解除

已解除。执行者 concern 仅是原服务退出导致 GLM、English、窄窗、键盘与 ARIA 没有完成人工操作；本次
在健康服务上全部补齐。终审 `NEEDS_CHANGES` 不是环境疑虑，而是两项稳定可复现的范围内缺陷。

## 文件规则与最终 verdict

本树新增/大改普通源码与测试均未超过 300 行，文件职责可单句说明；两份 `.po` 属 i18n 资源例外。
没有发现假拆分或职责混杂。本报告低于 300 行。

最终 verdict：`NEEDS_CHANGES`。C-12、C-13 修复并复跑完整 retired-ID 静态扫描、Lingui
extract/compile/build 与 English 浏览器断言前，不批准整棵 `latest-model-thinking` 交付。

---

## R1 限定复审

R1 结论：`APPROVED`。

本轮只复审首轮否决的两项 Important 及其直接回归影响；首轮 findings 保留为历史。更新后的 055
报告、限定 diff、测试与真实浏览器证据表明两项均已修复，未引入新的 Critical、Important 或 Minor。

### 首轮 finding 处置

1. **C-13 English required Thinking：✅ 已关闭。**
   - `apps/web/src/i18n/locales/en/messages.po:243-244` 将 `Thinking 始终开启` 自然翻译为
     `Thinking is always on`。
   - `ComposerThinkingControl.test.tsx` 新增 English locale 用例，直接断言 required toggle 的
     accessible name、title 与 pressed state，并在用例末恢复 zh-CN，避免污染其它测试。
   - 当前 build 的真实浏览器中，English + GLM-5.3 得到
     `aria-label="Thinking is always on"`、`title="Thinking is always on"`、
     `aria-pressed="true"`、`disabled=true`；不再混入中文。
   - `pnpm lingui:extract --clean` 独立复跑为 en 483 条、Missing 0。

2. **C-12 exact `glm-5` fixture：✅ 已关闭。**
   - 五处均改为当前 `glm-5.3`：`settingsBagMigration.test.ts:85`、
     `hydrate.modelMigration.test.ts:109,112`、`modelMigration.test.ts:160,171`。
   - 改动只替换模型身份：前者仍验证非空设置袋替换；hydrate 与 migration 用例仍验证 core 对
     非 DeepSeek `reasoning_effort: low` 只搬袋、不做厂商归一化。断言结构和期望 effort 未改变，
     因而没有削弱测试意图，也没有新增迁移生产逻辑。
   - 完整 PCRE 覆盖升级前 14 个 GLM ID：`glm-5.2`、`glm-5.1`、exact `glm-5`、
     `glm-5-turbo`、`glm-4.7`、`glm-4.7-flash`、`glm-4.7-flashx`、`glm-4.6`、
     `glm-4.5-air`、`glm-4.5-airx`、`glm-4.5-flash`、`glm-4-long`、
     `glm-4-flashx-250414`、`glm-4-flash-250414`，并覆盖 `kimi-k2.6` / 展示名 / 常量名。
     前后尾界会命中 exact `glm-5`，不会误伤 `glm-5.3`；扫描 `packages apps`、排除 `gen` 为零命中。

### R1 独立验证

| 命令 / 检查 | 结果 |
| --- | --- |
| 四个限定 Vitest 文件 | 4 files / 56 tests 全过。 |
| `pnpm lingui:extract --clean` | en 483 条、Missing 0。 |
| `pnpm lingui:compile` | 通过；两份生成 `messages.js` 在验证后精确恢复，未留下额外差异。 |
| `pnpm build` | 通过；Vite 1262 modules、server tsup 与 web-dist embed 完成，仅既有 warnings。 |
| 完整 14 GLM + K2.6 retired-ID PCRE | `packages apps -g '!**/gen/**'` 零命中（`rg` exit 1）。 |
| base→工作树、排除指定用户脏改后的 `git diff --check` | 通过，无输出。 |
| `curl` 本地 4765 `/api/health` | 200，服务健康。 |
| English 当前 build 浏览器复验 | GLM required toggle 的 label/title/pressed/disabled 全部正确。 |

R1 涉及的普通测试文件为 90、124、201、268 行，均不超过 300 行且职责未变化；PO 为 i18n 资源
例外。没有触碰指定用户脏改，没有调用真实模型，没有提交。

### R1 最终 verdict

`APPROVED`。首轮 C-12、C-13 两项 Important 已关闭；C-01～C-13 现全部批准，可以解除
`latest-model-thinking` 整树终审阻塞。
