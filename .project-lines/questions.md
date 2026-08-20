# 待负责人裁决的问题（11 条线去重后 31 条）

> **怎么答**：每条先看 `▸ 人话` 那两三行——那是给人读的，够你做决定了。下面的 `file:line` 是给
> agent 用的证据，不用读。在「答：」后写 **A / B / 都有 / 就这样 / 遗留 / 不知道**，或直接写自由
> 文本（自由文本最好用，通常一句话同时说清现状和方向）。
>
> 「就这样」= 有意设计，写进线文件成为权威。「遗留」= 别模仿，不一定删。「不知道」= 不是我定的，
> agent 按多数做法处理、遇到再提醒。括号里是出处（线编号-该线问题序号）。
>
> **只有 10 分钟就答 A1–A5**。D 组 5 条只答「留 / 删 / 不知道」，30 秒。E 组不用答，是待修清单。

## A. 机制层（新代码按谁的做法来）

> A5 / A6 未闭合，已移到文末「未决区」。

**A1. 那套压缩插件是删掉，还是留着当备选**（00-1, 11-1）
> ▸ 人话：压缩上下文的插件还在仓库里躺着，但**已经没人调用它了**——真正干活的是主循环里另写的一段
> 内联代码。8 月 11 号那次改动把它从默认插件表里摘了出来，然后没人回来收尾。现在要定：这 6 个文件
> 1648 行是清掉，还是留着当「想用的人自己装回去」的备选？留着的话，它顺带还是「一个插件能有多大」
> 的样板。
证据：`runtime/core/plugins/compactionPlugin.ts:479`；`defaultPlugins.ts:7-11` 已无它；移出于 `d1e1c33`。
A 删（新插件别拿它当形状参考）　B 留作可选实现（`transformContext` 扩展点也跟着还活着）
答：A

**A2. 两个没人触发的时机，还算不算数**（00-2, 11-2）
> ▸ 人话：工具可以挂在「某个时刻自动跑」的钩子上，一共九个时刻。其中「压缩前/压缩后」这两个的
> 触发方就是 A1 那个没人装的插件——所以生产里它们**永远不会响**，实际只有 7 个时刻是活的。要定：
> 是给这两个补一条新的触发路径（接到现在真跑的那段蒸馏上），还是干脆承认只有 7 个、以后不许往这两个
> 上挂工具。
证据：`tools/toolCallTiming.ts:12-22`；`modelTurnRequester.ts:153` 是空调用。
A 补触发路径，保住九个　B 收缩到 7 个，禁止新挂
答：A

**A3. 撤销条是修还是删**（01-1, 15-1）
> ▸ 人话：界面上那个「撤销」条**从来没显示过**，因为它读状态读错了地方，永远读到空值，于是每次都
> 直接不渲染。要定：是修好让它真的能用，还是承认撤销功能本来就不打算给用户看、把这个组件摘掉。
> 留着不修是最差的——一个永远不出现的组件会让下一个人以为功能存在。
证据：`agentNew/ui/UndoBar.tsx:24` 裸 `useAtomValue` 读会话 atom 工厂 → `:30` 恒 `return null`。
A 修（改用 `useAgentAtomValue`，测试也要改传 `agentStore`）　B 删（从 `AppShell.tsx:51` 摘掉）
答：A

**A4. 门禁要不要扩大搜查范围**（01-2, 15-1）
> ▸ 人话：有条门禁专门抓「组件从错误的地方读状态」这种错，但 A3 那个 bug 它没抓到——因为它只认
> 「直接写出来的名字」，而出错的那行是个函数调用。另一个同类漏网也已经找到。要定：是就地修这两处、
> 门禁维持现状（以后同样的错还会漏），还是把门禁的判据加宽（代价是要再维护一张表）。
证据：`scripts/state-invariants/agentStoreBinding.js:32,63`；漏网二 `SubagentSkillGovernancePanel.tsx:36-40`。
A 只修文件，门禁不动　B 门禁扩到「atom 工厂 + subagents 包」
答：B

**A7. MCP 造出来的工具要不要盖「外部」戳**（10-4）
> ▸ 人话：从外部 MCP 服务器拉进来的工具，代码里有个「这是外部来的」的标记位，但 MCP 这条路**没打这个
> 标记**。那个标记会触发一层保护（剥掉外部工具不该有的能力）。要定：不打是有意的（MCP 结构上不可能
> 带那个能力，标记是留给以后别的第三方注册面的），还是漏了（那层保护现在对 MCP 恒不生效）。
证据：`tools/mcp/src/toolAdapter.ts:388-403` 未打；`tools/toolRegistry.ts:71-77` 只对打标的生效。
A 有意，新的动态提供方也不必打　B 漏了，必须补
答：B

**A8. 模型不可用时自动换档，为什么只有子 Agent 有**（17-5）
> ▸ 人话：子 agent 遇到「模型资源不足」会自动换一个模型继续跑；主 agent 遇到同一个错直接报错停下。
> 要定：这是有意的不对称（替用户换模型是越权，主流程必须显式失败），还是欠债（同一个错在两条路上
> 语义不该不同）。
证据：`subagents/modelSelection.ts:138-179` 有升档；`runToolLoop.ts:160-165` 直接 error。
A 有意不对称　B 欠债，该提到共用层
答：B

**A9. 子 Agent 的模型档位表要不要认厂商**（13-4）
> ▸ 人话：给子 agent 选模型的那张表只按 deepseek 写的。用 GLM 或 Kimi 开会话时，子 agent 拿不到便宜
> 快模型，只能用跟父 agent 一样的模型跑。代码里给的理由是「跨厂商换档保不住会话参数」。要定：这个
> 理由成立、单表就够，还是该按厂商各配一张。
证据：`packages/subagents/src/defaultTierRouting.ts:12`；论证见 `tierRouting.ts:13-17`。
A 单表够用　B 按 vendor 选表
答：B

**A10. 两张手工对齐的错误分类表，靠什么保证不漏**（16-3）
> ▸ 人话：MCP 连接失败的原因分类，在后端和前端各有一张表，靠人记得「改一边要改另一边」。漏了的
> 后果不严重（会落到「暂时失败」这个安全默认），但会一直重连一个永远起不来的服务。要定：靠纪律，
> 还是加一条锁定测试。
证据：`tools/mcp/src/failureClassification.ts:97-113` ↔ `packages/host-node/src/mcp/errors.ts`。
A 靠纪律（默认值是安全侧）　B 加锁定测试
答：应该保留后端，前端是可以移除

**A11. 以后新的消息类型，默认锁死还是留口子**（15-3）
> ▸ 人话：界面上每种消息（思考、工具调用、计划……）由一张表决定怎么画，现在 6 种全部**锁死**，插件
> 改不了。而那套「让插件注册画法」的代码写好了但一个调用点都没有。要定：继续全锁（插件面等整体
> 设计），还是从下一种开始留一格不锁、让那套代码先有个真实用户。
证据：`webTimelineRendererRegistry.ts:17-24` 全 lock；`installReactPlugins` 在 `apps/**` 零调用点。
A 继续全锁　B 留一格不锁
答：B

## B. 边界（新东西放哪）

> B1 / B6 未闭合，已移到文末「未决区」。

**B2. 新的「按宿主分情况」的代码写在哪**（02-2）
> ▸ 人话：判断「现在是有后端还是纯静态」然后分头装配的地方一共 9 处，6 处集中在 `host/` 目录，
> 另外 3 处散在各自的特性目录里。要定：集中派（新的一律进 `host/`），还是就近派（特性自己的分流留在
> 自己家，照 mcp 那样写）。
证据：散的三处 `mcp/initialize.ts:73`、`mcp/toolNameCacheStorage.ts:175`、`plugins/initialize.ts:83`。
A 就近（`host/` 只放 core 装配面）　B 集中（一律进 `host/`）
答：没明白， 前端纯展示，所有agent相关逻辑都应该在后端，不管是tools 还是mcp

**B3. skill 清单该在哪儿告诉模型**（17-2, 00 线独立印证）
> ▸ 人话：告诉模型「有哪些 skill 可用」的那份清单，以前放在每次请求最前面的固定区（能被缓存），
> 现在已经改成「会话开始时作为一条消息发出去」。但两份设计文档和一处代码注释都还写着旧做法。要定：
> 迁移已完成、改文档就行，还是这只是过渡态、以后要迁回去（那现在往这条路上加东西就是在攒返工）。
证据：`skill-manifest.ts:17` 到点工具产出；`modelTurnPrefix.test.ts:38` 断言前缀不再调它；迁于 `a88ba16`。
A 迁移已完成，改文档　B 过渡态，还要迁回
答：不还是要放到请求的固定去，会话开始作为消息发过去，只是告诉agent 有这些skills，最终还是要放到请求的固定位

**B4. `openai-compat` 算第四家厂商，还是逃生口**（17-1）
> ▸ 人话：模型厂商注册了 4 家，但文档一直说 3 家——第 4 家是「兼容 OpenAI 接口的自建网关」，而且它
> **只有 CLI 能用**，浏览器那条受限传输和设置面板里都没有它。要定：它是正式第四家（那 web 侧该补上，
> 「加一家厂商」的清单是 6 处），还是故意只给 CLI 的逃生口（受限传输的价值就在于白名单，放开就没了）。
证据：`builtinProviders.ts:216-219` 有它；`providerTransport.ts:28-31`、`settings/modelCredentialHost.ts:4-6` 没有。
A 正式第四家　B 故意的逃生口
答：A

**B5. 同一个类型定义了两份，是有意还是漂移**（16-2）
> ▸ 人话：「MCP 用哪种传输方式」这个类型，域包里一份、应用层里一份。加第三种传输时必须两处都改，
> 漏一处的症状是「配置存得下、就是连不上」。要定：有意分开（应用层的存储类型不该依赖域包），
> 还是漂移（该加条比对测试）。
证据：`tools/mcp/src/types.ts:27` ↔ `apps/web/src/mcp/types.ts:4`。
A 有意分开　B 漂移，加比对测试
答：应该统一成一份 后端的

**B7. 握手接口加字段时，两份常量抄两遍还是抽个包**（02-4）
> ▸ 人话：前后端握手用的那份常量，客户端存了一份副本，靠一条「逐字对拍」的测试保证两边一样。
> 文件头自己写了「到第四个常量就该抽共享包」。要定：继续抄两遍，还是现在就抽包（要新增包 + 改两处
> 别名配置 + 过边界门禁）。
证据：`apps/web/src/host/serverHealthContract.ts:16`。
A 继续副本+对拍　B 抽共享包
答：B

**B8. 计划轨迹要不要并回主渲染表**（15-4）
> ▸ 人话：计划阶段的思考轨迹自己单独分派了一遍渲染，绕开了那张主表。后果是以后加一种思考类消息
> 要改两处。要定：保持两套（阶段轨迹只吃固定四种、没有替换需求），还是合并成一处。
证据：`PlanStageExecutionTrace.tsx:44` 直接用 `ThinkingStep`。
A 保持两套　B 合并
答：B

## C. 声明 / 标签的地位（新成员该声明什么）

**C1. 计划域那三个工具没有自己的测试**（10-1）
> ▸ 人话：其它工具都是「一个目录 = 实现 + 说明 + 测试」，计划那三个只有一条域级测试兜着。
> 要定：这是欠债（新工具一律补），还是对的粒度（计划工具是薄壳，域级不变量才是该测的东西）。
证据：`tools/planning/src/{create,execute,update}-plan/`；域级 `planToolDurability.test.ts:4-7`。
A 欠债，都要补　B 粒度就该这样
答：A

**C2. 自动触发的工具要不要写 `.md` 说明**（10-2）
> ▸ 人话：`.md` 是给模型看的工具说明，但自动触发的工具永远不会被模型主动调用，所以那份说明发不出去。
> 要定：不写（内联一句注释即可），还是照写（`.md` 同时也是给人读的）。
证据：`tools/skills/src/skill-manifest/skill-manifest.ts:20` 没写。
A 不写　B 照写
答：照写吧

**C3. 加工具要不要顺手改那句计数注释**（10-3）
> ▸ 人话：聚合包顶上写着「6 域 31 工具」，真正的权威清单在测试里。要定：计数注释是会过期的装饰
> （只改测试），还是它算对外说明（两处都改）。
证据：`tools/standard/src/index.ts:4,6,30` ↔ `index.test.ts:12-41`。
A 只改测试　B 两处都改
答：B

**C4. 新门禁默认要不要带自测**（14-1）
> ▸ 人话：5 条门禁里只有 1 条有自己的 fixture 测试。要定：这是欠债（下一条必须带），还是只有
> 「判据是逐行正则、容易写错」的那类才需要（真跑产物的那两条自己就是端到端实验，再套一层是空转）。
证据：`scripts/check-boundaries.test.js` 14 条用例，另 4 条门禁无自测。
A 一律要带　B 看类型
答：A

**C5. 厂商共形测试要不要覆盖到 4 家**（17-3）
> ▸ 人话：三份「四家行为应当一致」的测试只跑了 2 家。要定：有意（kimi 换的是整套编码、
> openai-compat 本来就不做特化），还是加新厂商时忘了扩。
证据：三份 `*.characterization.test.ts` 的 `PROVIDERS` 数组。
A 有意只覆盖 2 家　B 忘了扩
答：B

**C6. skill 清单的总条数上限有没有人算过**（17-4）
> ▸ 人话：项目级 32 条、用户级 32 条、内置 5 条，加起来 69 条全都会进模型上下文。32 这个数是按
> 「一个扫描范围」定的。要定：69 可接受（内置不占预算是有意的），还是这是没人算过的合成数、
> 再加第三个范围时该定的是**总**预算。
证据：`registry.ts:113-116` + `projectSkillsSnapshot.ts:20`。
A 有意，可接受　B 该定总预算
答：都不是——**上限改成 100**（已改，含 `MAX_DISABLED_SKILLS_PER_WORKSPACE` 一起）。进清单的只有
description，塞得下；「这个 skill 在这个项目用不用得上」是用户的事，该由启停偏好管，不该由一个按
字节序截断的常量替他做。启停机制与设置面板**已存在**（`projectSkillPreferences.ts` +
`ProjectSkillsPanel.tsx`），不需要新做。A 

**C7. `pnpm subagent:capacity` 是治理命令还是测试**（13-5）
> ▸ 人话：五条子 agent 治理命令里，这一条实际上只是跑了个单元测试，另外四条都是能对真实归档目录跑的
> 脚本。要定：它就是条测试（名字归类错了），还是该补个真脚本。
证据：`package.json:19` = `vitest run archiveCapacity.test.ts`。
A 就是测试　B 该补脚本
答：干掉它

## D. 遗留候选（只答：留 / 删 / 不知道）

> 第 4 条（`dist/` 扫描面）答「不知道」，已移到文末「未决区」。

1. `delegate_agent` 里那条「同步等结果」的老分支——已被新的「立刻返回句柄」全覆盖。删的话，
   `ToolContext.delegateAgents` 这条对外能力一起收。（`tools/agents/src/delegate-agent/delegate-agent.ts:167`）答：删
2. `SubagentTreePanel` 那一组 5 个文件——**全仓没有任何地方挂载它**，疑似已被内联那版取代。
   （`SubagentTreePanel.tsx:274`）答：删
3. `hostRecoveryFlush.ts` 这个「分情况」的壳子——里面只剩一种情况了。留着是为了跟另外四个装配面
   对称。（`apps/web/src/host/hostRecoveryFlush.ts:15`）答：删
5. 发布流水线里手抄了一遍冒烟测试，比正式脚本少三条判据。那条流水线是休眠的（包都是私有的，
   触发条件永远不成立）。（`.github/workflows/release-npm.yml:169`）答：留

## E. 文档与代码不一致——不用答，只需修

**CLAUDE.md**（这 5 条我逐条 grep 复核过当前文本）：
- `:125` 写「DeepSeek/GLM/Kimi」三家 → 实际 4 家，还注册了 `openai-compat`（`builtinProviders.ts:216-219`）。
- `:291` 写「压缩…是插件」→ 已于 `d1e1c33` 移出默认插件表，真跑的是 `modelTurnRequester.ts:85-128` 的内联蒸馏。
- `:304-305` 写库文件「与 CLI 共用同一份」→ CLI 从不调 `configurePersistence`（只有 `runtime.ts:9` 的悬空 import）。
- `:311` 写「能看见 `pnpm serve` / CLI 写下的 trace」→ CLI 的 trace 只在 `--verbose` 时打 stderr（`runtime.ts:43-58`）。
- `:352` 写「adapter 除 AbortError 外返回 fallback、不向 UI 抛出」→ 契约成立，但兜底在 `runToolLoop.ts:151-166`；adapter 一律抛。

**代码注释**：
- `modelTurnSystemItems.ts:9-13` 说 skill 清单「与固定 system 同区进稳定前缀」→ 见 B3。
- `loopHooks.ts:7-11` 说只有一个槽接线（实为 7/7）、`:171` 说 schema 校验挂 `beforeToolCall`；4 个插件的头注释仍指已拆分的 `modelRun.ts`。
- `sessionAtomSource.js:16-19` 的注释论据已被 UI store 拆分作废；`historyCommands.ts:99` 拿已不存在的「草稿」举例。
- **Tauri 残留注释群**（桌面壳已于 `e52c31d` 删除）：`persistence-sqlite` / `observability-sqlite` 多处
  「桌面壳注入 Tauri SQL 插件」、MCP 侧 12 个文件仍以已删的 `tauriStdioConnector.ts` 为对照系、
  `apps/server` 的 `health.ts:30/34` 还写三态含 tauri、`turnToolVisibility.ts:41-53` 记的窗口已随 `6a5e9ef` 闭合、
  多个工具域注释仍写「依赖 Tauri」（真实判据是 `hasHostBridge()`）。

**docs/**：
- `core-runtime-flow.md:52` checkpoint 时点画错；`:105` 状态名 `awaiting_approval` 实为 `waiting_plan_approval`。
- `tree-subagent-runtime.md:144` 说父 agent 收到 `BatchResult` → 实际是句柄。
- `mcp-integration.md` 说 manifest/guide 会列工具名 → 两层都已不列。
- `project-skills-blueprint.md` 引用的 `ensureProjectSkills` 已不存在。
- `TOOLS-SPEC.md` 4 处：注册点写成 standard、31 的口径、skills 域少列一个、Tauri 措辞。
- `assembly-core-issues.md` 已删除，但仍在「加一套 driver」的 git 配方里。

**已撤回的两条误报**（追线时报为「文档过时」，我复核后不成立——过时的是我发给追线 agent 的
CLAUDE.md 引文，那是会话开头的缓存版本）：
- 「CLAUDE.md 仍写 Web=IndexedDB / Tauri=SQLite」→ 当前 `:300-311` 已是 server/static 两态。
- 「CLAUDE.md 仍写 server 工具在非 Tauri 环境不暴露」→ 当前文本已无此句。

---

# 未决区（5 条已于 2026-08-20 闭合，余 6 条）

> 五条「你答了但没落定」的已全部闭合，裁决就地折回（见各条的 **你的裁决**）；
> 由它们长出的三张新卡 F1 / F2 / F3 已进 `docs/project-lines-verdicts-issues.md`。
> 下面第二节那 6 条仍是我合并时没上会的，等你要不要捡回来。

> 上面 A–E 组里已闭合的都留在原位、答案原样保留。这一区是**还没闭合**的全部内容：
> 5 条你答了但没落定的，加 6 条我在合并时判断「不改变新代码去向」而**没有上会**的。

## 一、你答了但还没闭合（5 条）

**A5. 子 Agent 的「续跑」是做完了还是做一半**（13-1, 13-2）
> ▸ 人话：子 agent 派出去之后如果崩了/刷新了，本来设计了一套「回来接着跑」的机制。现在的实际情况
> 是：记录写下去了，但读回来的那一半只做了「这会话派过子 agent，别自动恢复」这么一句判断，设计里
> 那两种细分处理**一个都没接**，而且记录永远不删。要定：这就是终态（那两个细分是过度设计），还是
> 半成品（该补完）。
证据：`subagents/continuationDescriptorParser.ts:10` 零消费方；`runtime/commands/recoveryCommands.ts:60`。
A 终态，别往上接　B 半成品，先补消费方再补清除
答：子agent 的状态，不还是atom的，状态都在，子agent崩溃了，恢复就是，只怕一直死循环，能输出原因，关闭子agent ，然后重新开一个么

> **我的追问**：你的意思我读作「那两个 disposition 是过度设计、别再往上接（≈A）；真正要的是
> 死循环时能看到原因、能关掉这个子 agent 再重开一个」。**这个解读对不对？** 另外「关掉再重开」
> 现在到底有没有，我还没核实过——你要的话我去查一遍再决定开不开卡。
**你的裁决**：你去核实，然后开 issue 任务树。
> **核实结果（2026-08-20）**：「关掉再重开」**已有**——`cancel_agent` 工具 + 再调一次
> `delegate_agent`，不用新做。缺的是「输出原因」：子 run **不装插件**，所以没有 loopGuard，
> 只有 `childAgentLoop.ts:200,257` 的 `maxTurns` 兜底，转满抛一句 `exceeded maxTurns`，
> 不说明它在重复什么（主 run 反而有 `loopGuardPlugin` 默认装配）。→ **已开卡 F1**。

**A6. 外部插件要不要给拦截权**（11-4）
> ▸ 人话：仓库自己写的插件能干 7 类事，但第三方插件只能干 1 类，而且**只能看不能拦**（返回值直接被
> 丢掉）。要定：这是刻意画的下限（要拦截就必须写进仓库里），还是只是暂时投影得少、以后按需放开。
证据：`pluginContracts.ts:72-76`；`pluginHost.ts:65-73` 丢弃返回值。
A 刻意的下限　B 以后按需扩投影
答：能干哪7类？ 都是atom的，应该都访问到atom状态，都能改，插件都一视同仁，不管是自己的，还是三方的

> **那 7 类是**（`loopHooks.ts:164-192`）：`onRunStart`、`transformContext`（组请求前改上下文）、
> `prepareRequest`（发请求前再改一次）、`beforeToolCall`（**返回 block 能拦下工具调用**）、
> `afterToolCall`（改结果）、`onTurnEnd`（能要求停 run）、`shouldStop`。第三方现在只拿到
> `afterToolCall` 的观察权，且返回值被丢弃。
> **未闭合的那一半**：「一视同仁」意味着第三方插件也拿到 `beforeToolCall`——那等于让它能否决
> shell 命令、也能改模型看到的上下文。**这一条给不给？**
**你的裁决**：给，同等权利。→ **已开卡 F2**（安全敏感：`beforeToolCall` 能否决 shell 命令，
> 卡里要求信任模型与安装面一并交代）。
> **追记（2026-08-20）**：F2 落地时只给了 hook 对等，atom 读写半边挂起再问；裁决**「给，读写同理」**
> → 开卡 F2b（受限读写面，写入仍必须入事务日志）+ F2c（样例与文档）。

**B1. CLI 到底算什么**（01-3, 02-1, 16-1）
> ▸ 人话：`pnpm cli` 这条路**不存会话、不接 MCP、trace 只往终端打**。代码里还留着一行没调用的持久化
> import（因为编译器那个检查被关了所以没报错）。要定：CLI 就是「跑一次就完」的工具（那就删掉那行
> 悬空 import，并改掉 CLAUDE.md 里「库文件与 CLI 共用同一份」那句），还是它该是完整的第三种宿主
> （那要接持久化，还要把 MCP 那 40 个文件从 web 里抽出来）。
证据：`apps/cli/src/runtime.ts:9` 悬空 import；无 `persistence-*` 依赖；`tsconfig.app.json:12` 关了 `noUnusedLocals`。
A 一次性工具　B 完整第三宿主
答：暂定为一次性工具，等等，不都是一个统一后端，cli只是显示而已，这里可以继续讨论

> **现状补充**：CLI 不调 `resolveHost()`，它在自己进程里装同一份 core + host-node，是唯一前后端
> 同进程的形态；不存会话、不接 MCP、trace 只在 `--verbose` 时打 stderr。
> 你后来裁定了方向「agent 循环跑服务端、前端纯展示」——**那条方向落地时 CLI 可能该变成「连到
> server 的客户端」**，所以这条建议等迁移开树时一并重开。

**你的裁决**：开 issue 任务树。→ CLI 的定位与「agent 循环跑服务端」是同一件事的两面，
> 归入**方向迁移树**的前置项（那棵树尚未开）。当前树里 A6 卡只删那行悬空 import，不动定位。

**B6. sqlite 包反过来依赖 idb 包，算不算可以照抄的先例**（12-2）
> ▸ 人话：观测那对包里，sqlite 版**依赖了** idb 版（开发模式下读不到就用 idb 兜底）。这是这个家族
> 里唯一一条反向依赖。要定：这只在「同域内 sqlite 需要 idb 兜底」这一种情况成立，还是以后持久化那对
> 包遇到类似需求也可以照做。
证据：`observability-sqlite/src/devSqliteLogReader.ts:1`。
A 特例，别照抄　B 通用模式
答：idb是啥，

> **idb = IndexedDB**，浏览器自带的本地数据库。没有后端时（纯静态部署）会话和 trace 存这儿，
> 有后端时走 SQLite。这条问的是「`observability-sqlite` 反过来依赖 `observability-idb` 做 DEV
> fallback，这个先例能不能照抄」。
> **方向裁决可能让它自动消失**：前端不再自己存东西的话，idb 那套 driver 还需不需要要一并定。

**你的裁决**：保持现状——`observability-sqlite` 依赖 idb 那条先例不推广，也不改。✅ 已闭合。

**D-4（`dist/` 扫描面）**

4. 门禁扫描文件时**没排除 `dist/`**——1453 个文件里 610 个是编译产物。CI 里因为门禁排在 build 之前，
   恰好没症状；本地跑过 build 就会扫到。（`scripts/state-invariants/sourceFiles.js:13`）答：不知道

> 已按「不知道」处理：判据**你的裁决**：保持现状——`observability-sqlite` 依赖 idb 那条先例不推广，也不改。✅ 已闭合。，但**下一条按行扫描的规则不要直接复用那份文件清单**
> （`scripts/state-invariants/sourceFiles.js:13` 扫的 1453 个文件里 610 个是编译产物 `.d.ts`）。

**你的裁决**：`sourceFiles` 加黑白名单。→ **已开卡 F3**。 

## 二、我合并时没有上会的（6 条）

按 `question-filter` 判为「不改变新代码去向」而砍掉的，各自记在对应线文件里。列在这里是为了
**让你知道我砍了什么**——不同意就把它捡回来：

- **00-3 稳定前缀里工具摘要段的位置**：顺序与 `modelTurnSystemItems.ts` 注释自称的原则矛盾。
  ※ C7 已把前缀重排成五段并写明排序理由，这条实际上已被覆盖。
- **00-4 `shouldStop` 槽的定位**：core 自带插件都只用 `onTurnEnd`，`shouldStop` 无人注册。
- **11-3 React 插件安装面有没有宿主**：`installReactPlugins` 在 `apps/**` 零调用点。
- **12-1 driver 家族的文档落点**：新增 driver 包时要不要同时新开一份 docs。
- **14-4 `check-docs` 补不补 `check:docs` 别名**：五条门禁里它是唯一没有 package.json 别名的。
- **16-4 `placeholderSync` 的 `onSkip` 只 `console.warn`**：跨服务撞名时用户看不到「某个工具
  为什么一直不出现在清单里」。
