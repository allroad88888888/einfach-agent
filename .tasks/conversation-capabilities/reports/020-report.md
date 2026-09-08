# 020 强制运行时能力策略报告

## 结果

已将 010 的会话能力策略落到真实运行时边界，不仅是 prompt 过滤：

- `buildStableModelPrefix` 在 run 组装前捕获不可变 policy/tool/Skill 快照；locked 取 allowlist 交集，legacy 保持原行为，意外 draft 对业务工具与 Skill fail closed，但 010 定义的 control tools 仍可调用。
- locked/draft 的 run-scoped catalog 在包装时固化 `catalog.list()` 成员、schema、registration version 与 replay-unsafe 集合；快照后 late registration 和 same-name replacement 都无法进入 schema/执行面。legacy-unrestricted 则直接保留原 `ToolEpoch` 的动态准入与版本跟随语义。
- `ToolEpoch.capturedCatalog` 暴露 epoch 创建时的 frozen view；restricted catalog 始终基于它。`runCapabilitySnapshotCache` 以复用的 `ToolEpoch` 对象为 WeakMap key，跨 pause/confirm/resume 复用首次 capability/tool/Skill bundle，后续 policy、tool registry 或 Skill registry 漂移不会改变同一 run；legacy 不写缓存。
- 工具 manifest、schema 列表/定向读取、visible tools、replay-unsafe 集合都只使用上述 catalog。`toolCallGate` 先拒绝未授权顶层调用，`toolCallExecutor` 在执行前再校验 run membership 并使用 run 版本执行。
- `ctx.callTool` 同时校验会话 allowlist、run registry epoch、registration version 与 host 上界；被会话拒绝时返回稳定 `session_capability_denied`，不枚举隐藏目录。
- 受限 Skill manifest 只从冻结的 allowed snapshot 重建，不信任 registry 返回的其他 prose；`skills.isAllowed(name)` 同时要求 policy 允许且 name 存在于本 run `RunSkillSnapshot.summaries`。因此 `skill_search`/`skill_read` 不能通过全局 tools-skills registry 重新引入缺失或 workspace-disabled 名称。
- 禁用 `delegate_agent` 时不创建 delegation runtime，也不在 context 上挂载委派能力。子代理直接消费 `stablePrefix.toolCatalog`，可见性与执行均取 profile、host、严格 run catalog 和会话 allowlist 的交集。

## 与 010 契约的对齐

直接复用 010 验收代码中的 `normalizeSessionCapabilityPolicy`、`isSessionCapabilityAllowed` 和 `SESSION_CAPABILITY_CONTROL_TOOLS`，未复制或改造 policy 状态机。010 当时没有 ToolContext 级的 Skill 单名判断入口；本任务在已扩展的文件声明内正式增加 `skills.isAllowed(name): boolean`，并移除 duck-typing。

## 变更文件

运行时实现：

- `packages/agent-core/src/runtime/modelTurnPrefix.ts`
- `packages/agent-core/src/runtime/modelTurnRequester.ts`
- `packages/agent-core/src/runtime/toolLoopBootstrap.ts`
- `packages/agent-core/src/runtime/toolEpoch.ts`
- `packages/agent-core/src/runtime/runCapabilitySnapshotCache.ts`
- `packages/agent-core/src/runtime/turnToolVisibility.ts`
- `packages/agent-core/src/runtime/toolCallGate.ts`
- `packages/agent-core/src/runtime/toolCallExecutor.ts`
- `packages/agent-core/src/runtime/toolContext.ts`
- `packages/agent-core/src/runtime/toolContext/skillsCapabilities.ts`
- `packages/agent-core/src/runtime/toolContext/delegationCapabilities.ts`
- `packages/agent-core/src/tools/context.ts`
- `tools/skills/src/skill-search/skill-search.ts`
- `tools/skills/src/skill-read/skill-read.ts`

测试与 fixture：

- `packages/agent-core/src/runtime/sessionCapabilityToolRuntime.test.ts`
- `packages/agent-core/src/runtime/runCapabilitySnapshotCache.test.ts`
- `packages/agent-core/src/runtime/sessionCapabilitySkillsRuntime.test.ts`
- `packages/agent-core/src/runtime/sessionCapabilityDelegation.test.ts`
- `packages/agent-core/src/runtime/toolCallExecutor.test.ts`
- `packages/agent-core/src/runtime/toolCallGate.test.ts`
- `packages/agent-core/src/runtime/toolCallBatch.authorization.testFixtures.ts`
- `packages/agent-core/src/runtime/transcriptInjection.test.ts`
- `tools/skills/src/skill-search/skill-search.test.ts`
- `tools/skills/src/skill-search/session-capability.test.ts`
- `tools/skills/src/skill-read/skill-read.test.ts`
- `tools/skills/src/skill-read/session-capability.test.ts`
- `tools/skills/src/session-capability.runtime.test.ts`

## 验证

- `pnpm exec vitest run packages/agent-core/src/runtime/runCapabilitySnapshotCache.test.ts packages/agent-core/src/runtime/commands/confirmToolRegistration.test.ts packages/agent-core/src/runtime/modelRun.dangerousToolConfirmation.test.ts packages/agent-core/src/runtime/sessionCapabilityToolRuntime.test.ts packages/agent-core/src/runtime/sessionCapabilitySkillsRuntime.test.ts packages/agent-core/src/runtime/sessionCapabilityDelegation.test.ts packages/agent-core/src/runtime/toolCallExecutor.test.ts packages/agent-core/src/runtime/toolCallGate.test.ts packages/agent-core/src/runtime/modelTurnPrefix.test.ts packages/agent-core/src/runtime/toolEpoch.test.ts packages/agent-core/src/runtime/toolContext*.test.ts tools/skills/src/skill-search/skill-search.test.ts tools/skills/src/skill-search/session-capability.test.ts tools/skills/src/skill-read/skill-read.test.ts tools/skills/src/skill-read/session-capability.test.ts tools/skills/src/session-capability.runtime.test.ts` → 第二次 review 修复后 23 files / 162 tests passed。
- `pnpm exec tsc -b --pretty false` → passed。
- `git diff --check` → passed。
- `wc -l` 逐一检查上述声明内已编辑源码/测试：全部 `<= 300`；源码最大 255 行，测试最大 295 行。

真实绕过回归使用 `createToolEpoch` 和 `runSession`/bootstrap 时序，不再用静态 `core.tools.snapshot()` 代替生产依赖；覆盖 late name、same-name replacement、legacy 动态语义、顶层/schema/递归/child 拒绝。新增同一 `ToolEpoch` 的双 prefix 回归，验证 restricted 跨 resume 不重捕获 tool/Skill/policy，legacy 则继续动态更新；旧确认恢复测试验证 pending call 仍返回含 expected/current 的 canonical registration mismatch。Skill 集成回归在双 prefix 后使用真实 context 调用全局 search/read，覆盖 manifest、search、正文与资源猜名拒绝。

## 风险与边界

- 实际 model run 始终显式传递 immutable snapshots 与 host 判据。为保持旧的直接 `buildToolContext` 调用兼容，未传 snapshot 时会就地从 session/registry 捕获一次；该兼容路径不跨越 context 构造后的变化。
- legacy-unrestricted 保留 registry Skill manifest/全局 Skill 读取原行为，并原样保留 `ToolEpoch` 动态语义；locked/draft 才使用安全快照。
- 第二次 review 前的任务整目录结果为 159 files 中 157 passed / 2 failed、1214 tests 中 1211 passed / 3 failed；本次已定向重跑这 3 个失败用例及全部 affected（23 files / 162 tests）。按编排者最新指令未再跑整目录或全仓 `pnpm test`，全仓组合验收由 040 执行。
- 未恢复 stash，未 commit，未修改声明范围外文件。
