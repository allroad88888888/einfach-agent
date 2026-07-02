# T-8：tool/skill UI 卡片移植计划（AskUser / Browser / Save）

> 架构师工作法：主会话不写实现码，只维护本文 / 派活 / 验收 / codex review。
> 前置：T-1..T-7 + D-1..D-4 已收口（每会话 store + runtime tool 循环 + ask_user 暂停/恢复 + 持久化）。
> 本轮把三张「工具产物 UI 卡片」从旧 `src/chat/` 移植进 `agentNew/ui/`，接进 AppShell，
> 并顺手解决 codex P3（MessageList 纯 tool_call 的 assistant 空气泡）。

---

## §1 设计契约（沿用既有，不可偏离）

| # | 契约 |
|---|---|
| U1 | UI 只做两件事：**读 atom**（useAtomValue）+ **调命令**（commands 导出的函数）。**绝不** 直接 setter atom / import writers（transientAtoms 的 add*/remove*/set* 是 writer）/ 碰 store 实例。 |
| U2 | 命令不收 `store`，内部自取 rootStore / `getSessionStore(activeId)`。命令可收业务 id（如 sessionId/questionId/artifactId），这不算「收 store」。 |
| U3 | 卡片渲染在**当前会话 store 的 Provider 下**（ActiveSessionProvider 内）——`useAtomValue(runAtom/browserCardsAtom/pendingArtifactsAtom/pendingQuestionAnswersAtom)` 读的都是该会话 store 的值。跨会话 id 需从 `rootStore.getter(activeSessionIdAtom)` 显式取（不能在会话 Provider 下 useAtomValue 它）。 |
| U6 | 单测先行（红→绿）；一文件一职责、独立新文件；UI 测试用 `@testing-library/react` + 会话 store 的 Provider（参考既有 `MessageList.test.tsx` / `Composer.test.tsx` 怎么塞 store）。 |
| TK5 | 瞬态 atom 已在会话 store（共享 key，值随 store 隔离）：`browserCardsAtom` / `pendingArtifactsAtom` / `pendingQuestionAnswersAtom`（见 `state/transientAtoms.ts`）。**禁止**分桶。 |
| PF4 | SaveArtifact 保存是异步（picker/write），保存完删除 artifact 必须删**归属会话**（点击时捕获的 sessionId），不能删「当前 active」——active 可能在异步期间被切走。 |

## §2 现状与差异（移植不是照抄）

- 旧卡片在 `src/chat/{AskUserQuestionCard,BrowserActionCard,SaveArtifact}.tsx`，用**旧单 store + `store` 参数 + `activeXxxAtom`**。移植到 agentNew 要改成 §1 的 U1/U2/U3 范式。
- **BrowserCard 变简单**：新 `BrowserCard = {id, createdAt, title, body?}`（无 items/options）。⇒ 新 BrowserActionCard 只渲染 title + body(markdown)，**无选项按钮、不起新 run**（旧版 buildOptionPrompt/startAgentRun 整段删）。
- **pendingQuestion 是 `unknown`**（RunState.pendingQuestion）：modelRun 存的是 `safeParseArgs(askCall.arguments)` 原样 args。⇒ AskUserQuestionCard 前必须**防御式 normalize** 成 `{title?, questions: AskUserQuestionItem[]}`。
- **markdown 组件**：agentNew 现用 `react-markdown`（见 MessageList），**不用** `@ai-components/markdown`（旧依赖，块 C 要清）。BrowserActionCard body 用 `react-markdown`。
- **textarea**：agentNew Composer 用原生 `<textarea>`（见 `ui/Composer.tsx`），**不用** `@ai-components/textarea-base`。AskUser 的 text 输入也用原生 textarea。

## §3 阶段拆分（一 P 一文件；依赖分波）

**首波（基础，独立并行）**
- **P8-a** `runtime/askUserQuestion.ts`（新）— 类型 `AskUserAnswerValue`(复用 transientAtoms 的)/`AskUserQuestionItem {id; text; type:'text'|'confirm'|'single-choice'|'multi-choice'; required?; options?}` + `normalizeAskUserQuestionPayload(payload: unknown): { title?: string; questions: AskUserQuestionItem[] }`（防御：payload 非对象/questions 非数组 → `{questions:[]}`；逐条校验 id/text/type，非法项丢弃；type 不识别→'text'）。测试：合法 payload 全字段；缺字段/错类型降级；空/非对象→空 questions。子 agent：`general-purpose`。
- **P8-b** `state/transientAtoms.ts`（改）— 加 `removePendingArtifact(id: string, artifactId: string): void`：ghost guard → 不可变 filter 掉该 artifactId。测试：扩现有 `transientAtoms.test.ts`——删存在项后数组少一且新引用；删不存在项 no-op（同引用可不强求，但不崩）；未登记会话 no-op。子 agent：`general-purpose`。

**二波（命令，依赖 P8-b）**
- **P8-c** `runtime/commands.ts`（改）— 加两个命令：
  - `answerQuestion(questionId: string, value: AskUserAnswerValue): void` — 取 activeId，`setPendingQuestionAnswer(id, questionId, value)`（内部 writer）。无 active → no-op。
  - `discardArtifact(sessionId: string, artifactId: string): void` — 收**显式 sessionId**（PF4，卡片点击时传归属会话），`removePendingArtifact(sessionId, artifactId)`。
  测试：扩 `commands.test.ts`——answerQuestion 写进当前会话 pendingQuestionAnswers；无 active no-op；discardArtifact 删指定会话的 artifact（不受 active 影响）。子 agent：`claude`。

**三波（卡片，依赖首/二波）**
- **P8-d** `ui/AskUserQuestionCard.tsx`（新）— 读 `runAtom`（status==='waiting_user' 且有 pendingQuestion 才渲染，否则 null）+ `pendingQuestionAnswersAtom`；`normalizeAskUserQuestionPayload(run.pendingQuestion)` 得 questions；逐题渲染控件（text=原生 textarea；confirm=是/否；single/multi-choice=选项按钮）；onChange→`answerQuestion(qid,value)`；必填项校验齐了才能「继续」→`resumeWithAnswers()`。移植 UI 结构参考旧 `src/chat/AskUserQuestionCard.tsx`（但换 §2 的组件/命令范式）。测试：waiting_user+payload 渲染问题；非 waiting_user→null；答必填后可提交、点继续调 resumeWithAnswers。子 agent：`claude`。
- **P8-e** `ui/BrowserActionCard.tsx`（新）— `function BrowserActionCard({card}:{card:BrowserCard})`：渲染 title + body(react-markdown)。纯展示，无按钮。测试：渲染 title；有/无 body。子 agent：`general-purpose`。
- **P8-f** `ui/SaveArtifact.tsx`（新）— 读 `pendingArtifactsAtom`（空→null）；每行 filename + 字符数 + 「保存」；保存走 File System Access（`showSaveFilePicker` 可调用检测）+ blob-link 降级（照搬旧逻辑，含 AbortError=用户取消不删、close 不掩盖 write 错）；保存成功→`discardArtifact(ownerSessionId, id)`，ownerSessionId 在**点击时** `rootStore.getter(activeSessionIdAtom)` 捕获（PF4）。测试：有 artifact 渲染行；空→null；点保存（mock showSaveFilePicker）成功后调 discardArtifact（可 mock commands）。子 agent：`claude`。

**四波（组装 + P3，依赖三波）**
- **P8-g** `ui/MessageList.tsx`（改）— ① **P3 修**：`assistant` 且 `content` 为 null/空白 → 跳过（不渲染空气泡）。② 合并 browser cards：读 `browserCardsAtom`，与 items 按 `createdAt` 合并排序后渲染（card 渲染 `<BrowserActionCard>`）。测试：空 content assistant 不渲染；browser card 按时间插在正确位置。子 agent：`claude`。
- **P8-h** `ui/AppShell.tsx`（改）— 在 ActiveSessionProvider 内挂 `<AskUserQuestionCard/>`（放 MessageList 与 CheckpointBar 之间或 Composer 上方）+ `<SaveArtifact/>`。测试：随会话 Provider 渲染出卡片挂载点。子 agent：`general-purpose`。

依赖链：`(P8-a ∥ P8-b) → (P8-c ∥ P8-e) → (P8-d ∥ P8-f ∥ P8-g) → P8-h`。

## §4 验收 & 收口
- 每 P：`git diff` 只落该文件 + 其测试 → `npx vitest run <file>` 绿 → 对照 §1（U1 不碰 writer/store、U3 Provider 读、PF4 归属会话）。
- 全部完成：`npx vitest run src/agentNew` 全绿 + `npm run build` 干净 + 浏览器手验（ask_user 暂停出卡片→答→继续；save_file 出待保存；render_card 出卡片）。
- `codex review --uncommitted` 收口，finding 分档（🟥 返工 / 🟨 累计 / 🟩 note）。

## §5 风险
- R1：normalize 面对 `unknown` 要够防御（模型可能发畸形 questions）——非法项丢弃、绝不抛。
- R2：MessageList 合并 browser cards 与 items 排序，createdAt 相同的稳定性（旧用 seq 兜底；这里 items/cards 都有 createdAt，必要时 id 兜底稳定排序）。
- R3：SaveArtifact 的 PF4——ownerSessionId 必须点击时捕获，别在 async 之后读 active。
- R4：UI 测试在会话 store Provider 下渲染，注意 runAtom/transient atom 要 set 到**该 session store**（参考既有 UI 测试）。

## §6 进度看板
| P | 目标文件 | 状态 |
|---|---|---|
| P8-a normalize+类型 | `runtime/askUserQuestion.ts` | ✅ 已验收（6 用例绿） |
| P8-b removePendingArtifact | `state/transientAtoms.ts` | ✅ 已验收（18 用例绿） |
| P8-c 命令 answerQuestion/discardArtifact | `runtime/commands.ts` | ✅ 已验收（26 用例绿+tsc0） |
| P8-d AskUserQuestionCard | `ui/AskUserQuestionCard.tsx` | ✅ 已验收（4 用例绿，U1 严守） |
| P8-e BrowserActionCard | `ui/BrowserActionCard.tsx` | ✅ 已验收（2 用例绿） |
| P8-f SaveArtifact | `ui/SaveArtifact.tsx` | ✅ 已验收（7 用例绿，PF4 落实） |
| P8-g MessageList（P3+合并卡片） | `ui/MessageList.tsx` | ✅ 已验收（5 用例绿+全套193绿） |
| P8-h AppShell 挂载 | `ui/AppShell.tsx` | ✅ 已验收（4 用例绿；右栏顺序 MessageList→Save→Checkpoint→Ask→Composer） |
| （架构师补）三卡片 CSS | `ui/agentnew.css` | ✅ 补齐（browser-card / save-artifact / ask，配色对齐现有） |

全套：`npx vitest run src/agentNew` **31 文件 / 212 测试全绿**；`npm run build`（tsc+vite）干净。

## §7 codex 收口（`review --uncommitted`，2 findings 无 P1）
- [P2] **waiting_user 时 Composer 仍可发消息 → 顶掉暂停中的 run，ask_user tool_call 无 result，重发非法**。**已修**：Composer 把 waiting_user 也算锁定（禁输入/禁发送/不显停止）；命令层 `sendMessage` 加忙碌守卫（running/awaiting_tool/waiting_user → no-op）双保险。+2 回归测试。
- [P2] **回退后被丢弃轮次的 browser 卡片仍渲染**（browserCards 不进 checkpoint 快照，revert 只截断 items）。**已修**：新增 `pruneBrowserCardsAfter(id, createdAt)` 写入器，`revertToTurn` 按回退点 checkpoint 的 createdAt 剪掉之后的卡片。+2 回归测试（含 pruner 单测）。
- 收口后：212 测试全绿 + build 干净。**T-8 完成。**
