# 050 核心安全与覆盖收口报告

结论：**DONE**

基线：`0fb3afbdf656df7184134075887aa414eb348828`。本任务未 commit、未恢复 stash、未调用真实模型或外部服务，仅修改 050 声明文件。

## 实现结果

- 新增 `state/sessionCapabilityHydration.ts` 单责 sanitizer。持久数据缺失 `capabilityPolicy` 时保留 legacy-unrestricted；字段存在但为 `undefined`、`null`、未知版本、缺 key、额外 key、非规范名字或其他非法形状时，统一替换为可 JSON 持久化的 v1 locked-empty（`revision: 0`、`lockedAt: 0`、空 Tool/Skill allowlist）。合法 v1 返回原对象。
- central `hydrateForCore` 在 sessions 数据进入 recovery 合并前净化，并对 recovery 合并结果再防御一次。合法 recovery v1 的静态 meta 仍保持原优先级；recovery codec 未放宽。
- `normalizeSessionCapabilityPolicy`、`sessionCapabilityPolicyVersion`、`isSessionCapabilityAllowed` 与 `captureRunCapabilitySnapshot` 接受未知运行时值并 fail closed。只有真正缺字段的 `undefined` 是 legacy；非法值不会抛错，也不会采信伪造 allowlist。业务 Tool/Skill 全拒绝，协议控制工具沿既有规则可用。
- SQLite 与 IndexedDB 增加合法 locked v1 完整 round-trip 回归；sessions-only hydrate 增加 legacy、合法、未来版本、null/undefined、额外/缺失 key、非规范名字的表驱动覆盖。
- 增加同会话两个并发首发：首条只持久化锁一次，第二条进入 queued，运行期间新注册工具不扩张已锁 allowlist。
- 增加 stop、undo、redo 后 policy 始终 locked、toggle 始终拒绝的生命周期回归。
- 增加 child Skill 直接回归：当前最高 child profile 不暴露 `skill_search`/`skill_read`；直接猜名执行均在 child gate 拒绝且 executor 零调用。另验证 child tool execution 收到父 run 冻结的 Skill snapshot，未来若 profile 开放控制工具仍不会从 live registry 扩权。

## 验证证据

- 相关能力、hydrate、recovery、delegation、Skill 与两种 persistence 共 18 个 Vitest 文件：`18 passed`，`122 passed`。
- 最终变更聚焦复跑：`4 passed`，`31 passed`。
- `pnpm exec tsc -b --pretty false`：PASS。
- `git diff --check`：PASS。
- 声明内普通源/测试物理行均不超过 300；最高为 `runtime/sessionCapabilityDelegation.test.ts` 291 行，其余最高为 `state/persistence/hydrate.ts` 277 行。新增 sanitizer 源文件 13 行，职责仅为持久 SessionMeta capability 字段净化。

## 覆盖结论

- 040 的恶意未来策略 `{version:2,state:'locked',allowedTools:['secret'],allowedSkills:['hidden'],...}` 现在进入运行快照后为 locked-empty：`tool=false`、`skill=false`，且不抛。
- C-003、C-004、C-009、C-010、C-012 在 050 范围内的核心缺口已闭合。
