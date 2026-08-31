# 055 独立审查：清理退役模型的可执行引用

结论：**APPROVED**。

指定基线后的 055 文档、测试、UI fixture 与 i18n 差异满足验收目标；未发现 Critical 或
Important 问题。六模型目录、required Thinking、Kimi K3 wire、DeepSeek Vision、profile/custom
fallback、静态退役标识与“不新增迁移生产逻辑”均有可执行证据。仅有两项非阻断的任务追踪性偏差，
列为 Minor。

## 审查边界

- base 与当前 `HEAD` 均为 `5ad0f617571f96de36305019c531a258c0fb4e25`；审查该基线后的工作树差异。
- 已完整阅读任务消息内嵌的 `AGENTS.md` 规则、`one-file-one-thing` skill、
  `.tasks/latest-model-thinking/index.md`、`055-latest-model-fixtures.md`、`reports/055-report.md` 与
  010/020/030/040/045 前序 review。仓库内没有实际 `AGENTS.md`，故以内嵌规则为准。
- 明确排除用户脏改：`.gitignore`、`CLAUDE.md`、`.project-lines/**`、UndoBar 删除、agentnew CSS、
  workspace-sidebar 与 `apps/desktop/gen/**`。
- 055 产品范围只有文档、测试与 `.po`；没有把上述排除项或任何生产迁移实现归入 055。
- 本审查不修改实现、不提交；只新增本报告。Lingui compile 生成的两份范围外 `messages.js` 已在验证后
  精确恢复为验证前状态，没有留下额外差异。

## 按严重性 findings

### Critical

无。

### Important

无。

### Minor

1. 任务卡 YAML 写的是 `apps/web/src/**/*.test.ts`，字面上不覆盖本叶实际修改并由目标要求需要的 7 个
   `*.test.tsx` UI fixture。它们都是退役模型夹具/required Thinking/图片回归的必要机械同步，没有
   生产代码越界，且全部通过专项与宽回归；这是 files/glob 追踪性遗漏，不是行为缺陷。
2. `055-report.md` 记录受影响集合为 31 files / 191 tests；按当前 diff 排除 UndoBar 后独立枚举实际为
   32 files / 204 tests。差额是同样通过的 `Composer.images.test.tsx`（13 tests）；执行报告的宽回归
   结果不受影响，但目标集合计数少记一项。

## 验收核对

### 1. registry 与 UI 精确六模型

✅ 通过。

- `builtinThinkingCapabilities.test.ts` 用固定数组精确断言顺序与名称：DeepSeek V4 Pro、DeepSeek V4
  Flash、DeepSeek V4 Flash Vision Experimental、GLM-5.3、GLM-5.3-Flash、Kimi K3；不是只检查包含关系。
- `composerModelOptions.test.ts` 断言 Composer 内置选项逐项投影 `defaultProviderRegistry.listModels()`，
  因而与上述精确六模型 registry 共同闭合 UI 目录。
- Composer 集成测试实际选择 GLM-5.3，并验证 required 状态与合法档位；不存在 UI 侧按字符串伪造能力。

### 2. Kimi K3 是 required 三档语义，不是字符串盲替换

✅ 通过。

- `modelThinkingCapability.test.ts` 直接查询真实 registry，断言 Kimi K3 为 supported effort、
  `modelRequiresThinking(...) === true`，且 efforts 精确为 `low | high | max`。
- `ComposerThinkingControl.test.tsx` 与 `composerModelSettings.test.ts` 验证 required capability 在脏
  `enabled:false` 下仍显示 On、不可关闭但档位可选，程序化关闭/Auto/具体 effort 也保持 Thinking 开启。
- `kimiChat.test.ts`、`kimiStream.test.ts` 与既有 `kimiK3Protocol.test.ts` 验证最终 call/stream body
  不含 K2.x `thinking`，合法 effort 才使用顶层 `reasoning_effort`。
- Kimi 图片 fixture 同步为 K3 后仍覆盖 Composer、历史消息、上传/消息编码与清理链路；不是只替换 model
  字符串后放弃协议断言。

### 3. DeepSeek Vision 图片链路保留

✅ 通过。

- 精确六模型断言仍包含 `deepseek-v4-flash-vision-exp`。
- 独立专项覆盖并通过 `deepseekCatalog.test.ts`、`imageCapability.test.ts`、
  `prepareProviderUserInput.test.ts`、`deepseekImageViewer.test.ts` 与 `historyImageCompatibility.test.ts`。
- `packages/`、`apps/` 扫描保留当前 Vision ID；本叶没有修改 DeepSeek 图片生产实现。

### 4. GLM-5.3 / Flash 与 Kimi K3 当前文档

✅ 通过。

2026-08-31 独立复核官方当前 Markdown 文档：

- GLM-5.3：1M、文本输入、Thinking 始终开启、`low/high/max`、默认 `max`。
- GLM-5.3-Flash：1M、原生多模态、文本参数与 5.3 一致、`thinking.type` 只接受 enabled。
- Kimi K3：1M、Preserved Thinking 始终开启、顶层 `reasoning_effort` 为 `low/high/max` 且默认
  `max`，`thinking` 是 K2.x 字段，迁移到 K3 时应删除。

本地 `docs/model-adapter-compatibility.md` 与上述协议一致，并明确 GLM-5.3-Flash 的图片能力虽由官方
提供，但本应用尚未审计所以暂不开放；这与任务裁决相符。当前 README/文档索引/launch 元数据也已把
当前实现同步到 K3，同时保留旧蓝图的历史身份。

官方核对入口：

- <https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md>
- <https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash.md>
- <https://platform.kimi.ai/docs/api/models-overview.md>

### 5. profile missing-current / custom model fallback

✅ 通过。

- `composerModelOptions.test.ts` 仍验证：已删除或不可用的 current profile/model 作为 `current` 选项保留，
  不静默切到内置模型；profile 模型按 connection identity 隔离。
- `modelThinkingCapability.test.ts` 验证 missing vendor、missing model 与伪装成官方 ID 的
  `openai-compat` 模型能力都保持 unknown，不继承执行 fallback。
- `providerRoute.test.ts` 继续用看似官方的 profile label/model 验证不会晋升为官方 target；
  `builtinProviders.test.ts` 的 profile resolver 仍是唯一接入点来源。

### 6. 退役标识静态收口

✅ 通过。

对 `packages apps -g '!**/gen/**'` 扫描以下模式为零命中：

```text
glm-4.7 / glm-4.7-flash / glm-4.5-flash / glm-4.6 / glm-4-long
glm-5.1 / glm-5.2 / glm-5-turbo
kimi-k2.6 / Kimi K2.6 / KIMI_K2_6
```

全仓 hidden 复扫的剩余命中只在旧 `.tasks/` 账本/报告、`.project-lines/`、历史
`docs/image-input-rfc.md`、`docs/kimi-provider-integration-blueprint.md` 与竞品事实文档；均符合 allowlist。

### 7. 不新增迁移生产逻辑

✅ 通过。

- 055 差异没有任何生产 provider/catalog/migration/image 实现文件。
- `hydrate.modelMigration.test.ts` 只把既有 020 迁移语义的期望同步为 `low → low`、`xhigh → high`；
  `modelMigration.ts` 本身无 diff。
- 排除明确用户脏改后，`packages/` 与 `apps/` 的 055 差异只剩 tests 与两份 `.po`。

## 独立验证证据

| 命令 / 检查 | 结果 |
| --- | --- |
| 精确协议/目录/图片/profile 专项 Vitest | 15 files、125 tests 通过 |
| 当前 diff 的受影响测试集合（排除 UndoBar） | 32 files、204 tests 通过 |
| `vitest run packages/agent-ai/src packages/agent-core/src packages/subagents/src apps/web/src` | 406 files、3100 tests 通过 |
| `pnpm exec tsc -b --pretty false` | 通过，无诊断 |
| `pnpm lingui:extract --clean` | 通过；483 条，英文 missing 维持 1 |
| `pnpm lingui:compile` | 通过；生成副产物验证后恢复，不纳入 055 |
| `pnpm check:state` | 5 条规则通过 |
| `pnpm check:boundaries` | 7 条规则通过；仅既有 migration/public-surface 观察项 |
| `git diff --check 5ad0f61...` | 通过，无输出 |
| 退役标识 `rg` allowlist 审计 | `packages/apps` 零命中；全仓仅允许历史材料 |

## 文件规则与 coverage

- 改动的普通代码/测试文件最大为既有 `builtinProviders.test.ts` 的 298 行，全部不超过 300 行；
  两份 2047 行 `.po` 是 i18n 资源例外。
- 各测试文件仍各自验证单一被测模块/场景，没有新增 `utils/common` 大杂烩或机械分片。
- C-01、C-09、C-11、C-12、C-13 在本叶均有直接或宽回归证据；Kimi 图片 C-08 与 routing C-10
  也在专项/宽回归中保持通过。

## 最终判断

055 已把可执行 registry/UI/test fixture 收口到目标六模型，Kimi K3 required 三档与图片协议、
DeepSeek Vision、GLM-5.3 系列、profile/custom fallback 均未回归；生产目录无退役 ID，也没有新增迁移
逻辑。两项 Minor 仅涉及任务 glob 与执行报告计数的追踪性，故批准进入 060 最终审计。
