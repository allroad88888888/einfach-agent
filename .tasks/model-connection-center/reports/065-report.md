# 065 执行报告：迁移连接契约测试夹具

## 改动摘要

- `modelConnectionProfileCommands.test.ts`：将 `MODELS` 显式声明为 `readonly ConnectionProfileModel[]`，使 `source` 保持 `manual | discovered` 联合类型。
- `settingsCenterCommands.test.ts`：将 profile fixture 和 draft patch 从旧 `model` 迁移为非空 `models`；关闭设置的完整状态断言补充既有的 idle probe 字段。

## 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/settings/settingsCenterCommands.test.ts` | 通过：2 files、13 tests passed。 |
| `pnpm exec tsc -b --pretty false` | 通过：退出码 0，无输出。 |
| `git diff --check` | 通过：退出码 0，无输出。 |
| `wc -l apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/settings/settingsCenterCommands.test.ts` | 通过：分别为 219 行、61 行，均低于 300 行。 |

## 未验证项

- 无；本卡列出的验收命令均已执行。

## 范围外发现

- 无产品代码改动。执行前目标的两个测试文件均显示为未跟踪文件；未对其状态、暂存区或其他工作区文件做处理。

## 疑虑

- `git diff --check` 不会展示未跟踪文件的 diff；本卡的目标文件正处于未跟踪状态，需由编排者在后续集成时确保其被纳入变更集。

## 建议后续动作

- 由 060/070 按任务树继续执行总门和独立审查；集成时确认两份目标测试文件被包含。
