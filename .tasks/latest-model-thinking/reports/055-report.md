# 055 执行报告：清理退役模型的可执行引用

状态：`DONE`

基线：`5ad0f617571f96de36305019c531a258c0fb4e25`

## 变更

- 将 agent-ai、agent-core、subagents 与 Web 的 characterization、routing、credential、session、图片和 Composer 夹具中的旧 GLM/Kimi ID 收口到六个当前内置模型。DeepSeek Vision 与 Kimi K3 图片夹具均保留。
- 更新 GLM/Kimi 的实际控制面断言：GLM-5.3 系列与 Kimi K3 都是 required Thinking，只暴露 `low | high | max`；Kimi K3 不发送 K2.x `thinking` 字段，DeepSeek 仍可关闭 Thinking。
- 同步两条既有 DeepSeek 历史 effort 归一化测试期望：`low → low`、`xhigh → high`，只改测试，未改 migration 生产实现。
- 经编排者批准，更新当前 README、文档索引、launch 元数据和适配器兼容性契约：目录精确描述六个模型、三家 Thinking/wire 差异，以及 Kimi K3 的 region/图片边界；历史 RFC 与蓝图未改。
- Lingui extraction 实际新增了 `Thinking 始终开启` 到中英文 `.po`；编译生成的范围外 `messages.js` 已恢复，未保留修改。

## 验证证据

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run <32 个受影响 fixture/UI 文件>` | 通过：32 files、204 tests。 |
| `pnpm exec vitest run packages/agent-ai/src packages/subagents/src` | 通过：50 files、346 tests。 |
| `pnpm exec vitest run packages/agent-core/src` | 通过：205 files、1723 tests。 |
| `pnpm exec vitest run apps/web/src` | 通过：151 files、1031 tests。 |
| `pnpm exec tsc -b --pretty false` | 通过，无诊断。 |
| `pnpm lingui:extract --clean` | 通过；目录为 483 条，英文缺失数维持 1。 |
| `pnpm lingui:compile` | 通过。 |
| `pnpm check:state` | 通过：5 条状态规则。 |
| `pnpm check:boundaries` | 通过：7 条边界规则；仅既有 migration/public-surface 观察项。 |
| `git diff --check` | 通过，无输出。 |

## 静态审计

执行：

```sh
rg -n -i \
  -e 'glm-4\\.7(?:-flash)?' \
  -e 'glm-(?:4\\.5-flash|4\\.6|4-long|5\\.1|5\\.2|5-turbo)' \
  -e 'kimi-k2\\.6' -e 'Kimi K2\\.6' -e 'KIMI_K2_6' \
  packages apps -g '!**/gen/**'
```

结果：无生产、测试或 UI 命中；因此没有发现需要交回厂商叶处理的旧 ID 产出。

非隐藏文档残留 allowlist 为历史说明：

- `docs/image-input-rfc.md`
- `docs/kimi-provider-integration-blueprint.md`
- `docs/launch/competitor-facts.md`（竞品事实）

当前模型兼容性文档原有 `glm-5.2` / “Kimi 未接入”陈述已在本叶经批准更新，未加入 allowlist。
使用 `rg --hidden` 复扫时，额外命中均在旧 `.tasks/` 账本/报告或用户既有的 `.project-lines/`
学习记录；它们均为历史材料，未修改。

## 文件约束

本叶改动的普通代码/测试文件全部不超过 300 行；最大为既有
`packages/agent-ai/src/builtinProviders.test.ts` 的 298 行。PO 为本次实际 extraction 的 i18n
资源例外。

## 边界

- 未修改生产 provider、catalog、migration 或图片实现。
- 未修改用户已有的 `.project-lines/`、`.gitignore`、`CLAUDE.md`、UndoBar/CSS 与 `apps/desktop/gen/` 改动；未 commit。

## R1：060 审查缺口收口

状态：`DONE`

- 将英文 catalog 的 `Thinking 始终开启` 翻译为 `Thinking is always on`，并在
  `ComposerThinkingControl.test.tsx` 断言 English 下 required toggle 的 accessible name、title 和
  pressed state。Lingui extraction 的英文缺失数现在为 0。
- 将五处纯夹具中的 exact `glm-5` 改为 `glm-5.3`：settings-bag 1 处、hydrate 2 处、model migration
  2 处；这些用例仍只验证设置袋搬运/归一化，不新增或修改 migration 生产逻辑。

### R1 命令证据

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run ComposerThinkingControl.test.tsx settingsBagMigration.test.ts hydrate.modelMigration.test.ts modelMigration.test.ts` | 通过：4 files、56 tests。 |
| `pnpm exec vitest run packages/agent-core/src` | 通过：205 files、1723 tests。 |
| `pnpm exec vitest run apps/web/src` | 通过：151 files、1032 tests。 |
| `pnpm exec tsc -b --pretty false` | 通过，无诊断。 |
| `pnpm lingui:extract --clean` | 通过：en 483 条、Missing 0。 |
| `pnpm lingui:compile` | 通过。 |
| `pnpm build` | 通过；仅既有 Vite dynamic-import/chunk-size warnings。 |
| `pnpm check:state && pnpm check:boundaries` | 通过；仅既有观察项。 |
| `git diff --check` | 通过，无输出。 |

### R1 完整 retired-ID 静态门

```sh
rg -n -P -i \
  "(?<![A-Za-z0-9_.-])glm-(?:4-flash-250414|4-flashx-250414|4-long|4\\.5-(?:air|airx|flash)|4\\.6|4\\.7(?:-(?:flash|flashx))?|5(?:-turbo|\\.1|\\.2)?)(?![A-Za-z0-9_.-])|(?<![A-Za-z0-9_.-])kimi-k2\\.6(?![A-Za-z0-9_.-])|Kimi K2\\.6|KIMI_K2_6" \
  packages apps -g '!**/gen/**'
```

结果：无命中；尾界确保 exact `glm-5` 被匹配，同时不会误伤目标 `glm-5.3`。
