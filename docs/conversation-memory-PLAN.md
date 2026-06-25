# 跨 turn 对话记忆（摘要压缩）· 实施计划（PLAN）

> Feature：给 web-agent 加跨 user-turn 的对话记忆，方案 = **summary-buffer memory**（摘要 + 最近批次原文）。
> 现状：模型每个 turn 只收到当前 input + worker 信号，`messagesBySessionAtom` 历史从不进模型 → 不记得前几句。
> 角色：主会话 = 架构师（不写实现代码，只维护本文档 / 派活 / 验收 / 跑 codex review）。
> 本版已消化 codex 对计划的对抗评审（8🟥 + 7🟨）。

---

## §0 设计共识与核心定义

- **记忆 = 应用层每次重传历史**；LLM 无状态。run 开始时把"摘要 + 最近批次原文"注入模型初始 messages。
- **summary-buffer**：旧消息压成摘要；**最近一批原文始终在场**（绝不压）。
- **两个常量必须分开**（codex🟩）：
  - `SUMMARY_TRIGGER_TURNS = 6`（触发阈值）：未压的完成轮 ≥ 此值才触发压缩。
  - `RAW_WINDOW_TURNS = 3`（保留窗口）：压缩时**始终留最近 3 轮原文不压**。
- **完成轮 (completed turn)** = 一对 `[user, 已完成 assistant(streaming:false)]`。计数/游标按完成轮，**不**按裸 `messages.length`（codex🟥8/🟨3）。
- **当前 run 边界（codex🟥2/🟥3）**：`startAgentRun` 在 append 当前 user **之前**捕获 `historyEndId/Index`，作为"历史截止点"传入 context builder。本 run 内产生的所有消息（当前 user 句、AskUser 的"我需要先确认…"assistant 占位、"已补充:"user、最终 assistant）**都不算历史**；run 完整 `done` 后才进入下一个 run 的历史/压缩候选。AskUser resume 复用同一 run 边界。
- **eligible message 过滤（codex🟥8）**：历史候选排除 ① 初始 welcome（首条 assistant）② `role==='system'` ③ `streaming:true` ④ 空 content。
- **continuation 只首轮注入（codex🟨1）**：`conversationContext` 在 `resolveAgentTurn` 前**一次性构造**，只注入**非 continuation 首轮** `buildAgentTurnMessages`；`buildContinuationMessages` 分支**禁止再拼历史**（它 early-return 复用 `state.messages`，历史已在首轮进入该数组）。
- **失真无声、无探测器**：不造失真触发器。有用的失真自暴露为"信息缺口"→ 落入现有 `ask_user_question`；无用的失真无所谓。
- **真正防 silent 失真**：① 摘要强制结构化要点；② **仅在有记忆时** system 注入"记忆模糊且影响答案则优先 ask、别硬答"。诚实承认：这是 prompt 级缓解，**不能保证**语义不失真（Rm2）。

---

## §1 设计契约（不可偏离）

1. **纯浏览器**，无后端/Node-only。
2. **本 feature 允许、且仅允许如下 model 协议扩展**：`AgentTurnInput` 加可选 `conversationContext`；`ModelAdapter` 加 `summarize` 方法。**仍禁止**改 `AgentTurnResult`、`runAgentTurn` 返回语义、多轮 loop（`resolveAgentTurn`）结构、architect-worker 编排。
3. **状态只用 @einfach/core atoms**，复用 helper + ghost 守卫（session 不存在 no-op）。
4. **失败降级不抛**：`summarize` 失败 → **不推进游标、不写摘要**（下次 run 读旧游标，自然把未压原文全注入）；只有 `signal.aborted` 才上抛 AbortError。
5. **不破坏现有 162 测试**；`fileParallelism:false` 不动；`npm run build` 必须通过。
6. **测试先行（TDD）**；LLM 一律 mock 驱动。
7. **不碰** P1/P2/P3 功能行为（snapshot 仅**可选**扩展一个字段，见 §1.9）。
8. **空 context 等价现状（回归红线，codex🟥6）**：当 `conversationContext` 无 summary 且无 eligible recentMessages 时，DeepSeek request body 必须与现状 **byte-level 等价**（含 system 文本）——"不确定就 ask"引导**只在有记忆时**注入。必须有对应回归测试。
9. **snapshot 向后兼容（codex🟥7）**：`conversationMemory` 在 Snapshot 中为**可选字段，缺失默认 `{}`**；旧 v1 快照（无该字段）**不得**被 `parseSnapshot` 丢弃，必须仍能恢复 sessions/messages。

---

## §2 多 agent 工作流

| 任务类型 | subagent_type |
|---|---|
| 调研（确认 buildAgentTurnMessages/continuation 形态、ChatMessage 流） | `Explore` |
| 实现（测试先行 + 写代码，跨 model+loop+state+persistence） | `claude` |

派活 prompt 5 字段：契约链接 / 阶段范围+文件 / 测试先行红→绿 / 禁止项 / 产出。
验收：架构师亲读 diff + 复跑 `npm test`/`tsc -b`/`npm run build` + 逐条契约打勾 + 每阶段 codex 对抗 review。

---

## §3 阶段拆分

### M1 · 记忆注入管线（先做"滑动窗口"，不压缩 —— 先让模型"看见"历史）

- **M1.1** 新增 `conversationMemoryBySessionAtom: Record<sid, { summary: string; summarizedUpTo: number }>`（`summarizedUpTo` = 已压到第几条**消息**的游标，初始 0）。helper 带 ghost 守卫；`deleteSession` 清理。
- **M1.2** `AgentTurnInput` 加 `conversationContext?: { summary?: string; recentMessages: { role: ChatRole; content: string }[] }`（命名 `recentMessages` 而非 turns，codex🟩1）。
- **M1.3** run 前在 `executeRun` 入口一次性构造 context：取 `messages.slice(summarizedUpTo, historyEndIndex)`（historyEndIndex = 本 run 起点，§0 边界）→ 应用 eligible 过滤 → 转 `{role,content}[]` 作为 `recentMessages`；`summary` = 该 session 摘要。**M1 阶段** `summarizedUpTo` 恒为 0、summary 恒空 → recentMessages = 全部 eligible 历史（滑动窗口在 M2 才裁）。
- **M1.4** `buildAgentTurnMessages` 拼装：`system`（原指令 + 若 summary 非空追加「先前对话摘要：…」）→ `recentMessages` 展开 `[user,assistant,…]` → 当前 user（现状含 worker 信号）。**continuation 分支不改、禁止再拼历史**（§0）。空 context → byte 等价现状（§1.8）。
- **M1.5** mock-adapter 读取并暴露 `conversationContext`（测试可断言历史注入 + continuation 第二轮不重复注入，codex🟨6）。
- 测试：边界捕获正确（当前 run 消息不入历史）；eligible 过滤（welcome/system/streaming/空 排除）；buildAgentTurnMessages 首轮含历史、**continuation 第二轮只含 state.messages+tool 不重复追加**；空 context byte 等价现状；ghost 守卫 + deleteSession 清理。

**M1 返工（codex 第 1 轮评审后 · 必修）**：
- MF1（🟥）eligible welcome 误判：`index===0` 无条件排除会误杀**新建 session 的首条 user**（createSession 初始 messages 空）。改 `index===0 && role==='assistant'` 才排除。补 createSession 后连续两轮回归测试。
- MF2（🟥 Rm9）continuation 不重复注入有漏洞：`continuation ? undefined` 只挡带 continuation 的轮,但多轮里 tool_request/tool_payload **不一定带 continuation**(mock/JSON fallback 路径)→ 仍重复注入。改用 `turnIndex===0`/`contextConsumed` flag,**只第一个 model turn 传 context**。补多轮断言 `[ctx, undefined, …]`。
- MF3（🟥）resume 缺 boundary：`run.historyEndIndex` 缺失时 fallback 到当前 messages.length → 把"已补充"/本 run 消息塞进历史。改为**缺 boundary 时保守禁用 memory(不注入历史)**,绝不用当前 length。
- MF4（🟥）完成轮语义：当前只做 message 级过滤,stopped/error/waiting_user 遗留的 user/AskUser placeholder 会进下一 run 历史。改为**按完成轮 `[user, assistant streaming:false]` 配对构造候选**,排除未完成 run 残留(§0 completed turn)。
- MF5（🟨）`isValidRun` 校验 `historyEndIndex`（`undefined` 或非负整数）防坏快照;补旧快照缺/坏字段 + waiting_user resume 测试。
- MF6（🟨,评估纳入）异步写回前加 `currentRun?.id === runId` guard(start-while-running/stop-then-resend);若改动可控则做,否则单列说明。

**M1 返工2（codex 第 2 轮 · MF1–MF6 验证修对,剩 2🟥,架构师分判）**：
- MF7（🟥 必修）`isRuntimeScaffolding` 的 content 前缀匹配会误删真实用户/assistant 消息(以"已补充："或"我需要先确认"开头)→ 记错历史。改为**结构化标记**:`ChatMessage` 加 `scaffold?: 'ask-placeholder' | 'answer-echo'`;loop 生成占位/回显消息时打标记;`isRuntimeScaffolding` 按标记判定(删 content 前缀依赖);persistence `isValidMessage` 接受可选 scaffold(坏值处理)。补真实前缀内容不丢失 + 历史轮保留测试。
- MF6 升级版（codex🟥:守卫下沉到所有 write-back helper + wait 对 aborted 立即 reject）→ **架构师评估记 backlog(D-mem-7),不在 M1 做**:既有并发问题(非 M1 引入),且不影响记忆正确性(streaming 半条已被 eligible 排除不进历史;late return 已被终态守卫实证挡住)。

### M2 · 摘要压缩（把滚出窗口的旧消息压成摘要）

- **M2.1** `ModelAdapter.summarize(input: { previousSummary?: string; messages: {role,content}[]; signal? }): Promise<{ summary: string; source }>`；DeepSeek 实现（结构化 prompt）+ Mock 实现（确定性输出 + **可控失败/延迟**用于测 Rm3，codex🟨2）。
- **M2.2 触发与游标（codex🟥1/🟥5）**：仅当 run 成功落 **`done`** 且最终 assistant `streaming:false` 后**异步**触发；`waiting_user`/`stopped`/`error`/`abort` **永不触发**。计算未压**完成轮**数，≥ `SUMMARY_TRIGGER_TURNS` 时，压缩区间 = `[summarizedUpTo, eligibleEnd - RAW_WINDOW_TURNS*2)`（**始终保留最近 `RAW_WINDOW_TURNS` 轮原文**）。
- **M2.3 结构化摘要 prompt**：强制分块 `用户偏好 / 已确认决策 / 关键事实·约束 / 未决事项`，丢弃寒暄；中文；`新摘要 = summarize(previousSummary + 压缩区间)`。
- **M2.4 CAS 写回（codex🟥4）**：摘要任务开始时快照 `{ baseCursor, baseSummary, targetCursor }`；完成后**重读 atom**，仅当当前 `summarizedUpTo === baseCursor` 才提交（写 summary + 推进到 targetCursor），否则丢弃本次结果（下个 run 重算）。**单 session 单飞**（在飞时不并发起第二个）。
- **M2.5 降级（措辞修正，codex🟨4）**：`summarize` 失败 → 不推进 cursor、不写 summary；下一次 run 读旧 cursor 后自然把未压原文全部注入。不抛、不阻塞主流程。
- 测试：满阈值触发 + 压缩后**最近 RAW_WINDOW_TURNS 轮仍以原文注入**；增量摘要入参含 previousSummary；未满阈值不压；非 done 状态不触发；CAS——并发/快连发下 stale 任务被丢弃不覆盖新游标；**delayed summarize + deleteSession** 不复活已删 session（ghost，codex🟨7）；summarize 失败降级 run 仍正常。

### M3 · 持久化 + "不确定就 ask" 引导

- **M3.1 snapshot 兼容（§1.9）**：`conversationMemory` 作为 **可选** 字段进 capture/parse/apply/订阅；`parseSnapshot` 缺失 → 默认 `{}`，**旧快照仍恢复**。深校验 memory 结构（坏则该字段回默认，不丢整快照）。
- **M3.2 ask 引导（条件注入，§1.8）**：**仅当** conversationContext 有 summary 或 recentMessages 时，system 追加"记忆模糊且影响答案则优先 ask_user_question、勿硬答"。无记忆时不注入。
- 测试：snapshot round-trip 带 memory；**旧 v1 快照(无 memory)仍恢复 sessions/messages**；corrupt memory 回默认不丢快照；引导 prompt 仅在有记忆时出现、无记忆时 system 等价现状。

> **范围红线**：本次**不做**结构化 KV 长期记忆（关键事实单独存库绕开摘要）——留后续（D-mem-3）。本次只在摘要文本里保结构化要点。

---

## §4 测试先行硬性条款

| 阶段 | vitest 最小集 |
|---|---|
| M1 | run 边界(当前句不入史) · eligible 过滤 · 首轮含史 · **continuation 第二轮不重复注入** · 空 context byte 等价现状 · ghost/删除清理 |
| M2 | 满阈值触发+**保留 RAW_WINDOW** · 增量入参 · 未满不压 · 非 done 不触发 · **CAS 丢弃 stale** · delayed+deleteSession ghost · 失败降级 |
| M3 | snapshot round-trip · **旧快照(无 memory)兼容** · corrupt 回默认 · 引导仅有记忆时注入 |

LLM 一律 mock；跳过红→绿直接交实现 → 返工。

---

## §5 codex review 用法

- 计划评审（本轮）：`codex exec` 对抗评审（已完成，8🟥+7🟨 消化进本版）。
- 每阶段收尾：`codex review --uncommitted` 或 `codex exec` 对抗评审；🟥 返工 / 🟨 并入下阶段 / 🟩 记 note。
- 分支：`feat/conversation-memory`（off main），阶段累积，验收 + review 后合 main。

---

## §6 风险登记

| ID | 风险 | 对策 |
|---|---|---|
| Rm1 | 协议扩展触及 model 层 | §1.2 限定；不碰 AgentTurnResult/多轮 loop/编排 |
| Rm2 | 多层摘要 silent 失真 | M2.3 结构化要点 + M3.2 有记忆时 ask 引导；**诚实：prompt 级缓解，不保证语义不失真**；KV 留后续 |
| Rm3 | 异步摘要与下个 run 竞态 | **M2.4 CAS 写回** + 单 session 单飞；run 前读一致快照 |
| Rm4 | summarize 多花一次 LLM 调用 | run 后异步、阈值触发、失败降级不影响主流程 |
| Rm5 | 注入撑大 context | RAW_WINDOW + 摘要压缩；超长摘要再压 |
| Rm6 | AskUser 暂停/半成品消息入史 | §0 run 边界 + eligible 过滤 + 只 done+streaming:false 触发 |
| Rm7 | 注入破坏现状对话(回归) | §1.8 空 context byte 等价 + 回归测试 |
| Rm8 | 旧 snapshot 被丢弃 | §1.9 可选字段默认 {} + 旧快照恢复测试 |
| Rm9 | continuation 重复注入历史 | §0 只首轮注入；continuation 分支禁拼史 + 回归测试 |

---

## §7 进度看板

| 阶段 | 状态 |
|---|---|
| 计划 | ✅ 定稿（codex 8🟥+7🟨 消化 + D-mem-2/3/4 拍板）|
| M1 记忆注入 | ✅ 完成 — 3 轮 codex review 收口无阻断(201 绿/build 通过);scaffold 结构化标记;MF6 升级版 + role/kind 校验记 backlog |
| M2 摘要压缩 | 未开始 |
| M3 持久化+ask 引导 | 未开始 |

---

## §8 决策日志（含待拍板）

| ID | 决策 | 状态 |
|---|---|---|
| D-mem-1 | 方案 = summary-buffer（摘要 + 最近批次原文），增量摘要 | 已定 |
| D-mem-2 | 触发 `SUMMARY_TRIGGER_TURNS=6`、保留 `RAW_WINDOW_TURNS=3`，run 后异步、CAS 写回 | ✅ 已定（取值 6 / 3）|
| D-mem-3 | 本次不做结构化 KV 长期记忆，仅摘要文本保结构化要点 | ✅ 已确认（KV 留后续）|
| D-mem-4 | 放宽 model 协议：加 `conversationContext` + `summarize`（限定最小范围，不碰多轮 loop/编排）| ✅ 已确认（feature 必要前提）|
| D-mem-5 | 防 silent 失真 = 结构化摘要 + 有记忆时 ask 引导（不造探测器），承认不保证语义 | 已定 |
| D-mem-6 | 阶段顺序 M1(滑窗注入)→M2(压缩)→M3(持久化+引导)；M1 先不压缩，渐进可测 | 架构师已定 |
| D-mem-7 | **backlog**：run supersede 时把 `isCurrentRun`/`signal.aborted` 守卫下沉到所有 write-back helper(ensureToolLoaded/streamAssistantAnswer/timeline) + `wait` 对已 aborted 立即 reject。既有并发问题、不影响记忆正确性,独立处理 | 架构师评估,记 backlog |
| D-mem-8 | **遗留🟨**：`isValidMessage` 增加 scaffold↔role 配对校验(`ask-placeholder` 仅 assistant、`answer-echo` 仅 user);仅坏快照角色错配的极边缘场景,codex 判不影响收口 | 记 backlog |

---

_本文档由架构师维护。每阶段收尾更新 §7，新决策追加 §8。_
