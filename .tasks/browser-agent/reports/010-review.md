# 010 独立审查

结论：**REJECTED**。

实现已经建立了可用的 headless 包、配置持久化、会话 profile 快照、显式 session 命令和新目录扫描，但当前存在跨 core 持久化污染、配置 Skill 无法搜索、会话工具权限可在创建后扩大等交付阻断问题。报告列出的“未验证项”本身并非全部阻断项；下面的拒绝依据来自代码实际行为。

## 阻断发现

### Critical — 非默认 core 的 session CRUD 会同时写默认 core，可能覆盖另一产品的持久化会话

- 证据：`packages/agent-core/src/runtime/commands/sessionCommands.ts:30-35` 的三个 helper 都先无条件调用模块级 `persistSessions` / `persistWorkspaces` / `persistDeleteSession`，随后才在 `core !== defaultCore` 时调用实例 bridge。
- 实际行为：browser-agent 的 `core.newSession()` 会触发默认 core 的全量 session/workspace 写。模块级 facade 绑定默认 core（`packages/agent-core/src/runtime/persistenceBridge.ts:203-208,235-240`），因此若宿主同时配置了默认 persistence，创建、改名或删除 browser-agent 会话会把默认 core 自身快照写入默认库，并可能删除默认库中同 ID 的恢复记录。这违反实例隔离，也使“两个 namespace/client 互不影响”的 C01 结论不成立。
- 最小修复：helper 只调用 `core.persistence.*`；默认 core 自己的 `core.persistence` 已是默认 bridge，不需要再走兼容 facade。保留模块级导出供旧的外部调用者使用即可。补一个同时配置 defaultCore 与隔离 core driver 的回归，断言每次 mutation 只触达所属 driver。

### Important — 配置 Skill 没有接入 `skill_search`

- 证据：browser client 的 registry `list()` 确实加入配置 Skill（`browser-agent/agent/src/client.ts:58-61`），运行上下文的 `skills.list()` 也返回它们（`packages/agent-core/src/runtime/toolContext/skillsCapabilities.ts:118-130`）；但 `tools/skills/src/skill-search/skill-search.ts:47-50` 只从该列表筛出带 `project/` 或 `user/` scope 的条目，再交给静态 registry 的 `searchSkills`。普通配置名如测试中的 `form-help` 被丢弃。
- 复现推演：Agent 绑定 `form-help` 后调用 `skill_search({query:'form'})`，静态 built-in registry 不含该 Skill，额外列表又因无 scope 被过滤，结果为 0；只有模型已经知道精确名称时 `skill_read` 才能读到正文。这未满足“注入 Skill 的搜索、正文及资源读取”。
- 最小修复：让 `skill_search` 将 `ctx.skills.list()` 中所有非内置/配置 summary 与静态条目统一评分并去重，同时继续以 `ctx.skills.isAllowed` 过滤；补配置 Skill 按 name/description/trigger 搜索及禁用后不可见测试。

### Important — 会话创建时保存的是负向工具列表，首发前新注册工具会被自动授权

- 证据：`browser-agent/agent/src/client.ts:126-129` 通过“当前 registry 中不在 `agent.toolNames` 的工具”生成 draft `disabledTools`。draft 的判定是“名称不在 disabled 即允许”（`packages/agent-core/src/state/sessionCapabilityPolicy.ts:166-177`），首发锁定又按当时 catalog 收集 selected 项（同文件 `132-148`）。
- 复现推演：创建 Agent 仅允许 `skill_read`，创建 session 后调用 `client.core.tools.register(newTool)`，然后首次 `sendMessage`。`newTool` 不在创建时的 disabled 列表，锁定时会进入 `allowedTools`，扩大了 Agent 配置的权限上界。
- 最小修复：创建 browser-agent 会话时直接建立基于 `agent.toolNames` 的锁定 allowlist，或在 agent profile 中冻结正向工具名并让首发锁定与它取交集。补“createSession 后、首次 send 前注册工具仍不可见且不可执行”的测试。

### Important — `agentProfile` 恢复校验过宽，可接受会在模型请求路径崩溃的损坏数据

- 证据：静态类型要求 `skillContents` 数组及其结构（`packages/agent-core/src/state/core.type.ts:202-215`），但 recovery codec 只验证整个字段是任意 JSON（`packages/agent-core/src/state/recoverySnapshot.codec.ts:82-90`）。实际消费无防御地执行 `.map` / `.filter`（`packages/agent-core/src/runtime/modelTurnPrefix.ts:82-85,133-135`）和 `.find`（`packages/agent-core/src/runtime/toolContext/skillsCapabilities.ts:137-140`）。
- 复现推演：恢复快照含 `agentProfile: {"skillContents":"bad"}` 时 codec 接受；下一次构造模型前缀抛出 `map is not a function`。这不满足损坏持久化数据的明确拒绝与兼容要求。
- 最小修复：为 agentProfile 增加逐字段、仅允许已知 key 的结构校验，包括 revision、字符串数组和 string-to-string resources；补 malformed/future shape 拒绝恢复与旧快照缺字段兼容测试。

### Important — 初始化 hydrate 失败后不会释放持久化 owner

- 证据：owner 在 `browser-agent/agent/src/client.ts:28-37` 声明；配置加载失败分支会释放。但 `core.persistence.hydrate()` 的 catch（`:72`）只删除进程内 `owners`，没有调用 `releaseConfigOwner`，也没有 reset 已配置的 persistence。
- 实际行为：一次 session/recovery hydrate 异常后，同 namespace 后续创建会被 IndexedDB owner store 永久拒绝，除非人工删除数据库；失败的工厂也没有 client 可供 dispose。
- 最小修复：把 claim 后全部装配/hydrate 放在统一 try/finally 清理路径，失败时 release owner 并 reset core persistence。补 hydrate driver 失败后同 namespace 可重试测试。

### Important — `dispose()` 没有等待 sessions/workspaces 写队列，刚创建的会话可能在关闭时丢失

- 证据：session 写是 fire-and-forget queue（`packages/agent-core/src/runtime/persistenceBridge.ts:127-150`）；`browser-agent/agent/src/client.ts:146` 仅等待 recovery writer，随后 `core.persistence.reset()`，而 reset 会直接 reset sessions/workspaces queues（`packages/agent-core/src/runtime/persistenceBridge.ts:113-125`）。
- 复现推演：`await client.createSession()` 紧接 `await client.dispose()`；`createSession` 并不等待 sessions driver 完成，dispose 可在 queued write 完成前清队列。现有集成测试只恢复配置，没有恢复已创建会话，故不能证明验收项 2。
- 最小修复：persistence bridge 提供并在 dispose 调用 sessions/workspaces flush；或为 browser-agent 的 createSession 建立可等待的 durability boundary。补“创建 session 后立即 dispose/recreate 仍恢复”的确定性慢 driver 测试。

## 覆盖矩阵判定

- ❌ **C01 多 Agent/多 client 配置隔离与持久化**：配置 CRUD、snapshot 隐藏 key、namespace owner 和单 client 重建已有实现；但默认 persistence 双写会破坏实例隔离，session 的立即关闭持久化也未成立。验收要求的“两个 client、三个 Agent”场景没有执行证据。
- ❌ **C02 Skill 搜索/正文/资源与版本冻结**：冻结正文和资源经 `skill_read` 读取且受 capability 检查，这部分成立；配置 Skill 不进入 `skill_search`，因此整行不通过。
- ✅ **C03 模型连接实际驱动请求**：`client.ts:43-55,130-131` 将冻结 endpoint 编入 opaque binding，transport 运行时按逻辑 connection ID 取最新 key；集成测试实际捕获旧/新 endpoint 与轮换 key，公开 snapshot 在 `client.ts:12-17` 去除 key。没有发现凭据写入 prompt/错误的路径。
- ✅ **C04 显式 session 生命周期命令**：统一 resolver 对未知显式 ID 抛错且不回退 active session（`packages/agent-core/src/runtime/commands/sessionTarget.ts:5-12`）；send 将其转换为 `session_missing`，stop/confirm/answer/resume/continue/undo/redo 均沿显式 ID，undo 的 stop 链也传同一 ID。既有 active-session 兼容保留。
- ✅ **C14 新目录门禁**：workspace group 包含 `browser-agent` 与 `browser-agent/tools`，`check-boundaries.js:193-221` 会扫描其 `src`；agent 另有 React/UI/Chrome/Node 禁入规则。extension 当前无 src 且在 state scope 中有明确骨架例外，符合本任务把其运行入口留给 050 的边界。

## 验收标准逐条判定

1. ❌ 没有按原文覆盖两个 client、三个 Agent 的同一隔离场景；更关键的是默认 persistence 双写已证明隔离行为错误。mock 请求和 public snapshot 无 key 的子项通过。
2. ❌ 配置可重建，但测试未证明已有会话恢复、失败 driver、立即 dispose durability；代码还存在 hydrate owner 泄漏和过宽 agentProfile codec。Skill/instructions/endpoint/key 的运行冻结子项有实现与部分请求证据。
3. ❌ 显式命令接缝实现正确，但没有报告所称场景中 A 请求期间切换到 B、停止/确认/恢复仍归 A以及另一 client 不受影响的端到端证据；且跨 core 默认 persistence 双写使“不受影响”不能成立。
4. ✅ 报告给出指定 compaction recovery、timing 与 commands 定向回归均通过；stop 仍调用 `markUnresolvedToolCallsOutcomeUnknown`，未发现把全部 unknown 清除的改动。
5. ✅ 报告记录指定 vitest 命令 31 files / 242 tests 通过，且 mock fetch 观察了最终 URL、header、body。
6. ✅ 报告记录 browser-agent build、headless Node ESM import、state 与 boundaries 通过；代码入口没有 React、DOM 初始化或 Chrome import。
7. ✅ 报告列出了 core 出口/签名、schema 规则、包配置和测试命令；其中 schema“兼容”结论需按本审查发现修正，但报告栏目完整。

## 非阻断说明

- 报告承认没有真实双标签崩溃租约回收；当前 owner 是永久记录而非 lease，这是已知可运维性限制，但同 namespace 重复 writer 明确拒绝的基本要求已满足。hydrate 失败造成的不可恢复 owner 则是上面的独立阻断缺陷。
- lockfile 补丁刷新和未跑全仓测试不单独构成本次拒绝理由；任务要求的定向门已报告通过。本审查依指示没有重跑测试。

## 回执

**REJECTED** — C01/C02 未满足，且实例持久化隔离、权限冻结和恢复生命周期存在可复现的交付阻断问题。
