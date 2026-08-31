# 020 DeepSeek V4 三档 effort 报告

## 改动摘要

- 将 `DeepSeekReasoningEffort` 扩展为 `low | high | max`，请求投影只允许这三档在 Thinking enabled 时原样发送。
- 三个 DeepSeek V4 descriptor 统一声明 `['low', 'high', 'max']`，完整记录历史映射：low→low、medium→high、high→high、xhigh→high、max→max；未设置 `required`。
- 历史持久化归一化现在保留 low，将 medium/xhigh 收敛为 high，并移除非法值；测试断言 low 迁移的幂等性。
- Vision descriptor 的 1M context 与 `DEEPSEEK_VISION_IMAGE_INPUT` 保持不变。
- 新增 `packages/agent-ai/src/deepseekThinkingEffort.test.ts`；职责：验证 DeepSeek V4 Thinking effort 的请求投影。

## 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/agent-ai/src/builtinProviders.test.ts packages/agent-ai/src/deepseekCatalog.test.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts packages/agent-ai/src/deepseekThinkingEffort.test.ts packages/agent-core/src/state/persistence/modelMigration.test.ts` | 通过：6 files、118 tests。 |
| `pnpm exec tsc -b --pretty false` | 通过。 |
| `git diff --check` | 通过，无输出。 |
| `wc -l`（本任务所有改动文件） | 通过：最大为 `deepseek.ts` 271 行；新增 `deepseekThinkingEffort.test.ts` 60 行；均不超过 300 行。 |

## 已完成覆盖矩阵行及证据

| 行 | 结果 | 证据 |
| --- | --- | --- |
| C-02 | 完成 | `builtinModelDescriptors.ts` 的三个 DeepSeek descriptor 均为 `low/high/max`；`builtinThinkingCapabilities.test.ts` 逐模型断言精确档位与完整映射。Auto 继续由省略 `reasoning_effort` 表达。 |
| C-03 | 完成 | `deepseekThinkingEffort.test.ts` 覆盖 enabled 的 low/high/max 原样上行，Auto/Off/medium/xhigh/未知值不发送；`thinkingRequestProjection.test.ts` 同步覆盖通用 adapter 路径。 |
| C-09 | 完成 | `deepseekCatalog.test.ts` 断言 Vision 模型仍为 1M context、保留 `DEEPSEEK_VISION_IMAGE_INPUT` 及图片 MIME capability。 |

## 未验证项

- 未调用真实 DeepSeek 付费模型；按全局约束，所有请求测试均注入 fetch。
- 未运行完整的最终总门（`pnpm check:state`、边界检查、Lingui、build）；这些不属于本叶验收门，交由后续收口任务执行。

## 范围外发现

- 工作区存在既有用户改动：`.gitignore`、`.project-lines/`、`CLAUDE.md`、UndoBar、CSS 与 `apps/desktop/gen/`；未读取、修改、暂存或覆盖。
- `builtinProviders.test.ts` 在本任务开始时已是 298 行；仅替换其既有类型断言文本，未新增测试行。

## 疑虑

- 无阻断疑虑。

## 建议后续动作

- 由独立 reviewer 审查本叶，然后按任务树继续执行 030。
