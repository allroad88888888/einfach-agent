# 020 独立最终复审

## 结论

**APPROVED**

未发现剩余阻断项。前两轮发现的实际绕过与同 run resume 漂移均已关闭：restricted run 使用
`ToolEpoch.capturedCatalog` 固定首次工具成员/schema/version，并以同一 epoch 为生命周期复用
capability/tool/Skill bundle；legacy 不缓存并继续保留原动态语义。旧确认恢复的 canonical registration
mismatch 契约也已恢复。定向测试、任务相关目录测试、TypeScript、diff-check 与文件行数门全部通过。

## 1. captured tool catalog 与同 run 复用

- `packages/agent-core/src/runtime/toolEpoch.ts:47-58` 在 `ToolEpoch` 上暴露只读
  `capturedCatalog`；`:70-86` 直接保存 epoch 创建时的 registry snapshot。既有动态
  `loadSchema`/version/status 仍留在 epoch 自身，故没有改变 legacy 行为。
- `packages/agent-core/src/runtime/modelTurnPrefix.ts:73-81` 区分真实 `ToolEpoch`，restricted 从
  `toolEpoch.capturedCatalog` 建立目录，legacy 仍使用动态 `toolCatalog`。
- `packages/agent-core/src/runtime/runCapabilitySnapshotCache.ts:14-33` 用 `WeakMap<ToolEpoch,
  Promise<...>>` 缓存 restricted bundle。缓存的是 promise，所以同 epoch 并发调用共享首次 capture；
  capture rejection 只在仍指向同一 pending 时删除；无 epoch 或 legacy 直接执行 capture、不写缓存。
- `packages/agent-core/src/runtime/modelTurnPrefix.ts:76-108` 把 policy、tool catalog 与 Skill snapshot
  一起置于该缓存边界，故 `toolLoopBootstrap.ts:43-46,77` 在 pause/confirm/resume 复用 epoch 时，也会
  复用首次 restricted bundle。
- manifest、schema list/fetch、顶层 executor、递归 `callTool` 与 delegation 继续消费
  `StableModelPrefix.toolCatalog`：分别见
  `packages/agent-core/src/runtime/toolCallGate.ts:83-95,121-180`、
  `packages/agent-core/src/runtime/toolCallExecutor.ts:38-101`、
  `packages/agent-core/src/runtime/toolContext.ts:161-198`、
  `packages/agent-core/src/runtime/toolLoopBootstrap.ts:86-91`。

亲自执行的双-prefix 最小复现结果：

- restricted：第二次 prefix 与首次返回同一个 tool catalog 和 Skill snapshot；运行中注册的 `late`
  schema 仍不可见，同名 `same` 仍返回首次 guide；late/replacement 的 child registry 调用都返回
  `tool_unavailable_in_run`，execute 计数均为 0。
- legacy：第二次 prefix 仍直接返回原动态 epoch；late schema 可见、同名工具返回 replacement guide；
  late 与 replacement 均实际执行，新增 Skill 也进入 snapshot。
- 单次 bootstrap 的顶层/schema、递归与 delegation 回归仍覆盖 late name、same-name replacement、host、
  profile、session allowlist 和 registration version，见
  `packages/agent-core/src/runtime/sessionCapabilityToolRuntime.test.ts:84-110,124-164,211-268` 与
  `packages/agent-core/src/runtime/sessionCapabilityDelegation.test.ts:131-246`。

## 2. cache 并发、失败清除与 legacy

除阅读 `runCapabilitySnapshotCache.ts:14-33` 外，我用真实 `ToolEpoch` 直接调用 cache API 验证：

- 同一 restricted epoch 的两个并发请求只执行一次 capture（calls=1），两方取得同一 bundle 对象。
- 首次 capture rejection 后再次请求会重新执行并成功（总 calls=2），证明失败项已清除。
- legacy 同一 epoch 连续两次均重新执行 capture（calls=2），返回不同 bundle，不存在缓存。

仓库回归 `packages/agent-core/src/runtime/runCapabilitySnapshotCache.test.ts:52-80` 进一步覆盖 restricted
同 epoch 的 policy、tool、Skill 双-prefix 稳定与 child execution 拒绝；`:82-103` 覆盖 legacy 的 late
tool、replacement、Skill manifest 与实际 child execution 动态行为。

## 3. Skill snapshot、全局搜索与读取

- `packages/agent-core/src/runtime/modelTurnPrefix.ts:82-105` 只在首次 restricted capture 中读取当前
  built-in/project/user Skill 安全目录；同 epoch resume 直接复用缓存。
- `packages/agent-core/src/runtime/toolContext/skillsCapabilities.ts:118-135` 以冻结 snapshot 构造 name set，
  restricted 的 `isAllowed` 同时要求 session policy 允许且 name 属于 snapshot；project/user resolution
  也只查同一批 frozen entries。legacy 则保留 unrestricted 判据。
- `tools/skills/src/skill-search/skill-search.ts:43-55` 的全局检索和
  `tools/skills/src/skill-read/skill-read.ts:79-88,185-213` 的全局正文/资源读取都会先经过该单名判据，
  已不存在或被 workspace ceiling 移除的名称无法通过猜名重新进入。
- `tools/skills/src/session-capability.runtime.test.ts:47-110` 使用真实 prefix/context 和真实
  `skill_search`/`skill_read`，在同 epoch 双-prefix 之间加入全局 built-in，仍拒绝 removed built-in、
  workspace-disabled project、missing user 的精确搜索、正文与资源读取；错误不包含被猜名称。
  `:113-140` 验证 legacy 的全局内置读取保持成功。

亲自重跑该真实 Skill 集成测试并通过；结合双-prefix复现，确认 manifest、search、body/resource 使用同一
restricted snapshot membership。

## 4. 旧确认恢复契约

- `packages/agent-core/src/runtime/toolCallExecutor.ts:55-74` 只对不属于首次 run membership 的调用返回
  `tool_unavailable_in_run`；pending call 与 run version 不同时保留其旧 expected version，让 registry
  返回 canonical expected/current registration mismatch。
- 先前失败的三项均已通过：
  `packages/agent-core/src/runtime/commands/confirmToolRegistration.test.ts:119-135,201-217` 和
  `packages/agent-core/src/runtime/modelRun.dangerousToolConfirmation.test.ts:369-414`。新实例均未执行，也
  不会错误持久化“一律允许”。

## 5. 其余验收项

- run policy 值快照、draft fail closed、legacy、三个 control tools、host/global/workspace ceiling、
  manifest/schema list/fetch、顶层 gate/executor、递归 `callTool`、delegation profile 与禁用
  `delegate_agent` 的检查结论不变，相关定向测试全绿。
- session 工具拒绝使用固定 `session_capability_denied`，见
  `packages/agent-core/src/runtime/turnToolVisibility.ts:52-68`；Skill 猜名拒绝使用固定
  `SKILL_NOT_FOUND`，不会枚举隐藏目录。
- 更新后的 020 report 列出 14 个实现文件与 13 个测试/fixture 文件，均落在更新后的任务声明范围；新增
  `toolEpoch.ts`、`runCapabilitySnapshotCache.ts` 及其测试已显式加入声明。

## 验证结果

1. 020 affected 定向集（含 cache、旧三项确认回归、tool/Skill/delegation 与真实 Skill tools）
   - PASS：23 files，162 tests。
2. `pnpm exec vitest run packages/agent-core/src/runtime packages/agent-core/src/tools tools/skills/src`
   - PASS：160 files，1216 tests。
3. `pnpm exec tsc -b --pretty false`
   - PASS，exit 0。
4. `git diff --check`
   - PASS，exit 0。
5. `wc -l` 检查 report 列出的 27 个源码/测试文件
   - PASS：全部 `<= 300`；测试最大
     `tools/skills/src/skill-read/skill-read.test.ts` 295 行，源码最大
     `packages/agent-core/src/runtime/modelTurnRequester.ts` 255 行。

## 文件职责

- `runCapabilitySnapshotCache.ts` 34 行，只负责 restricted run snapshot 的 epoch 生命周期复用与失败清除。
- `toolEpoch.ts` 116 行，仍只负责 run 工具 epoch；新增 captured view 是该抽象已有 frozen registry 的只读
  暴露，不引入第二职责。
- `modelTurnPrefix.ts` 171 行、`turnToolVisibility.ts` 208 行、`skillsCapabilities.ts` 141 行，均低于硬上限
  且职责分别保持为 prefix 组装、run 工具可见性、run Skill 可见性。未发现假拆分或职责混杂。
- 本复审只更新本文件，未修改产品/测试代码，未 commit。
