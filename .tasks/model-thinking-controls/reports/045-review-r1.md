# 045 R1 独立复审

## 结论

**APPROVE**

上轮 High/Medium 均已闭合，未发现修复引入的回归。同 vendor 切换现在把 `connectionId`
作为 target identity 专属字段处理，同时保留并收窄可携带的 opaque vendor settings。

## Findings

- 无 Blocker、High、Medium 或 Low finding。

## 上轮 Findings 闭合

### [CLOSED High] 旧 profile `connectionId` 不再进入无连接 target identity

- `apps/web/src/agentNew/ui/composerModelSettings.ts:67-82` 在同 vendor 分支先删除当前袋的
  `connectionId`，并只在 target 显式给出时恢复该键。
- `profile-a → profile-b`：目标 `{connectionId:'profile-b'}` 精确覆盖旧连接，结果不含
  `profile-a`。直接单测见 `composerModelSettings.test.ts:73-84`。
- `profile-a → legacy openai-compat`：target 未给 `connectionId` 时结果不保留整个空 bag，
  也不会回退到 profile-a。直接单测见 `composerModelSettings.test.ts:86-97`。
- 只读最小复核输出分别为
  `{vendor:'openai-compat',model:'b',vendorSettings:{connectionId:'profile-b'}}` 与
  `{vendor:'openai-compat',model:'legacy'}`，跨 profile/identity 串 `connectionId` 的风险已闭合。

### [CLOSED Medium] 显式 target identity bag 不再丢失合法 effort 与 opaque 设置

- `apps/web/src/agentNew/ui/composerModelSettings.ts:73-82` 将剔除身份键后的当前袋与 target bag 合并，
  target 同名键优先，然后由 `normalizeThinkingSettings` 按目标 capability 收窄 effort。
- `composerModelSettings.test.ts:99-114` 直接证明 target identity 从 `old-identity` 切到
  `new-identity` 时，合法 `reasoning_effort:'high'` 与不冲突的 `userPreference` 保留，
  target 新设置同时写入。
- 只读最小复核得到
  `{reasoning_effort:'high',opaque:'keep',target:'value',connectionId:'new'}`；原输入仍保持
  `connectionId:'old'`，合并次序与不可变性均正确。

## 回归检查

- 跨 vendor 仍只使用 target bag，不携带旧厂商的 `region`、effort 或 `connectionId`。
- 同 vendor Kimi target 未带 bag 时仍保留 `region`，并删除 toggle-only 不支持的 effort。
- `unsupported | unknown`、toggle-only、Auto、off→on、非法 effort、空 bag 清理与输入不可变
  既有语义未变。
- 实现 132 行，测试 191 行，职责单一且均不超过 300 行。

## 独立验证

- `pnpm exec vitest run apps/web/src/agentNew/ui/composerModelSettings.test.ts apps/web/src/agentNew/ui/composerModelOptions.test.ts packages/agent-ai/src/modelThinkingCapability.test.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts`：4 files / 38 tests passed。
- `pnpm exec tsc -b tsconfig.app.json`：passed。仓库无 `apps/web/tsconfig.json`，根 `tsconfig.app.json`
  包含 Web 源码。
- 修订实现与测试分别执行 `git diff --no-index --check /dev/null <file>`：passed。

## 范围确认

复审仅阅读更新后的实现、测试和 `reports/045-report.md`，并针对上轮 High/Medium 做聚焦
回归。未修改产品代码、任务/index，未暂存、提交或派生子 agent。
