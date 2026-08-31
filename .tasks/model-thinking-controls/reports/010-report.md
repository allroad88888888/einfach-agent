# 010 report

## 已完成

- 新增逐模型 `ModelThinkingCapability` 判别联合与查询/判定函数，区分
  `unsupported | toggle | effort | unknown`；`ModelThinkingEffort` 不包含 `auto`。
- 新增内置模型 descriptor catalog，集中保存 17 个模型的展示名、上下文/图片能力、Thinking
  能力及官方 source URL；GLM-5.2 的正向档位固定为
  `low, medium, high, xhigh, max`，`minimal | none` 仅记录为关闭别名。
- DeepSeek V4 Pro/Flash 仅声明 `high | max`；GLM-4.5+（GLM-5.2 除外）与 Kimi K2.6
  只声明开关；旧 GLM 声明为 unsupported；openai-compat 与未知模型查询为 unknown。
- `ProviderRegistry` 新增不走执行 fallback 的精确模型查询，以及稳定、只读的已注册模型枚举；枚举项始终
  带 `displayName`。模型数据已从 `builtinProviders.ts` 移出，后者只保留 adapter 装配与请求投影。
- 新接口已从 `@einfach-agent/ai` 根出口导出；共享 worktree 中 `builtinProviders.ts`、`index.ts` 的既有
  connection profile/transport 在途改动均保留。

## 测试与验收

- `pnpm exec vitest run packages/agent-ai/src/modelThinkingCapability.test.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/providerRegistry.test.ts` — 3 files、30 tests passed。
- `pnpm --filter @einfach-agent/ai build` — passed。
- `git diff --check` — passed。
- 额外兼容回归：agent-ai TypeScript 门禁，以及 `builtinProviders`、`vendorDescriptor`、
  `imageCapability` 相关测试合计 6 files、50 tests passed。
- 行数：能力契约 87、内置 catalog 142、registry 149、provider 装配 180、两份新增测试 62/102、
  根出口 30；均低于 300 行。

## 边界

- 仅修改叶任务声明的产品/测试文件并新增本报告；未修改任务文件、index 或 status，未暂存、提交或覆盖
  其他在途改动。
