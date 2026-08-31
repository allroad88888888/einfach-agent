# 045 独立审查

## 结论

**REJECT**

纯函数的不可变性、Thinking 能力收窄、Auto、off 保留合法 effort、非法 effort 与空袋清理均正常；
但模型切换对同 vendor 的 target bag 采用“整袋二选一”，既可能把旧 profile
`connectionId` 带入无连接 identity，也会在目标显式带 identity bag 时丢掉本应保留的同厂商
设置。这不满足 045 对 identity 和 opaque bag 的核心契约。

## Findings

### [High] 同 vendor 且目标无 bag 时会继承旧 profile `connectionId`

- 位置：`apps/web/src/agentNew/ui/composerModelSettings.ts:72-74`。
- `target.vendorSettings ?? current.vendorSettings` 把“目标未携带 bag”解释为“继承当前整袋”。但
  `connectionId` 是 identity 的一部分；目标 `openai-compat` identity 没有 `connectionId` 时，不能从当前
  profile 补一个。
- 可复现：当前为
  `{vendor:'openai-compat', model:'old', vendorSettings:{connectionId:'profile-a'}}`，目标为
  `{vendor:'openai-compat', model:'legacy'}` 且 capability 为 `unknown`，实际结果仍含
  `{connectionId:'profile-a'}`。目标的 identity 被改写成了 profile-a。
- 当前 040 生成的正常 profile 选项都显式带 `connectionId`，所以 `profile-a → profile-b` 会正确
  覆盖为 profile-b；但 045 的公开转换契约仍允许无 bag 的同 vendor identity，且仓库保留了无
  `connectionId` 的 legacy `openai-compat` 路由。因此这是真实的跨 identity/跨 profile 串线风险，
  不能只依赖 050 永远传对参数。
- 建议：把 `connectionId` 始终按 target identity 投影；target 缺失时明确删除旧值。增加
  `profile-a → profile-b` 和 `profile-a → 无 connectionId openai-compat` 两个直接单测。

### [Medium] 目标显式带 bag 时会丢掉同 vendor 的合法 effort 与其它私有项

- 位置：`apps/web/src/agentNew/ui/composerModelSettings.ts:72-74`。
- 同一个 `??` 在 target 带任何 bag 时又完全丢弃 `current.vendorSettings`，而不是以 target identity
  覆盖当前同 vendor bag，然后按 capability 收窄 effort。
- 可复现：当前同 vendor bag 为 `{reasoning_effort:'high', region:'cn'}`，目标 bag 为
  `{connectionId:'target'}`，目标 capability 支持 `high`；实际结果只剩 `{connectionId:'target'}`。这与
  “同 provider 且目标支持当前 effort 时保留，并保留其它目标支持的 vendorSettings”相反。
- 建议：同 vendor 时合并可保留的当前袋与 target identity bag，target 键优先；再单独执行
  `connectionId` identity 规则和 effort capability 收窄。添加“目标带 identity bag 但当前 effort 仍合法”
  的测试。

## 其余审查结果

- [PASS] 不可变：所有路径都构造新的顶层设置；`normalizeEffort` / `withoutEffort` 先展开 bag
  再删键，没有改写输入。
- [PASS] 跨 vendor：目标 vendor 不同时不携带当前私有袋；Kimi `region` 在同 vendor 且目标无
  bag 时保留，跨 vendor 时删除。
- [PASS] `unsupported | unknown` 会删除 `thinking` 并清理 effort；toggle-only 只保留开关语义且
  不保留 effort。
- [PASS] `auto` 通过缺失 `reasoning_effort` 表达；off 保留 capability 支持的合法 effort；
  脏值与非法选择不进入结果，最后一个键被删除后不保留空 `{}`。
- [PASS] 单一职责与行数：实现 115 行，测试 148 行，均不超过 300 行。

## 独立验证

- `pnpm exec vitest run apps/web/src/agentNew/ui/composerModelSettings.test.ts apps/web/src/agentNew/ui/composerModelOptions.test.ts packages/agent-ai/src/modelThinkingCapability.test.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts`：4 files / 35 tests passed。
- `pnpm exec tsc -b tsconfig.app.json`：passed。仓库没有任务文字所写的 `apps/web/tsconfig.json`，根
  `tsconfig.app.json` 包含 Web 源码。
- 两个新增文件分别执行 `git diff --no-index --check /dev/null <file>`：passed。
- 额外只读执行两个最小转换示例，确认上述 High/Medium 结果可稳定复现，且原输入未变。

## 范围确认

审查覆盖 index、010 capability 叶、045 叶、`reports/045-report.md`、两个新增文件及 040 的
identity 产出契约。未修改产品代码、任务/index，未暂存、提交或派生子 agent。
