# 040 report

## 已完成

- 新增 `composerModelOptions(current, profiles)`，以 010 的稳定内置 registry 枚举为模型 catalog，并保留 descriptor 的 `displayName`。
- 已配置连接 profile 的每个模型投影为独立选项，identity 固定为 `openai-compat`、模型 id 与仅含 `connectionId` 的 `vendorSettings`；profile label 作为分组标签。
- select key 使用不可解析、按身份位置编码的 JSON 元组，因此冒号、斜线、Unicode、同名模型及不同 connectionId 不会冲突；`findComposerModelOption` 只按该 key 查找，不从 label/model 反推身份。
- 当前模型不再存在于内置 catalog 或可用 profile 时，投影会保留一个 `Current model` 选项，不会静默回退到首项。
- 输出仅含选择所需的 label、分组与 identity；不携带 `baseUrl`、API key 或 `credentialConfigured`。未配置凭据的 profile 不列为可选项。

## 测试与验收

- `pnpm exec vitest run apps/web/src/agentNew/ui/composerModelOptions.test.ts` — 1 file、5 tests passed。
  覆盖内置全量、profile 多模型、connectionId 同名隔离、特殊字符 key、缺失当前模型、未配置 profile 与稳定顺序。
- `pnpm exec tsc -b tsconfig.app.json` — passed。仓库没有 `apps/web/tsconfig.json`，web app 由根目录 `tsconfig.app.json` 覆盖。
- `git diff --check` — passed。
- 行数：投影模块 106 行，测试 102 行；均低于 300 行。

## 边界

- 仅新增叶任务声明的两个产品/测试文件及本报告；未修改原型 UI、任务 index/status 或其他共享在途改动，未暂存、提交或覆盖文件。
