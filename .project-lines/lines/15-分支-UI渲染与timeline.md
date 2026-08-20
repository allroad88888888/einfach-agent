# 线：UI 渲染与 timeline renderer
一句话：把 core 的会话状态投影成一串与 React 无关的 timeline item，再由 React root 私有的 registry 按 `kind` 查出组件渲染出来。
类型：分支线——挂在主线的 `packages/agent-core/src/timeline/timelineProjection.ts:projectTimelineItems`（运行时）与 `apps/web/src/agentNew/ui/webTimelineRendererRegistry.ts:createWebTimelineRendererRegistry`（编辑/配置时）

## 入口（一个实例从哪开始；引 file:line）
- `apps/web/src/main.tsx:92` —— `WebTimelineRendererRegistryProvider` 包在整个 App 外；registry 是**每个 React root 一份**（`WebTimelineRendererRegistryProvider.tsx:15` 用 `useState(createWebTimelineRendererRegistry)` 建一次）。
- `apps/web/src/agentNew/ui/webTimelineRendererRegistry.ts:17-24` —— 内建 renderer 表，六个 kind 在构造期写入并**锁定**。
- `apps/web/src/agentNew/ui/MessageList.tsx:59` —— 唯一的消费方：`useWebTimelineRendererRegistry()`。
- `apps/web/src/agentNew/ui/TimelineItemView.tsx:16` —— 查表点：`registry.resolve(item.kind)`。

## 数据怎么走（逐步；每步引 file:line）
1. **声明** —— `packages/agent-core/src/timeline/timelineProjection.ts:50-56` 定义 `TimelineItem` 六元联合；`timeline.ts:3-18` 是 `@einfach-agent/core/timeline` 子路径 barrel 的唯一出口（core 侧只有这 2 个文件）。
2. **产出（三条源）** ——
   · 会话条目：`state/sessionAtoms.ts` 的 `itemsAtom`（MessageList.tsx:51 读）；
   · 浏览器卡片：工具 `tools/interaction/src/browser-action/browser-action.ts:2` → `ctx.renderCard` → `runtime/toolContext/outputCapabilities.ts:25` `addBrowserCard` → `state/sessionTransientMutations.ts:63` 写 `browserCardsAtom`（声明在 `state/sessionTransientAtoms.ts:35`）；
   · 运行时注入事件：`state/sessionTransientMutations.ts:122` 写 `runtimeTranscriptEventsAtom`（`sessionTransientAtoms.ts:56`）。
3. **投影** —— `MessageList.tsx:70` 调 `projectTimelineItems`；`timelineProjection.ts:100-156` 按 role 拆条目（user→`message`；assistant 的 `reasoning_content`→`reasoning`、正文按有无 `tool_calls` 分 `message`/`thinking-message`、`tool_calls`→`tool-execution-group`；孤立 tool result 单独成组；**system 一律不渲染**，`:155-156`），`:180/:187` 追加 runtime-event 与 card，`:195` 按 `(createdAt, sortKey)` 排序。**投影是纯函数，不读 store**。
4. **分组与虚拟化（app 侧视图模型）** —— `messageTimelineViewModel.ts:41` 把连续的「思考类」item 并成 `thinking-group`（判据 `timelineProjection.ts:164` 的 `isTimelineThinkingItem`：reasoning / thinking-message / tool-execution-group / runtime-event 四种）；`:71` 插入已完成计划记录；`:104` 展开成虚拟行；`MessageList.tsx:106-118` 用 `useSlidingWindow` 切出可见段（窗口大小 80、步长 24，`messageWindowModel.ts:11-12`）。
5. **查表渲染** —— `MessageList.tsx:170/:176` 把每条交给 `TimelineItemView`；`TimelineItemView.tsx:16-19`：命中就 `<Renderer item={item} />`，未命中降级 `UnknownTimelineItem`（`packages/agent-react/src/UnknownTimelineItem.tsx:11-12`，只印 `kind` 文本，不解释 payload）。
6. **用户操作回到哪** —— 分两类：
   · **纯视图**：思考组展开/折叠 `MessageList.tsx:142` 直接 `setExpandedGroups`（`transcriptViewState.ts:9`，界面 store，不碰 core）；
   · **回到 core**：新的 timeline item 只由命令产生，入口是 `Composer.tsx:111` 的 `sendMessage(input)`；timeline **自身没有任何写回 core 的控件**（详见「漂移」）。

## 每部分负责什么 / 状态归谁 / 谁能调谁
| 部分 | 职责 | 持有的状态 | 谁可以调它 | 不许做 |
|---|---|---|---|---|
| `agent-core/src/timeline/`（2 文件） | 把会话状态投影成 renderer-neutral item | 无（纯函数） | 任何宿主（web / cli） | 依赖 React、读 store |
| `agent-react` registry（`timelineRendererRegistry.ts`） | kind → 组件查表，锁内建、防重复、给 disposer | `Map<kind, renderer>` + `lockedKinds`，root 私有 | React root、`installReactPlugins` | 存业务状态、发命令 |
| `webTimelineRendererRegistry.ts` | 声明 Web 的六个内建 renderer 并锁死 | 无 | 只被 `WebTimelineRendererRegistryProvider` 调 | 运行期改表 |
| `<Kind>TimelineRenderer.tsx` | 一个 kind 的薄适配：取 item 字段交给既有展示组件 | 无 | 只由 registry 解析出来调 | 读 atom、调命令 |
| `MessageList.tsx` | 组装：读会话 atom → 投影 → 分组 → 滑动窗口 → 查表 | 读 6 个会话 atom；写 2 个界面 atom | AppShell | 直接 setter 会话 atom、调 writer |
| `messageTimelineViewModel.ts` | 思考分组 / 计划记录插入 / 虚拟行 / 版本串 | 无（纯函数） | MessageList、测试 | 读 store |
| 界面 store（`apps/web/src/uiStore.ts:16`） | 装渲染态，全局唯一、不按会话分桶 | 展开折叠、滑动窗口、草稿、附件、设置/MCP/插件 | 环境 `<Provider>` | 装会话状态 |

## 形状（分支线：目录/文件形状 + 计数；必需 vs 可选）
- **renderer 成员 6 个 kind / 3 个文件**（git 跟踪）：`MessageTimelineRenderer.tsx`（message）、`BrowserCardTimelineRenderer.tsx`（card）、`ThinkingTimelineRenderers.tsx`（reasoning / thinking-message / tool-execution-group / runtime-event 四个导出）。**精确主形状 6/6**：每个 renderer 都只是 `{ item }` → 既有展示组件的薄适配，零状态、零命令。文件形状 2/3 是「一 kind 一文件」，1/3 是「四 kind 一文件」。
- **覆盖率 6/6，`UnknownTimelineItem` 在生产不可达**：`TimelineItem` 恰好六种（`timelineProjection.ts:50-56`），`builtInRenderers` 恰好登记六种。它只在测试里出现（`TimelineItemView.test.tsx:35,46`，含一条 XSS 归零用例 `:40-51`）。
- **插件注册的 renderer：0 个**。`installReactPlugins` 在 `apps/**` 无任何调用点（全仓只有 `packages/agent-plugin-example` 的测试与 docs 引用），且六个 kind 全被锁（`timelineRendererRegistry.ts:20-23` 写入 `lockedKinds`，`:43` 命中即抛）——今天任何 React 插件在 Web root 里**一个 kind 都注册不上**。这是蓝图明说的状态，不是漂移（见「文档与代码不一致处」）。
- **`apps/web/src/agentNew` 与 `agentNew/ui` 都是 127 个文件**——`agentNew/` 只有 ui 一个子目录，那层包装目前是空壳。127 = 66 源文件（53 `.tsx` + 13 `.ts`）+ 42 测试 + 19 CSS 分片（`agentnew.css:25-37` 是纯 `@import` 聚合器，顺序即级联，不可重排）。
- **66 个源文件按职责分七组**：时间线渲染管线 18 / 设置中心·MCP·插件·凭据·skills 17 / 输入区 9 / 骨架与会话作用域与工作区 7 / 卡片与状态条（ask-user·工具确认·工具进度·产物·撤销·上下文统计）6 / 子 Agent 视图 5 / 计划面板 4。
- **必需**：kind 进 `TimelineItem` 联合 → 组件签名 `{ item: TimelineItemFor<K> }` → 进 `builtInRenderers`。**可选**：独立文件（四合一有先例）、独立 CSS 分片、`timelineVirtualEntryVersion` 的版本分支。

## 样板（点名 1–2 个成员 + 为什么：奠基 / 最简 / 最近且干净）
- `apps/web/src/agentNew/ui/BrowserCardTimelineRenderer.tsx`（8 行）——**最简**。整个文件就是「导入 core 的 item 类型 + 把它交给既有卡片组件」，把这条线的形状压到了最小：renderer 不是新的 UI，是 kind 到既有 UI 的一层适配。
- `apps/web/src/agentNew/ui/webTimelineRendererRegistry.ts`（28 行）——**奠基**。整条线唯一的登记处；改这条线的绝大多数动作都以「这张表加一行」收尾。它和 `timelineRendererRegistry.ts` 各自只有 1–2 次 commit（`a2b8d97`/`66072f3`，均 2026-08-03），是仓库里最稳定的一块。

## 加一个（触碰文件；每项标来源：git 配方交集 / 汇合点代码 / 已有清单；不一致处写出）
> 注：git 里**没有第二次「加一个 kind」**——`timelineProjection.ts` 只有 1 次实质提交（`846743a`），`webTimelineRendererRegistry.ts` 只有 1 次（`66072f3`），六个 kind 同批出生。所以下表以**汇合点代码**为主，git 只提供奠基三连的文件集。
- `packages/agent-core/src/timeline/timelineProjection.ts`——来源：git 配方（`846743a`）+ 汇合点代码。加 `TimelineXxxItem` 接口、并进 `TimelineItem` 联合（`:50`）、在 `projectTimelineItems`（`:174`）里产出、并裁决要不要进 `isTimelineThinkingItem`（`:164`）。
- `packages/agent-core/src/timeline.ts`——来源：汇合点代码（`:3-18`）。不导出新类型，app 侧写不出 renderer 的 props。
- 产出侧（二选一）——来源：汇合点代码。走会话条目就不用加 atom；走瞬态就要 `state/sessionTransientAtoms.ts` 加 atom + `state/sessionTransientMutations.ts` 加 writer，并在 `scripts/state-invariants/atomDispositionTable.js` 登记归宿（**不登记 = `pnpm check:state` 红**）。
- `apps/web/src/agentNew/ui/<Kind>TimelineRenderer.tsx`——来源：git 配方（`66072f3` 一次加了三个）。
- `apps/web/src/agentNew/ui/webTimelineRendererRegistry.ts:17-24`——来源：汇合点代码。**这一步漏了不会编译报错**：`BuiltInTimelineRenderers` 是 `Partial<TimelineRendererMap>`（`timelineRendererTypes.ts:18`），漏登记的后果是运行期弹出英文 `Unsupported timeline item: <kind>`。
- `apps/web/src/agentNew/ui/MessageList.tsx`——来源：汇合点代码。只有新 kind 需要新的投影输入源时才动（`:70-80` 的 `projectTimelineItems({...})` 参数）。
- `apps/web/src/agentNew/ui/messageTimelineViewModel.ts:129-149`——来源：汇合点代码。`timelineVirtualEntryVersion` 有一张**逐 kind 的 switch**：新增**非思考类** kind 时，`:147` 的 `entry.conversationItem` 会因类型收窄失败而**编译报错**（这是好事，`pnpm build` 挡得住）；新增**思考类** kind 则会静默落到 `:143` 的 `return entry.sortKey`，流式更新时滑动窗口不跟随到底。
- `apps/web/src/agentNew/ui/agentnew.<域>.css` + `agentnew.css` 的 `@import` 行——来源：已有清单（`agentnew.css:14-23` 写明顺序即级联）。
- 测试——来源：git 配方。`66072f3` 与渲染同批加了 `TimelineItemView.test.tsx` / `WebTimelineRendererRegistryProvider.test.tsx`；这条线现有 13 个相关测试文件（ui 下 10 + core 1 + agent-react 2）。

## 三层 store 在 UI 侧的实际绑定点
- **界面 store**：`main.tsx:75` `<Provider store={uiStore}>`，全局只此一处；`uiStore.ts:16` 就是 `createStore()`。
- **core 的 root store**：`main.tsx:76` `<RootStoreProvider store={core.rootStore}>`；读用 `useRootAtomValue`，全仓 **14 处**（ActiveSessionProvider 3、ProjectSkillsPanel 4、SessionList 2、WorkspaceRootField 1、WorkspaceSidebar 4）。
- **per-session agent store**：`ActiveSessionProvider.tsx:56` `<AgentStoreProvider store={sessionAtomScope(id)} key={id}>`；读用 `useAgentAtomValue`，全仓 **34 处**。两个 hook 都在 `packages/agent-react/src/coreStoreBindings.tsx:57/:62`，且**刻意不配 setter**（`:16-18`）。
- **裸 hook 自查（不只信门禁）**：全仓非测试的裸 `useAtomValue`/`useAtom`/`useSetAtom` 调用点 **77 处**。其中 2 处是 `coreStoreBindings.tsx:58/:63` 自身的实现（合规），69 处读的是界面 store 自己的 atom（`apps/web/src/{mcp,settings,plugins}/state`、`traceViewer/traceViewerState`、`agentNew/ui/*State.ts`、`demos/windowScrollModel`——合规）。**剩下 6 处是漏网，分布在 2 个文件**，见「漂移」#1、#2。`node scripts/check-state-invariants.js` 此刻**是绿的**——两处都落在规则 5 的判据盲区里。

## 切会话时被清掉的界面状态
- 清理点：`ActiveSessionProvider.tsx:47` 的 `useEffect([id, uiStore])` → `sessionScopedViewState.ts:19-28` `resetSessionScopedViewState(store)`。**恰好 4 个 atom**：
  1. `composerDraftAtom`（`composerDraftState.ts:15`）→ 置 `''`；
  2. `composerImageAttachmentAtom`（`composerImageAttachmentState.ts`）→ 手写 `{images: [], operation: 'idle', revision: prev.revision + 1}`，**刻意不复用** `clearComposerImageAttachmentsAtom`（那条在 `operation !== 'idle'` 时拒绝清空，而切会话必须无条件清；`revision` 仍 +1，好让在飞的准备/提交按版本号作废，`sessionScopedViewState.ts:21-26`）；
  3. `messageWindowAtom`（`messageWindowModel.ts:20`）→ `EMPTY_MESSAGE_WINDOW`；
  4. `planTraceWindowsAtom`（`messageWindowModel.ts:21`）→ `{}`。
- **刻意不清**：`expandedTranscriptGroupsAtom`（`transcriptViewState.ts:9`）与 `planViewState.ts:10-16` 的三个展开态——它们按 group/stage id 索引，换会话自然查不到旧 key（`sessionScopedViewState.ts:4-5` 写明）；设置/MCP/插件/`workspaceRenameStateAtom` 本来就是全局的。
- **漏清的症状**：界面 store 不按会话分桶，所以漏清一项＝在会话 A 打了一半的字/挂上的图跟着切到 B，点发送就发进错的会话（`sessionScopedViewState.ts:7-8`）。窗口那两项漏清只是滚动位置错乱（`resolveMessageWindow` 会按总条数夹回，`messageWindowModel.ts:33-53`）。刻意不做 sessionId 分桶的 atom family：那等于把「每会话一个 store」换个写法再做一遍（`:10-11`）。

## 标准之外
### 另一类（同目录、不同机制）
- `PlanStageExecutionTrace.tsx:44` + `PlanPanel.tsx:59/:77`——**第二个投影消费方**，用 `projectPlanStageTimelineItems`（`timelineProjection.ts:201`）拿按阶段分组的思考项，然后**直接** `<ThinkingStep entry={entry} />`，绕开 `TimelineItemView` 和 registry。同一份投影、两套分派。
- `ThoughtTraceEntries.tsx:185-214`——四个思考 renderer 在 registry 里各占一格，但全部转交同一个 `ThinkingStep`，它内部**再按 `entry.kind` switch 一遍**（`:186/:194/:205`）。registry 对这四种今天是纯转发。
- `SubagentRunInline.tsx:252`——从 `ThoughtTraceEntries.tsx:214` 的 `delegate_agent` 工具调用里挂进来，读 `subagentTreesAtom`（用对了 `useAgentAtomValue`）。是嵌在 timeline 里的**只读**子树视图，不经 registry。
- 17 个设置/MCP/插件/凭据文件——机制完全不同（读界面 store 自有 atom + 调模块级单例命令），只是同住 `agentNew/ui/`。

### 漂移 / 遗留（少、晚、不合形状——引用并说明；是「别模仿」不是「删」）
1. **`UndoBar.tsx:24` 读错 store，撤销条在生产里永远不显示。** 它用裸 `useAtomValue`（`:14` 从 `@einfach/react` 导入）读 `sessionUndoAvailabilityAtom(sessionId)`。该 atom 由 `runtime/commands/sessionScopeCommands.ts:36-38` 交出，本体是 `state/sessionHistory.ts:61-74` 的派生 atom，依赖 `history.stackAtom`、`runAtom`、`undoBarrierTxIdAtom` **全是会话 atom**。裸 hook 读的是环境 store＝界面 store（`main.tsx:75`），三个依赖全取默认值（`@einfach/core` 0.4.0 的 `stackBackingAtom` 初值 `{entries: [], cursor: 0}`）→ `canUndo/canRedo` 恒 false、`blocked` 恒空 → `:30` 直接 `return null`。**这正是规则 5 存在的那种静默失败**，而门禁看不见：`agentStoreBinding.js:63` 只认「标识符本身在 atom 枚举面里」，这里是个**工厂函数**。测试也看不见：`UndoBar.test.tsx:20` 把会话 store 当环境 store 传（`renderWithStore(..., { store: sessionAtomScope(id) })`），恰好是 `renderWithStore.tsx:19-20` 警告过的那种退化。
2. **`SubagentSkillGovernancePanel.tsx:36-40` 读写分居两个 store。** 五个 atom 用裸 `useAtomValue` 读（落界面 store），而 `:44-46/:53/:60` 调的命令经 `runtime/commands/subagentViewCommands.ts:20-23` 的 `activeSessionStore(core)` 把值写进**会话 store**（`packages/subagents/src/state/subagentCommandFacade.ts:27-29`）。症状：候选列表恒停在 `status:'idle'` 的加载文案，筛选输入框是个改不动的受控框。门禁看不见的原因不同：这些 atom 从 `@einfach-agent/subagents` 导入，而规则 5 只认 `@einfach-agent/core`（`agentStoreBinding.js:32`）。**血量为零**——`SubagentTreePanel`（唯一挂载它的地方，`:111`）全仓没有任何挂载点，见 #3。
3. **`SubagentTreePanel.tsx:274` 没有被任何组件挂载**（全仓只剩自引用、core 的注释与 docs）。280 行 + 5 个子 Agent 视图文件目前不在渲染树上。
4. **「按条回退」的残骸。** `MessageTimelineRenderer.tsx:1` 说「回退按钮由列表 shell 组合」、`MessageList.tsx:6` 说「用户消息的回退入口只调用命令」，但 `MessageList.tsx` 全文 204 行没有这个按钮；`agentnew.css:8` 的类名清单里还留着 `.agentnew-message-revert`，CSS 规则也还在（`agentnew.subagent-trace.css:407/:423/:428`），无人使用。UI 里今天唯一的回退是**阶段级**的 `PlanPanel.tsx:184` `rollbackPlanStage`。
5. **`messageWindowModel.ts:22` 的注释过期**：说 `messageElapsedClockAtom`「值保存在会话 Provider 对应的 Einfach store」。界面 store 拆出去之后它住界面 store，`RunDurationStatus.tsx:30` 读写同一层，行为正确，只是注释指错了地方。
6. **`UnknownTimelineItem.tsx:12` 的文案是英文**（`Unsupported timeline item: {kind}`），而 CLAUDE.md 要求用户可见文案中文。今天不可达，但它是「加 kind 忘登记 renderer」时唯一会露面的东西。

### 待确认（≤5；只问改变新代码去向的；点名成员；每条两种解释）
1. **规则 5 的判据要不要跟着扩**（`scripts/state-invariants/agentStoreBinding.js:32,63`；触发者 `UndoBar.tsx:24`、`SubagentSkillGovernancePanel.tsx:36-40`）：A 只就地修这 2 个文件，判据维持「`@einfach-agent/core` 直接导入的标识符」——那么以后新写的组件仍然可以从 `@einfach-agent/subagents` 或 atom 工厂那儿静默漏过去；B 判据扩到「返回 `Atom` 的 core 工厂 + `@einfach-agent/subagents` 的会话 atom」，代价是要给枚举面再开一张表。答案决定下一处同类问题是写在组件里还是写在门禁里。
2. **`SubagentTreePanel` 及其 5 个文件是删还是接线**（`SubagentTreePanel.tsx:274`）：A 是待接线的功能，那 #2 的 store 漏网必须先修、且新的子 Agent 视图工作继续加在这里；B 是已被 `SubagentRunInline` 取代的遗留，那就该删，新工作一律加在 timeline 内联那条路上。
3. **新 kind 默认锁不锁**（`webTimelineRendererRegistry.ts:17-24` 对六个 kind 全部 lock；`docs/plugin-renderer-protocol-blueprint.md:113` 记录了这一状态、`:3` 说 R5 待实施）：A 继续「新 kind 一律进 `builtInRenderers` 并锁死」，插件面等 R5 整体设计；B 从下一个 kind 起留一格不锁，让 `installReactPlugins` 先有一个真实调用点。答案决定新 renderer 是写死在表里还是走插件安装面。
4. **计划阶段轨迹要不要收编进 registry**（`PlanStageExecutionTrace.tsx:44` 直接用 `ThinkingStep`）：A 保持两套分派，理由是阶段轨迹只吃思考四种、没有替换需求——那么新增思考类 kind 要**改两处**；B 改成 `TimelineItemView`，一次分派到底。答案决定「加一种思考类 renderer」的配方是 1 步还是 2 步。

## 文档与代码不一致处
- `CLAUDE.md`「状态与 UI 边界」说「core 之外读 core 的 atom 必须经 `useRootAtomValue`/`useAgentAtomValue`」；代码里有 6 处例外，分布在 `UndoBar.tsx:24` 与 `SubagentSkillGovernancePanel.tsx:36-40`，且 `pnpm check:state` 当前为绿。
- `CLAUDE.md` 说「界面 store 装……消息滑动窗口、展开折叠、输入框草稿与图片附件」——与代码一致（`messageWindowModel.ts:20-21`、`transcriptViewState.ts:9`、`planViewState.ts:10-16`、`composerDraftState.ts:15`）；但它没提「切会话只清 4 项」这条，实际清单在 `sessionScopedViewState.ts:19-28`。
- `docs/plugin-renderer-protocol-blueprint.md:113` 明说「当前 Web App 已锁定全部六个内建 kind，不能以此覆盖其视觉」，`:3` 标 R5 待实施——所以「插件注册不上任何 renderer」是**文档说到做到**，不是漂移；但 `docs/plugin-ecosystem-blueprint.md:36` 的一句「只能由 React root 在源码里 `installReactPlugins`」容易读成已有调用点，实际 `apps/**` 里一个都没有。
- `apps/web/src/agentNew/ui/agentnew.css:8` 的类名对照表把 `.agentnew-message-revert` 列为 MessageList 的类；MessageList 已无此元素。
- `apps/web/src/agentNew/ui/messageWindowModel.ts:22` 说时钟 atom 住会话 store；实际住界面 store。

## 证据核过：commit `1ebe4a0`，2026-08-20；本次打开文件数：34

## 裁决（2026-08-20，dol）

- #1 → **扩判据**（questions A4）——见 01 线同条。
- #2 → **删**（questions D2）——`SubagentTreePanel` 及其 5 个文件删掉；子 Agent 视图工作一律加在 timeline 内联那条路上。
- #3 → **留一格不锁**（questions A11）——从下一个 kind 起留一格不锁，让 `installReactPlugins` 先有一个真实调用点。
- #4 → **合并**（questions B8）——`PlanStageExecutionTrace.tsx:44` 改走 `TimelineItemView`，一次分派到底；加一种思考类 renderer 从此是 1 步。
- 另：`UndoBar` 修（questions A3，见 01 线 #1）。
- **方向裁决（全仓，questions B2 / 本轮追认）**：agent 循环目标跑在**服务端**，前端纯展示，
  tools 与 mcp 的逻辑都在后端。本线正文描述的是**当前**形态，不是目标形态——目标形态下本线**变重而不是变轻**：前端纯展示意味着渲染层是前端唯一的职责，投影从后端经事件流过来，registry 与组件形状不变。
