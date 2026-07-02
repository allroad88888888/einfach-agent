# agentNew 功能补全计划：tool/skill + 持久化 + Tauri + 清理旧树

> 架构师工作法：主会话不写实现码，只维护本文 / 派活 / 验收 / codex review。
> 前置：状态层 + runtime（单轮）+ 两栏 UI 已浏览器跑通（见 CHECKPOINT-STATE-PLAN / RUNTIME-UI-PLAN）。
> 本轮四大块：**T** tool/skill 机制 · **D** 持久化接线 · **Ta** Tauri 壳 · **C** 清理旧树。
> 沿用既有契约（每会话 store C3 / 不可变 C4 / ghost+stale 守卫 / UI 只读 atom+调命令 U1/U2 / 单测先行 / 一文件一职责 C9）。

---

## §1 本轮新增设计契约

### tool/skill（块 T）
| # | 契约 |
|---|------|
| TK1 | **用 itemsAtom 直存，不要 continuation blob**：assistant(tool_calls) 与 tool result 直接 `appendItem` 进 `itemsAtom`（ModelItem 序列），每轮 `items.map(it=>it.item)` 重发。省掉旧 `AgentTurnContinuation.state` 那个 DeepSeek 专属不透明 blob（agentNew 净简化）。 |
| TK2 | **内置 tool 裁剪**：`skill_search` / `skill_read` / `ask_user_question` / `save_file` / `browser_action`。**不建 `delegate_agent`**（依赖多 agent/worker/architect，整套超本轮范围）。 |
| TK3 | **manifest-only + lazy schema**：model 只看 `listToolSummaries()`（name/desc/runtime）+ 一个 `request_tool_schema` function；完整 inputSchema 经懒加载。两级分离：`modelVisibleTools`（本轮发出的 function）vs `run.loadedTools`（累计已载）。**禁止预加载**（旧 executeRun 预载 delegate/skill_* 是被点名要改的）。 |
| TK4 | **skill 走 tool、不进 prompt**：system 只放「已加载 skills：<names>」；model 要读内容必须调 `skill_read`。`pickSkillsForInput` 按触发词选（总是含 web-chat-agent）。 |
| TK5 | **瞬态 atom 放会话 store、共享单例 key**：新增 `pendingArtifacts` / `browserCards` / `pendingQuestionAnswers` 到会话 store（共享 atom key，值随 store 隔离）。**禁止** `Record<sessionId, T>` 分桶（对齐 sessionAtoms 既定架构）。 |
| TK6 | **tool 错误不打断**：执行失败封 `{error}` JSON 回给 model 当 tool result，loop 继续。 |
| TK7 | **ask_user「已回答」守卫抽单一 helper**：resume 后 model 再要求提问要被跳过（`user_answers_already_provided`），2 次兜底。旧版 4 处重复 → agentNew 抽 1 个 helper。 |
| TK8 | **tool 循环每步守卫**：每个 await 后写回前 `isCurrentRun(id, runId)` + ghost guard（沿用 modelRun 现有模式）；MAX_AGENT_TURNS 上限保护。 |
| TK9 | **一轮用户输入 = 一个 checkpoint**：中间 tool items 属同一轮快照，最终 assistant 后 `commitCheckpoint` 一次（保持现状语义）。 |

### 持久化（块 D）
| # | 契约 |
|---|------|
| DK1 | 持久化范围 = **会话列表（SessionMeta）+ 每会话 checkpoints（含 items 快照）**。刷新恢复 = 会话列表 + 每会话最新 checkpoint 的 items。 |
| DK2 | driver 全 async；hydrate 启动异步回填、失败不阻塞 app（沿用旧 hydrateFromStorage 容错）；写盘 fire-and-forget，不卡 UI。 |
| DK3 | 载体先浏览器 **IndexedDB**，`HistoryDriver` 接口不变；桌面换 SQLite（块 Ta）。会话列表持久化需扩展 driver 或加 sessions 存储。 |

### Tauri（块 Ta）/ 清理（块 C）
| # | 契约 |
|---|------|
| TaK1 | Tauri + `tauri-plugin-sql`；SQLite 实现 `HistoryDriver`，前端 `invoke` SQL；上层逻辑不动。 |
| CK1 | 块 T 把旧 registry/skills/AskUserQuestionCard 等**移植完 + 确认 agentNew 独立**后，才删 `src/agent` + `src/chat`。 |
| CK2 | 删后 `npm run build` 必须仍过；顺带去掉 agentNew 不用的依赖（如 `@ai-components`，agentNew Composer 用原生 textarea）。 |

## §2 执行顺序与依赖

```
块 T（tool/skill）──────┐
块 D（持久化）──────────┼─→ 块 Ta（Tauri，依赖 D 的 driver 抽象）─→ 块 C（清理，最后）
                        │
T 与 D 相互独立，可并行推进；Ta 依赖 D；C 依赖 T（移植完才能删旧）+ 全部稳定。
```
建议：**先 T + D 并行** → Ta → C。（T 是最大块，见 §3 内部还有依赖链。）

## §3 块 T：tool/skill 机制（P 阶段）

内部依赖：T-1/T-2/T-3 独立并行 → T-4（分发，依赖 T-1/T-2/T-3）→ T-5（lazy 闸门）→ T-6（tool 循环，改 modelRun）→ T-7（ask_user 恢复）→ T-8（UI）。

- **T-1** `tools/registry.ts` — 移植 `toolSummaries` + `toolSchemas` + `listToolSummaries`/`searchTools`/`loadTool`；类型 `ToolSummary`/`LoadedTool`/`ToolRuntime`。裁剪掉 delegate_agent（TK2）。
- **T-2** `skills/registry.ts` + 4 个 `.md`（`?raw`）— 移植 `skillSources` + `listSkillSummaries`/`searchSkills`/`readSkill`/`pickSkillsForInput`（总含 web-chat-agent，TK4）。
- **T-3** `state/transientAtoms.ts` — 会话 store 内共享单例 atom：`pendingArtifactsAtom` / `browserCardsAtom` / `pendingQuestionAnswersAtom` + 写入器（不分桶，TK5）。类型 `PendingArtifact`/`BrowserCard` 放 core.type 或此文件。
- **T-4** `runtime/toolExecution.ts` — 对应 `runRuntimeTool`：分发 skill_search/skill_read/save_file/browser_action（写 T-3 atom），错误封 `{error}`（TK6）。含 render_card stale guard + `{ok,cardId}`、save_file 空串合法。
- **T-5** `runtime/toolLoading.ts` — 对应 `ensureToolLoaded`/`appendVisibleTool`；`RunState` 加 `loadedTools?: string[]`（改 core.type）。
- **T-6** 改 `runtime/modelRun.ts` — 单轮 → 多轮 tool 循环：组 `tools`（request_tool_schema + loaded functions）发给 model；读 `finish_reason==='tool_calls'` → appendItem assistant(tool_calls) → 执行 → appendItem ToolItem → 循环（MAX_AGENT_TURNS）；`'stop'` 收尾 commitCheckpoint（TK1/TK8/TK9）。注入 skills（pickSkillsForInput → system 只放名字，TK4）。
- **T-7** `runtime/commands.ts` 加 `resumeWithAnswers()` + ask_user 暂停/恢复 — `pendingQuestion` 存 RunState；ask_user_question 由 tool 循环内联处理（waiting_user 暂停）；resume 读答案（T-3 atom）续跑；「已回答」守卫抽单一 helper（TK7）。
- **T-8** UI — 移植 `AskUserQuestionCard`（读 runAtom.pendingQuestion，写 pendingQuestionAnswers，调 resumeWithAnswers）+ `BrowserActionCard`（读 browserCards，与 MessageList 合并渲染）+ `SaveArtifact`（读 pendingArtifacts）到 `agentNew/ui/`，接进 AppShell。

## §4 块 D：持久化接线（P 阶段）

- **D-1** `state/persistence/indexedDbDriver.ts` — `HistoryDriver` 的 IndexedDB 实现（对应内存版，round-trip）。
- **D-2** 会话列表持久化 — 扩展 driver 加 sessions CRUD（或 `saveSessions`/`loadSessions`），或独立 sessions store。SessionMeta 存盘。
- **D-3** `state/persistence/hydrate.ts` — 启动 `loadSessions` + 每会话 `listCheckpoints`/最新 `loadCheckpoint` → 回填 rootStore.sessionsAtom + 各会话 itemsAtom/checkpointsAtom。容错（DK2）。
- **D-4** 接线 — `commands`（newSession/removeSession → save/deleteSession）+ `modelRun`（commitCheckpoint 后 saveCheckpoint）+ `revertToTurn`（truncateAfter）+ `main.tsx`（启动 hydrate）。fire-and-forget。

## §5 块 Ta：Tauri 壳（P 阶段）

- **Ta-1** `src-tauri/`（tauri init）— Cargo + tauri.conf + 主进程；前端指向 vite build。
- **Ta-2** `state/persistence/sqliteDriver.ts` — `tauri-plugin-sql` 建表（sessions / checkpoints）+ `HistoryDriver` 实现（invoke SQL）。main.tsx 按环境选 driver（Tauri→sqlite，浏览器→indexedDb）。

## §6 块 C：清理旧树（P 阶段）

- **C-1** 删 `src/agent`（整树）+ `src/chat`（旧 UI）+ 相关旧测试。
- **C-2** 清 `vite.config.ts` / `tsconfig` 的 `@ai-components` alias（若 agentNew 不依赖）+ `package.json` 相关依赖 + 旧 `src/styles/global.css` 未用部分。
- **C-3** `npm run build` + `npm test` 全绿验证；agentNew 完全独立。

## §7 风险
- RF1：tool 循环取代单轮 run，是 modelRun 最大改动 —— stale/ghost 守卫每步不漏（TK8），MAX_AGENT_TURNS 防死循环。
- RF2：瞬态 atom（browserCards 等）要与 checkpoint/items 的 createdAt 合并渲染，注意排序（旧用 seq 兜底）。
- RF3：持久化 hydrate 与「种子会话」冲突 —— hydrate 有数据时不要再种子空会话。
- RF4：Tauri 需 Rust 工具链；`invoke` 在浏览器 dev 不可用 → driver 按环境选，dev 仍用 IndexedDB。
- RF5：清理旧树前确认没有 agentNew 文件还 import 旧 `src/agent`（目前 modelApi 等已独立，但 T 阶段移植时别遗留跨引用）。
- RF6（收口 note，非阻断）：`runAtom`（status/pendingQuestion）**不落盘**，只有 committed checkpoint 的 items 落盘（DK1）。⇒ 刷新时若 run 处于 `waiting_user`，pending question + 本轮中间 tool items 丢失，只能恢复到上一个已提交轮。符合 DK1 契约，留后续完善轮（若要恢复 waiting_user，需把 run 快照也纳入持久化）。

## §8 进度看板

| 块 | 阶段 | 状态 |
|---|---|---|
| T | T-1 tools registry | ✅ 已验收（codex 零 finding） |
| T | T-2 skills registry+md | ✅ 已验收（codex 零 finding） |
| T | T-3 瞬态 atom | ✅ 已验收（codex 零 finding） |
| T | T-4 tool 分发 | ✅ 已验收（+codex 修 save_file stale） |
| T | T-5 lazy 闸门 | ✅ 已验收（codex 零 finding） |
| T | T-6 tool 循环（改 modelRun） | ✅ 已验收（160 全绿，codex 零 finding） |
| T | T-7 ask_user 恢复 | ✅ 已验收（codex 收口：修 ask_user 与并列 tool_call 缺 result 的 P2；176 全绿） |
| T | T-8 UI（AskUser/Browser/Save 卡片） | ✅ 已验收（8 阶段多 agent + CSS；codex 收口修 2 个 P2；212 全绿。详见 T8-UI-PLAN） |
| D | D-1 IndexedDB driver | ✅ 已验收（codex 零 finding） |
| D | D-2 会话列表持久化 | ✅ 已验收（codex 零 finding） |
| D | D-3 hydrate | ✅ 已验收（codex 零 finding） |
| D | D-4 接线 | ✅ 已验收（codex 收口：修 revert 越界 turnIndex 仍 persistTruncate 误删全部盘 checkpoint 的 P2；176 全绿） |
| Ta | Ta-1 tauri init | 待开工 |
| Ta | Ta-2 sqlite driver | 待开工 |
| C | C-1/2/3 清理+验证 | 待开工 |

## §9 决策日志
- 2026-07-01：四块补全立项（T tool/skill · D 持久化 · Ta Tauri · C 清理）。
- 2026-07-01：调研旧 src/agent tool/skill 机制（Explore）；确认 agentNew 用 itemsAtom 直存取代 continuation blob（TK1），不建 delegate_agent（TK2），瞬态 atom 入会话 store 不分桶（TK5）。
- 2026-07-02：**T-8 完成**（8 阶段多 agent 派活 + 三卡片 CSS）。codex 收口 2 个 P2（无 P1）：waiting_user 时 Composer/sendMessage 未锁忙碌（顶掉暂停 run→非法 tool-call 序列）；revert 未剪 browserCards（丢弃轮卡片仍渲染）。均已修 + 回归测试。顺带 T-7 遗留的 codex P3（空 assistant 气泡）在 P8-g 一并解决。至此**块 T 全部完成**。
- 2026-07-01：首批 T-1/T-2/T-3/D-1 codex 零 finding。codex 顺带 4 个非首批项归后续：[P1] main.tsx seed 前应先 hydrate（→ D-4）；[P2] modelRun finish_reason（→ RUI5）；[P2] main.tsx 未传完整 model config baseUrl/model（→ 后续完善）；[P2] modelRun error 未在 UI 显示（→ T-8 UI 加 run.error 提示）。
- 2026-07-01：**T-7 + D-4 收口**（`codex review --uncommitted`，5 findings，无 🟥/P1）：
  - [P2] **modelRun ask_user 暂停前未补齐同条 assistant 里其它 tool_call 的 result** → model 并行发多 tool_call 且 ask_user 非最后一个时，resume 重发被 OpenAI 兼容接口拒（缺 tool result）。**已修**：重构为「先执行其它工具补齐 result，最后处理合法 ask_user 的暂停/已答」，+回归测试。
  - [P2] **commands revertToTurn 越界 turnIndex 仍 persistTruncate → truncateAfter(-1) 误删全部盘 checkpoint**。**已修**：revert 前校验 `0<=turnIndex<checkpoints.length`，否则整体 no-op，+回归测试。
  - [P2] **modelRun `thinking:false` 被映射成 undefined（丢用户显式关思考）**。**已修**：区分 undefined(省略)/true(enabled)/false(disabled)，`ThinkingConfig` 类型本就支持 disabled。
  - [P3] **MessageList 纯 tool_call 的 assistant(content:null) 渲染成空气泡** → 归 T-8（看板已记）。
  - [P3] **.gitignore 只加注释未真忽略验证产物**。**已修**：忽略 `.playwright-mcp/` + `agentnew-*.png`。
  - 顺带把收口前自评的 F1（tool 执行 await 后写回守卫，防将来工具转真异步）已补、F3（waiting_user 不落盘）记入 §7 RF6。至此 T-7/D-4 收口完成，176 测试全绿 + build 干净。
