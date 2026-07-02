# 回退到某次对话 + esc 中断 —— 状态层计划（每会话一个 store 版）

> 架构师工作法：主会话不写实现代码，只维护本文 / 派活 / 验收 / codex review。
> 本轮**范围收敛到「状态层」**。2026-07-01 重大架构改动：store 从「单一全局 + by-session 分桶」
> 改为「**每会话一个 store + 顶层 rootStore**」（用户拍板，见 §8）。旧的 core.ts / coreState.ts /
> checkpoint.ts / coreWriters.ts 全部作废重写；core.type.ts / checkpoint.type.ts / api/* 保留。

---

## §1 设计契约（用户已拍板，子 agent 不可偏离）

| # | 契约 |
|---|------|
| C1 | 桌面壳 = **Tauri**；持久化目标 = **SQLite**（`tauri-plugin-sql`）。本轮只定 driver 抽象 + 内存实现。 |
| C2 | 回退交互 = **checkpoint 列表 + 点击跳转 + 截断式**（跳回第 N 轮 = 丢弃 N 之后）。不做分支。 |
| **C3** | **每会话一个独立 store**（einfach `createStore()`），工厂 `createSessionStore(id)` 创建、`Map<id, SessionStore>` 缓存。顶层 **`rootStore`**（全局唯一）只管**会话列表** `sessionsAtom` + `activeSessionIdAtom`。会话内容（items/run/checkpoints）用**共享的单例 atom key**（如 `itemsAtom`）——值天然隔离在各自 store 里。**禁止**把会话内容做成 `Record<sessionId, _>` 分桶；**禁止**导出写死的全局 `agentStore` 单例。 |
| C4 | 所有状态**不可变更新**（替换数组/对象）——checkpoint 快照有效的前提。 |
| C5 | `createUndoRedo` **只借鉴「快照→恢复」思路**，弃其 `WeakMap[]` 存储（不可序列化）。checkpoint 自建**可序列化**结构（`checkpointsAtom` + 截断）。本轮不接 createUndoRedo（每会话 store 已让时间线天然隔离）。 |
| C6 | **单测先行**：先写 vitest → 红 → 实现 → 绿。colocated `*.test.ts`，`npx vitest run <file>`。 |
| C7 | 写入器操作**当前会话的 store**（经 `getSessionStore(id).store`），不收 store 参数；ghost guard：会话未在 `rootStore.sessionsAtom` 登记则 no-op。 |
| C8 | 本轮**不碰**：runtime abort 接线、UI、model 循环、真实持久化实现。见 §3「范围外」。 |
| C9 | **一个任务一个独立新文件、单一职责**；禁混、禁往别的文件塞——便于逐文件 review。 |

**einfach 机制备忘（子 agent 必读）**：`atom` 是 **key**，值存在 **store** 里；同一个 `itemsAtom` 在不同 store 里是不同的值。所以会话内 atom 定义**一次**（共享 key），每会话 store 各自持有独立值——这正是「每会话一个 store」不需要分桶的原因。

## §2 多 agent 工作流

| 任务 | subagent_type |
|---|---|
| 单个文件的测试+实现 | `general-purpose` |
| 依赖多个既有文件的写入器 | `claude` |

**派活 prompt 五字段**：① 链接本文 §1 ② 范围（P 编号 + 唯一目标文件 + 测试文件）③ 测试先行四步 ④ 禁止项（不改目标外文件）⑤ 产出（改动文件 + vitest 末尾 N 行 + 一句话结论）。

**验收清单（架构师亲跑）**：`git diff` 只落在该 P 文件 → `npx vitest run` 绿 → 单文件 tsc 过 → 对照 §1（尤其 C3 每会话 store 不分桶 / C4 不可变 / C7 ghost guard）。

## §3 阶段拆分（每会话 store 版，一 P 一文件）

**依赖 / 并行**：
- 首批（独立，并行）：**P1**、**P3**、**P4**、**P7**
- 二批：**P5**(←P1+P3+P4)、**P6**(←P3+P4)、**P8**(←P7)

### P1 · 顶层会话列表 store — `state/rootStore.ts`（新文件）
- `export const rootStore = createStore()`（全局唯一，管跨会话的东西）。
- `sessionsAtom: Record<string, SessionMeta>`、`activeSessionIdAtom: string`、派生 `activeSessionMetaAtom`。
- `resetRootStore()`（仅测试用：清空 sessionsAtom + activeSessionId）。
- 依赖：`import type { SessionMeta } from './core.type'`。
- 测试先行：set sessionsAtom/activeSessionId → 派生 activeSessionMeta 反映；未知 active → undefined。
- subagent：`general-purpose`。禁止：不放任何会话内容 atom（items/run/checkpoints 归 P3）。

### P2 · checkpoint 类型 — `state/checkpoint.type.ts` — ✅ 已验收（保留，不动）

### P3 · 会话内 atom keys — `state/sessionAtoms.ts`（新文件）
- 共享单例 atom（值在每个 session store 里独立，C3 备忘）：
  `itemsAtom: ConversationItem[]`（init `[]`）、`runAtom: RunState | undefined`（init undefined）、
  `checkpointsAtom: Checkpoint[]`（init `[]`）、`currentTurnIndexAtom: number`（init `-1`）。
- 依赖：`import type` from `./core.type` 和 `./checkpoint.type`。
- 测试先行：两个不同 `createStore()` 里 set 同一 `itemsAtom` 互不影响（证明值随 store 隔离）；默认值正确。
- subagent：`general-purpose`。禁止：不写工厂/写入器；不分桶。

### P4 · 会话 store 工厂 — `state/sessionStore.ts`（新文件）
- `interface SessionStore { id: string; store: Store }`（本轮先不放 undo）。
- `createSessionStore(id)`（`createStore()` + 存入 Map）、`getSessionStore(id)`（取或建）、`dropSessionStore(id)`（关闭丢弃）、`resetSessionStores()`（测试用清空 Map）。
- 依赖：`@einfach/core`（createStore/Store）。
- 测试先行：`getSessionStore('a')` 幂等（同 id 同实例）；不同 id 不同实例；`dropSessionStore` 后再 get 是新实例。
- subagent：`general-purpose`。禁止：不定义业务 atom（归 P3）；不导出全局 agentStore 单例。

### P5 · 会话状态写入器 — `state/sessionWriters.ts`（新文件）
- `appendItem` / `updateItem` / `setRun` / `patchRun` / `setRunStatus`（含 `'stopped'`）/ `touchSession`。
- 每个：ghost guard（`rootStore.getter(sessionsAtom)[id]` 不存在则 no-op，C7）；内容变更走 `getSessionStore(id).store` 的 `itemsAtom`/`runAtom`；不可变（C4）；内容类收尾 `touchSession`（更新 rootStore 里该 SessionMeta.updatedAt）。
- ⚠️ `SessionMeta` 无 status 字段——不写 session.status；run 状态走 `runAtom`。
- 依赖：P1 rootStore + P3 atoms + P4 getSessionStore。
- 测试先行：seed session（rootStore.setter sessionsAtom）→ appendItem 后该 session store 的 itemsAtom 反映；未登记 session → no-op；新数组引用（C4）；updatedAt 变；setRunStatus('stopped') 生效。afterEach 用 resetRootStore + resetSessionStores。
- subagent：`claude`。禁止：不碰 checkpoint（P6）。

### P6 · checkpoint 写入/回退 — `state/checkpointWriters.ts`（新文件）
- ⚠️ **ghost guard（C7）**：commit/jump 开头都要查 `rootStore.getter(sessionsAtom)[id]`，会话**未登记则 no-op** —— 否则 `getSessionStore(id)` 会创建新 store 复活幽灵会话。依赖因此要加 `rootStore`。（本条 spec 初版遗漏，codex 二批抓出，已补。）
- `commitCheckpoint(id, label)`：guard → 读该 store 的 `itemsAtom` 快照 → append 到 `checkpointsAtom`（turnIndex = 原长度）→ `currentTurnIndexAtom = 新长度-1`。
- `jumpToCheckpoint(id, turnIndex)`：guard → 取 checkpoint（越界 no-op）→ 恢复 `itemsAtom = cp.items` → 截断 `checkpointsAtom` 到 `turnIndex+1`（C2）→ `currentTurnIndexAtom = turnIndex`。
- 依赖：P1 rootStore + P3 atoms + P4 getSessionStore。
- 测试先行：**用例先 seed 会话（rootStore.sessionsAtom）**；commit N 次 → checkpointsAtom 长 N；jumpTo(k) 后 itemsAtom 等于 checkpoint[k].items 且 list 截断到 k+1；不可变新引用；越界 no-op；**未登记会话 commit/jump → no-op（ghost guard）**。
- subagent：`general-purpose`。禁止：不接 driver（P7/P8）；不做分支。

### P7 · 持久化 driver 接口 — `state/persistence/historyDriver.ts`（新文件，只接口+类型）
- `interface HistoryDriver`（全 async）：`listCheckpoints(id)→CheckpointMeta[]` / `loadCheckpoint(id,turnIndex)→Checkpoint|undefined` / `saveCheckpoint(id,cp)` / `truncateAfter(id,turnIndex)` / `deleteSession(id)`。
- 依赖：`import type` from `../checkpoint.type`。
- 测试先行：inline mock 满足接口可调用；`// @ts-expect-error` 缺方法不满足。
- subagent：`general-purpose`。禁止：不写实现（归 P8）；不引 tauri/sql/idb。

### P8 · 内存 driver 实现 — `state/persistence/memoryHistoryDriver.ts`（新文件）
- `createMemoryHistoryDriver(): HistoryDriver`，Map 实现（占位，C1）。
- 依赖：P7 接口。
- 测试先行：save→list→load round-trip；truncateAfter 删 > N；deleteSession 清空；load 越界 undefined。
- subagent：`general-purpose`。禁止：不引 tauri/sql/idb。

### 范围外（本轮不做）
- runtime abort 接线（`stopActiveRun` 等）→ 下一轮；本轮只保证 `runAtom.status` 能置 `'stopped'`（P5）。
- UI（esc 键、轮列表、跳转按钮、按会话切 Provider/store）。
- 真实持久化实现（tauri-plugin-sql）。model 循环接线。

## §4 测试先行硬性条款
每 P 覆盖：正常路径 + ghost guard（P5）+ 不可变引用断言（C4）+ 边界（未登记 session / 越界 turnIndex）。必须看到红→绿。

## §5 codex review
每阶段收尾 `codex review --uncommitted`（其会评审整个未提交树，架构师自行筛出本批文件的 finding 分档）。🟥 阻断→返工；🟨 建议→累计；🟩 风格→记 note。

## §6 风险登记
- R1：会话内 atom 是共享 key、值随 store 隔离——子 agent 易误做成分桶（C3）。验收重点查。
- R2：`touchSession` 写 rootStore、内容写 session store——两个 store 的一致性由 writer 保证。
- R3：rootStore 是全局单例，测试需 resetRootStore + resetSessionStores 隔离。
- R4：driver 全 async vs atom 同步写——接口先行，接线留后续。

## §7 进度看板

| 阶段 | 目标文件 | 状态 |
|---|---|---|
| P1 顶层会话列表 store | `state/rootStore.ts` | ✅ 已验收（codex 零 finding） |
| P2 checkpoint 类型 | `state/checkpoint.type.ts` | ✅ 已验收 |
| P3 会话内 atom keys | `state/sessionAtoms.ts` | ✅ 已验收（codex 零 finding） |
| P4 会话 store 工厂 | `state/sessionStore.ts` | ✅ 已验收（codex 零 finding） |
| P5 会话状态写入器 | `state/sessionWriters.ts` | ✅ 已验收 |
| P6 checkpoint 写入/回退 | `state/checkpointWriters.ts` | ✅ 已验收（补 C7 后 codex 复评零 finding） |
| P7 driver 接口 | `state/persistence/historyDriver.ts` | ✅ 已验收（codex 零 finding） |
| P8 内存 driver 实现 | `state/persistence/memoryHistoryDriver.ts` | ✅ 已验收 |

## §8 决策日志
- 2026-07-01：桌面壳 **Tauri** + **SQLite/tauri-plugin-sql**（C1）。
- 2026-07-01：回退 = checkpoint 列表+跳转+截断（C2）。
- 2026-07-01：`createUndoRedo` 只借鉴思路、弃 WeakMap（C5）。
- 2026-07-01：一任务一独立文件（C9）。
- 2026-07-01：**【重大】store 架构改为「每会话一个 store + 顶层 rootStore」**（C3，用户拍板）。旧 core.ts/coreState.ts/checkpoint.ts/coreWriters.ts 作废重写；P1/P3/P4 重新设计。首批 P1 单例版作废。
- 2026-07-01：**旧 `src/agent` 整个废弃**（不迁移、不兼容），agentNew 全新重写；旧代码仅作「核心思路」参考（ghost guard / 不可变写入 / lazy tool 等模式）。⇒ 无需旧 atoms re-export 迁移桥；旧 `loop.ts:82` 的 debugger 随旧树一并弃、不单独处理（撤回此前 note）。UI 亦在 agentNew 内全新做，不迁移旧 UI。
- 2026-07-01：codex review 二批抓出 **P6 checkpointWriters 缺 ghost guard（C7 偏离）**——对未登记会话 commit/jump 会经 getSessionStore 复活幽灵会话。根因是 §3 P6 spec 初版漏写 C7（架构师 spec 疏漏，非子 agent 自作主张），已补 spec 并返工。
