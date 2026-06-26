# browser_action 真实化（渲染卡片）· 实施计划（PLAN）

> 背景：`browser_action` 是初版遗留 **空壳 stub**——执行分支只返回 `{accepted:true,...}`、零渲染、enum 无"卡片"、无组件消费。结果模型拿到 `accepted:true` → **幻觉式说"卡片已渲染好",实则界面空白**(用户实测复现)。"假成功"型恶性 bug。
> 目标：做成**真实渲染卡片到对话流**。本版已消化 codex 计划评审(5🟥)。
> 角色：架构师不写实现,只维护文档 / 派活 / 验收 / 跑 codex review。

---

## §0 三段术语（codex🟩,避免混淆）
- **accepted** = 卡片已确认写入 atom(`addBrowserCard` 返回 ok)。
- **rendered** = 组件从 active atom 读到并挂载。
- **visible** = ChatShell/MessageList 集成测试通过(真出现在对话流)。
工具只能在 **accepted** 为真时报 `accepted:true`——这正是要根除的"假成功"。

---

## §1 设计契约（不可偏离）

1. **纯浏览器**;走现有 **lazy-tool 架构**(registry summary+schema、`runRuntimeTool` 分支),不绕过。
2. **accepted 严格(codex🟥1)**:`addBrowserCard(store, sessionId, card)` 返回 `{ ok:false } | { ok:true, cardId }`;**仅当卡片真插入后才返回 `accepted:true`**,否则 error JSON。绝不再"假成功"。
3. **stale-run 守卫(codex🟥2)**:工具写卡片**前**检查 `signal.aborted` + `sessionExists` + `isCurrentRun(store, sessionId, runId)`(复用 M1 既有守卫);旧 run 被 supersede → 不入 atom、不 accepted。需把 `runId` 透传到 browser_action 执行处。
4. **payload 严格 normalize(codex🟥5)**:`title` 必须非空字符串;`body` 可选字符串;`items`/`options` 仅保留非空字符串、空则丢该字段。无法 normalize → `formatRuntimeToolError`、不入 atom、不抛。
5. **工具不直接 append 消息(§1.12)**:只写 atom + 返回 result JSON 回灌模型;最终文字回复由模型下一轮产出。**最终 assistant 文本仍要概括卡片关键内容**(codex🟨:卡片不持久化,丢了不致信息不可恢复)。
6. **状态用 einfach atoms** + ghost 守卫 + `deleteSession` 清理;失败降级不抛(AbortError 除外);**不破坏现有 235 测试**;不改 `AgentTurnResult`/多轮 loop 结构/编排。
7. **测试先行(TDD)**,LLM 一律 mock。

---

## §2 设计

- **action 收敛为只 `render_card`**(D1):移除空壳的 `render_question`(ask_user_question 覆盖)/`show_timeline`(右栏已有)/`stop_run`(顶部停止按钮已有);**同步更新 registry description + `tool-loading.md` skill**(现仍说 browser 工具能"展示问题卡片/停止 run",会误导模型,codex🟨)。
- **payload**:`{ title: string; body?: string(markdown); items?: string[]; options?: string[] }`。
- **新 atom** `browserCardsBySessionAtom: Record<sid, BrowserCard[]>`(`BrowserCard = { id, createdAt, title, body?, items?, options? }`);按 session、ghost 守卫、`deleteSession` 清理。**不持久化**(临时 UI 产物,与 save_file 一致,D2)。
- **runRuntimeTool `render_card` 分支**:normalize payload → stale 守卫 → `addBrowserCard`(返回 ok+cardId)→ 返回 `{ accepted:true, action:'render_card', cardId }`;任一步失败 → error JSON。
- **渲染位置 = 对话流内(D4,codex🟥5 决策)**:卡片带 `createdAt`,`MessageList` 把 `messages` 与 `cards` **按 createdAt 合并排序**渲染,卡片作为对话流中的产物按时间出现(不是 transcript 外的固定面板)。新组件 **`BrowserActionCard`**(单卡:title + markdown body + items 列表 + options 按钮)。
- **option 按钮交互(D5,codex🟥3+🟥4)**:
  - **busy 守卫**:读 `isBusyAtom`,run 进行中/等待时 option **禁用**(不无声中止当前 run)。
  - **带上下文发起**:点击 → `startAgentRun(store, ` `用户选择了卡片「{title}」中的选项:「{option}」` `)`——发**结构化自然语言**而非裸选项文本(因卡片不进 conversation history,模型否则看不到卡片标题/选项)。
- 样式进 `global.css`,复用现有变量/类名。

---

## §3 测试先行（最小集）

- **经 lazy-tool 两阶段**(mock adapter 先 request schema 再 render_card payload):产物入 atom、result `accepted:true`+cardId、**未** append assistant 消息(§1.5)。
- **accepted 严格**:正常 → accepted+cardId;**stale run**(起第二个 run 后旧 run 的 render_card)→ 不入 atom、不 accepted(codex🟥2)。
- **payload normalize**:缺 title / items 含空串/非字符串 / 未知 action → error JSON、atom 未变、不抛(不要求 timeline status 变 error,codex🟨)。
- **组件(visible)**:卡片真出现在 MessageList、按 createdAt 与消息混排;渲染 title/body(markdown)/items/options。
- **option 交互**:busy 时 option **disabled/点击无效**(codex🟥3);非 busy 点击 → `startAgentRun` 收到含卡片标题的结构化文本(codex🟥4)。
- ghost 守卫 + `deleteSession` 清理;现有 235 不回归。

---

## §4 决策

| ID | 决策 | 状态 |
|---|---|---|
| D1 | `browser_action` 只保留真实 `render_card`,移除三个空壳 action + 同步 skill/description | 已定 |
| D2 | 卡片不持久化(临时产物,与 save_file 一致);最终 assistant 文本仍概括关键内容 | 已定 |
| D3 | option 点击 = 发起新 run | 已定(细化见 D5) |
| D4 | 卡片渲染在**对话流内**(cards+messages 按 createdAt 合并排序),非 transcript 外面板 | 已定(消化 codex🟥5) |
| D5 | option 点击:① busy 时禁用;② 发**结构化文本**(含卡片标题+选项),不发裸选项 | 已定(消化 codex🟥3+🟥4) |

---

## §5 codex review
- 计划评审：✅ 完成(5🟥 消化)。实现：✅ 245 绿,codex 确认主路径(accepted 严格/stale 守卫位置)正确,2🟥+🟨 待收口。

## §6 实现返工(codex 评审后)
- BF1(🟥) stale-run 测试形同虚设(旧 run 太早 abort,没打到写卡片前的守卫)→ 用可控延迟让旧 run **拿到 render_card payload 后**再被 supersede,断言 result 非 accepted + atom 未变。
- BF2(🟥) 刷新丢内容:browser_action 成功 result **回显卡片内容**(title/items/options)+ 加引导"请在最终回复中概括卡片要点以便留存";mock 相应断言。(缓解 D2 不持久化 + §1.5 不 append 的次生丢失。)
- BF3(🟨) 移除 AskUserQuestion 路径残留的 `ensureToolLoaded(...,'browser_action')`(两处,旧"渲染问题卡片"链路)+ 同步 loop.test 与 docs/core-runtime-flow.md。
- BF4(🟨) normalize 测试补 unknown action / items·options 过滤(断言 error JSON、不入 atom、不抛)。
- BF5(🟨) MessageList 合并排序:同 createdAt 时 cards 全排在 messages 后(非真插入序)→ 给 message/card 都带单调 sequence 排序。
- BF6(🟨) option 结构化文本附 card body/items 摘要(泛化标题下上下文偏薄)。
- BF7(🟩) MessageList key 加 `card:`/`msg:` 前缀;测试变量 `sessionId`→`sessionIds`。
分支 `feat/browser-action-card`,收口 + 复审后合 main。

## §7 二轮收口(codex 复审后)
- BG1(🟥) mock 的 render_card loop 据 `toolResult.content` 区分:`accepted:true` 才说概括卡片,error 路径说失败/降级。**无 API key 时项目真用 mock,error 仍说"已渲染"=真假成功**,必修。
- BG2/BG3/BG4(🟨) 测试加强:补 unknown action→error 不入 atom;mock 记录并直接断言 result 回显 title/body/items/options/note;移除 `AskUserQuestionCard.test.tsx` fixture 里残留的 `browser_action`。
- BG5(🟨) option 摘要:items/options 也加上限(前 N 项 + 总字符截断),不只截 body。
- BG6(🟩) `types.ts` 的 seq fallback 注释与 MessageList 实际(index)对齐。
- **架构师分判(不做,记 backlog)**:codex🟥 要 BF2 硬闭环(loop 在最终 answer 缺卡片内容时追加"留存摘要")。卡片刷新丢是 **D2 既定取舍**(临时 UI 产物);软缓解(result 回显+note 引导)对真实模型够用;让 loop 干预最终消息会破坏"消息由模型产出"+增复杂度。→ 记 backlog,不在本阶段做。

---

_本文档由架构师维护。_
