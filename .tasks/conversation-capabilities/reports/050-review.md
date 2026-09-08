# 050 独立审查报告

结论：**APPROVED**

基线：`0fb3afbdf656df7184134075887aa414eb348828`。本次仅审查 050 声明文件相对基线的 diff，并独立运行定向测试、恶意对象探针、TypeScript、diff whitespace 与行数门；未修改产品/测试、未 commit、未派生 agent。

## 验收核对

- ✅ **missing field 与显式坏字段被严格区分。** sanitizer 先用 own-property 判定真正缺字段并原样保留 legacy；字段存在时才校验，非法值统一写成可持久化 locked-empty（`packages/agent-core/src/state/sessionCapabilityHydration.ts:8`）。直接测试同时钉死 missing 保持无字段，以及显式 `undefined`、`null` 转 locked-empty（`packages/agent-core/src/state/sessionCapabilityHydration.test.ts:27`、`:36`）。
- ✅ **future / extra keys / 非规范 names fail closed。** v1 validator 校验精确 key 集、非负安全整数及严格递增的非空名字数组（`packages/agent-core/src/state/sessionCapabilityPolicy.ts:87`、`:105`）；sanitizer 与 sessions-only hydrate 的表驱动用例覆盖 future、extra、缺 key、乱序和空名（`packages/agent-core/src/state/sessionCapabilityHydration.test.ts:36`、`packages/agent-core/src/state/persistence/hydrate.sessionCapabilities.test.ts:46`）。
- ✅ **运行时 helper 对绕过 hydrate 的畸形对象不抛且只保留控制工具。** normalize 对非法 unknown 返回 locked-empty（`packages/agent-core/src/state/sessionCapabilityPolicy.ts:64`），allow helper 对所有业务 Tool/Skill 拒绝、仅 Tool 类协议控制名放行（`:163`）；run snapshot 只冻结净化后的 policy（`packages/agent-core/src/runtime/turnToolVisibility.ts:26`）。独立 `tsx` 探针对 `null`、future、extra-key、乱序 allowlist 均得到 `state=locked`、业务 Tool/Skill=false，三个控制工具=true，exit 0；对应回归位于 `packages/agent-core/src/state/sessionCapabilityPolicy.test.ts:123`。
- ✅ **hydrate 与合法 recovery 优先级正确。** sessions 输入在 recovery 规划前净化，recovery 合并结果在写 atom 前再净化（`packages/agent-core/src/state/persistence/hydrate.ts:177`、`:202`）；合法 recovery 静态 policy 覆盖坏 sessions 副本的直接测试通过（`packages/agent-core/src/state/persistence/hydrate.sessionCapabilities.test.ts:69`）。recovery codec 仍从严格 `isSessionCapabilityPolicy` 判定该字段（`packages/agent-core/src/state/recoverySnapshot.codec.ts:81`）。
- ✅ **SQLite / IndexedDB round-trip 与 sessions-only hydrate 闭合。** 两种载体均直接断言 canonical locked v1 的 allowlists 原样往返（`packages/persistence-sqlite/src/sqliteDriver.test.ts:99`、`packages/persistence-idb/src/sessionsPersistence.test.ts:56`）；sessions-only hydrate 对 legacy、合法与各类非法值逐项断言内存结果（`packages/agent-core/src/state/persistence/hydrate.sessionCapabilities.test.ts:46`）。
- ✅ **并发首发只锁一次。** 两个同会话 `sendMessage` 并发执行的直接用例断言首个 `started`、第二个 `queued`、`saveSessions` 恰好一次，并确认 late registration 没有扩张 allowlist（`packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts:198`）。生产路径在 per-session submission gate 内先判断已有 run，再只对新 run 执行 durable lock（`packages/agent-core/src/runtime/commands/runLifecycleCommands.ts:65`、`:75`、`:91`）。
- ✅ **stop / undo / redo 不解锁。** 生命周期直接用例逐步执行 stop、undo、redo，每步比较原 locked policy，最后确认 toggle 返回 `policy_locked`（`packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts:229`）；命令层锁定拒绝位于 `packages/agent-core/src/runtime/commands/sessionCapabilityCommands.ts:125`。
- ✅ **child Skill 是父 snapshot 的空/受限子集。** 最高 child profile 不包含 `skill_search`/`skill_read`，实际 `runChildTool` 猜名也在 child gate 拒绝且 executor 零调用（`packages/agent-core/src/runtime/sessionCapabilityDelegation.test.ts:101`）。另一直接执行用例确认 child tool context 只能看到父 run 已冻结的 `planning` Skill snapshot（`:145`）；上下文构造明确复用传入 snapshot（`packages/agent-core/src/runtime/toolContext.ts:129`）。

## 独立验证

| 命令 | 结果 |
| --- | --- |
| 050 声明的 7 个 Vitest 文件 | PASS：`7 passed`，`58 passed` |
| recovery codec / projection / hydrate 3 个回归文件 | PASS：`3 passed`，`33 passed` |
| 独立恶意 runtime policy `tsx` 探针 | PASS：4 类畸形对象均不抛、业务权限全拒绝、仅 3 个 control tools 放行 |
| `pnpm exec tsc -b --pretty false` | PASS |
| `git diff --check 0fb3afbdf656df7184134075887aa414eb348828` | PASS |
| 050 声明内源/测试 `wc -l` | PASS：全部 ≤300，最高 291 行 |

未发现 Critical、Important 或 Minor 问题。050 的 C-003、C-004、C-009、C-010、C-012 收口声明成立。
