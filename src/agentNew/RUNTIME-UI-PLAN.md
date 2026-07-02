# runtime 接线 + UI 层计划（两栏 · 类 codex app）

> 架构师工作法：主会话不写实现码，只维护本文 / 派活 / 验收 / codex review。
> 前置：状态层已完成（rootStore + 每会话 store + writers + checkpointWriters + historyDriver）。
> 本阶段把状态层「接活」：加最小 runtime + 命令 API + 两栏 UI，让应用真正能跑。
> 旧 `src/agent` 已废弃，本阶段全部在 `agentNew/` 内新建。

---

## §0 背景与依赖

- **已有**：`state/`（rootStore/sessionAtoms/sessionStore/sessionWriters/checkpointWriters/persistence）+ `api/`（callDeepSeek/callGlm）。
- **缺**：① 一个能跑的 run（把用户输入送模型、把回复写回）；② UI 调用的命令入口；③ 两栏界面；④ esc 中断、checkpoint 接线、持久化接线。
- 现有栈参考：React 18 + `@einfach/react`（Provider/useAtomValue）+ 纯 CSS（`src/styles/global.css`）+ `react-markdown` + `@ai-components/*`。

## §1 设计契约（不可偏离）

| # | 契约 |
|---|------|
| **U1 runtime/UI 隔离** | UI 只做两件事：**读 atom**（useAtomValue 渲染）+ **调命令**（runtime 导出的 command 函数）。UI **绝不** 直接 `setter` atom、不 import writers、不碰 store 实例。命令是唯一边界。 |
| **U2 命令不收 store** | 每个 command **不接 `store` 参数**（区别于旧 loop.ts）——内部自取 rootStore / `getSessionStore(activeId)`。UI 不需要、也拿不到 store 引用。 |
| **U3 每会话 store 的 Provider 分层** | 根 `<Provider store={rootStore}>` 管全局+左栏；右栏内容包 `<Provider store={getSessionStore(activeId).store} key={activeId}>`，切会话即换 store。会话内组件读 `itemsAtom`/`runAtom`/`checkpointsAtom`。 |
| **U4 两栏布局（类 codex app）** | 左＝对话列表，右＝当前对话内容。先简单，不做三栏/工具时间线等旧复杂度。 |
| **U5 最小垂直切片先行** | 首个 run 只做**单轮对话**：append user → 调 model（api/）→ append assistant。**不做** lazy tools / 多 agent / pipeline（留后续）。先让"发消息→有回复→两栏显示"跑通。 |
| U6 | 单测先行（红→绿）；一文件一职责、独立新文件（沿用状态层 C6/C9）。UI 组件测试用 `@testing-library/react` + `renderWithStore`。 |
| U7 | 命令内 model 调用 signal 全穿透（esc 可断）；model 失败不抛崩 UI（降级为一条错误 assistant 或 run.status='error'）。 |

## §2 runtime 命令 API（UI 唯一入口 · 隔离边界）

放 `runtime/commands.ts`（可按域拆多文件，但对 UI 是一组函数）。**全部不收 store**：

```ts
// 会话
newSession(opts?: { title?; settings? }): string   // 建会话→登记 rootStore.sessionsAtom→设为 active，返回 id
selectSession(id: string): void                     // 切 activeSessionIdAtom
removeSession(id: string): void                     // 删 sessionsAtom 条目 + dropSessionStore(id)

// 运行
sendMessage(input: string): void                    // 对 active 会话起 run（见 §5 P-R2）；run 结束→commitCheckpoint
stopRun(): void                                     // esc：中断 active 会话正在跑的 run

// 回退
revertToTurn(turnIndex: number): void               // 对 active 会话 jumpToCheckpoint(turnIndex)
```

UI 侧只 import 这些 + 读 atom。命令内部编排 writers（appendItem/patchRun…）、abortRegistry、model（callDeepSeek/callGlm）、checkpointWriters、driver。

## §3 React Provider 分层（每会话 store）

```tsx
<Provider store={rootStore}>                 // 根：左栏 + 全局读 activeSessionId/sessions
  <AppShell>
    <Sidebar><SessionList/></Sidebar>        // 读 rootStore.sessionsAtom
    <ActiveSessionProvider>                  // 读 activeSessionId → getSessionStore(id).store
      <ConversationPane>                     // 右栏，Provider=该会话 store
        <MessageList/> <CheckpointBar/> <Composer/>
      </ConversationPane>
    </ActiveSessionProvider>
  </AppShell>
</Provider>
```

`ActiveSessionProvider`：`const id = useAtomValue(activeSessionIdAtom); return <Provider store={getSessionStore(id).store} key={id}>` —— `key={id}` 保证切会话时右栏整体重挂到新 store。

## §4 UI 组件树（两栏，纯 CSS）

- `ui/AppShell.tsx` — flex 两栏容器 + 根布局。
- `ui/Sidebar/SessionList.tsx` — 会话列表 + 「新建」按钮；点击项→`selectSession`，新建→`newSession`，删除→`removeSession`。读 `sessionsAtom`/`activeSessionIdAtom`。
- `ui/ActiveSessionProvider.tsx` — §3 的 store 切换。
- `ui/Conversation/MessageList.tsx` — 读 `itemsAtom`，渲染 user/assistant（assistant 走 react-markdown）。
- `ui/Conversation/Composer.tsx` — 输入框（`@ai-components/textarea-base`）→ `sendMessage`；停止按钮 + 全局 Esc → `stopRun`；忙碌态读 `runAtom`。
- `ui/Conversation/CheckpointBar.tsx` — 读 `checkpointsAtom`/`currentTurnIndexAtom`，列出各轮，点击→`revertToTurn`（先简单：一行可点的轮列表）。

## §5 分期（P 阶段，一文件一职责）

**runtime 先行（UI 的前提）**
- **P-R1** `runtime/abortRegistry.ts` — `Map<sessionId, AbortController>` 模块单例 + `beginRun(id)→signal` / `abortRun(id)` / `endRun(id, controller)`（finally 只删自己那个）。测试：begin→abort 触发 signal；重复 begin 顶掉旧。
- **P-R2** `runtime/modelRun.ts` — 最小单轮 run：`runSession(id, input, {signal,apiKey,fetchImpl?})`：appendItem(user) → setRun('running') → 调 model（穿 signal）→ appendItem(assistant) → commitCheckpoint → done。失败降级（U7）。**⚠️ stale-run 守卫（RUI2）**：所有异步写回/降级前必须 `isCurrentRun(id, runId)`（会话在 && `runAtom.runId===本次 runId`）——否则被顶掉的旧 run 迟到写回会污染新 run。测试：跑通一轮；abort→stopped；error 降级；未登记 no-op；**stale-run 不覆盖新 run**。
- **P-R3** `runtime/commands.ts` — §2 全部命令，编排 R1/R2 + writers。测试：newSession 登记+激活；sendMessage 起 run；stopRun 中断；revertToTurn 回退。

**UI（依赖 runtime）**
- **P-U1** `ui/AppShell.tsx` + `ui/ActiveSessionProvider.tsx` — 两栏骨架 + store 分层。测试：切 activeSessionId → 右栏 Provider 换 store。
- **P-U2** `ui/Sidebar/SessionList.tsx` — 列表 + CRUD 命令接线。
- **P-U3** `ui/Conversation/MessageList.tsx` — 渲染 itemsAtom。
- **P-U4** `ui/Conversation/Composer.tsx` — sendMessage + stopRun + Esc hook。
- **P-U5** `ui/Conversation/CheckpointBar.tsx` — 轮列表 + revertToTurn。

**接线/持久化**
- **P-P1** driver 接线 — commitCheckpoint 后 `driver.saveCheckpoint`；启动时 `listCheckpoints` 回填。载体先 `createMemoryHistoryDriver`（或 IndexedDB），接口不变。
- **P-T1（桌面，最后）** Tauri 壳 + `tauri-plugin-sql` 的 HistoryDriver 实现。

依赖链：R1→R2→R3 →（U1→U2/U3/U4 可并行→U5）→ P1 → T1。

## §6 风险
- RUI1：einfach `<Provider>` 嵌套 + `key` 切 store 的重挂行为需先用一个 spike 验证（U3 是整个 UI 的地基）。
- RUI2：命令编排里 model 调用是异步，signal/abort 与 run 生命周期要对齐（沿用状态层 ghost guard 思路：写回前查会话还在）。
- RUI3：最小切片刻意砍掉 lazy tools/多 agent —— 别让子 agent「顺手」把旧 loop 的复杂度搬回来（U5）。
- RUI4：UI 测试要用 renderWithStore + 每会话 store，注意 Provider 分层下测试怎么塞 store。
- RUI5（待办 P2）：modelRun 未记录 model finish_reason（length 截断等非 stop 结束当成 done）。累计，后续 run 完善轮补（写 `RunState.finishReason`；length 可给"回复可能被截断"提示）。

## §7 已拍板（2026-07-01）
1. **最小 run 范围** = 单轮对话垂直切片（input→model→reply），不做 lazy tools/多 agent（U5）。
2. **checkpoint 回退 UI** = 做可点的轮列表 CheckpointBar（P-U5）。
3. **Tauri 时机** = 先纯浏览器跑通（driver 内存/IndexedDB），Tauri 壳留最后（P-T1）。

## §8 决策日志
- 2026-07-01：下一阶段 = runtime 接线 + 两栏 UI；契约 U1（UI 只读 atom+调命令）、U2（命令不收 store）、U3（每会话 store 的 Provider 分层）、U5（最小单轮切片先行）。
- 2026-07-01：§7 三项拍板——单轮切片 / CheckpointBar / 先浏览器后 Tauri。进入 §5 分期派活；首批 P-R1 + P-R2。
- 2026-07-01：codex 抓出 **P-R2 缺 stale-run 守卫**（异步写回只查会话存在、未查 runId → 新 run 顶掉旧 run 后，旧 run 迟到写回污染新 run，P1）。根因是 P-R2 spec 漏写 `isCurrentRun`（旧架构红线，架构师 spec 第二次疏漏），已补 spec 并返工。
- 2026-07-01：P-R2 两个 P2（settings 转发 / 空回复→error）已修复复评清除。codex 再浮第三个 P2「记录 non-stop finish_reason（length 截断）」——**判定累计不返工**（非阻断；最小切片阶段 max_tokens 多默认、length 少见；modelRun 已迭代 3 轮，边际收益低）。见 RUI5，后续 run 完善轮统一处理。
- 2026-07-01：codex 对 P-R3 commands 提 [P2] removeSession 删会话前未 abort 其 run（controller 泄漏 + model 请求白跑）、[P3] `crypto.randomUUID?.()` 未防 crypto 全局未定义（commands + modelRun 同款）。修 P2 + 抽共享 `runtime/newId.ts`（正确 crypto guard，参考旧 atoms.ts createId），commands/modelRun 复用。
- 2026-07-01：复评清除上二者后再浮 [P2] revertToTurn 回退前也应 abort 当前 run（与 removeSession 同款「破坏性命令前先停 run」）。修 revertToTurn 加 abortRun。至此命令层 mutate-before-abort 一致（removeSession + revertToTurn）。
- 2026-07-01：codex 浮 [P2] modelRun 写回前未查 `signal.aborted`（esc race：fetch 在 abort 前已返回时，isCurrentRun 仍真 → 错写成 done+assistant，应为 stopped）。修：成功写回段加 signal.aborted 守卫。至此 modelRun 写回守卫三件套齐全 = 会话存在(ghost) + runId 匹配(stale-run) + signal 未 abort(esc race)。

## §9 进度看板

| 阶段 | 目标文件 | 状态 |
|---|---|---|
| P-R1 abortRegistry | `runtime/abortRegistry.ts` | ✅ 已验收（codex 零 finding） |
| P-R2 最小单轮 run | `runtime/modelRun.ts` | ✅ 已验收（finish_reason P2 累计，见 §8/RUI5） |
| P-R3 命令 API | `runtime/commands.ts` | ✅ 已验收（codex 零 finding） |
| P-R3b 共享 newId | `runtime/newId.ts` | ✅ 已验收 |
| P-U1 两栏骨架+Provider | `ui/AppShell.tsx` + `ui/ActiveSessionProvider.tsx` | ✅ 已验收（RUI1 成立，codex 零 finding） |
| P-U2 SessionList | `ui/SessionList.tsx` | ✅ 已验收（codex 零 finding） |
| P-U3 MessageList | `ui/MessageList.tsx` | ✅ 已验收（codex 零 finding） |
| P-U4 Composer | `ui/Composer.tsx` | ✅ 已验收（codex 零 finding） |
| P-U5 CheckpointBar | `ui/CheckpointBar.tsx` | ✅ 已验收（codex 零 finding） |
| P-U6a AppShell 组装 + CSS | `ui/AppShell.tsx` + `ui/agentnew.css` | ✅ 已验收 |
| P-U6b main.tsx 切 agentNew | `main.tsx` | ✅ 已验收（浏览器跑通：build 0 + 发消息→DeepSeek 回复→checkpoint 全链路） |
| P-P1 driver 接线 | 跨文件接线 | 待开工 |
| P-T1 Tauri 壳 | 桌面（最后） | 待开工 |
