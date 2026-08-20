# 线：MCP 第七工具域与应用层编排
一句话：把外部 MCP server 的远端工具变成本地 `ToolRegistry` 里可调用的工具，并管住它们的连接生命周期。
类型：分支线——挂在主线的 `apps/web/src/main.tsx:152`（运行时：`initializeMcpSettings(host)`）与
`tools/mcp/src/index.ts:48`（编辑/配置时：`registerMcpTools(registry, dependencies)`）。

## 入口（一个实例从哪开始；引 file:line）
- 装配唯一入口：`apps/web/src/main.tsx:152` 同步调 `initializeMcpSettings(host)`，紧接 `main.tsx:153`
  `void hydrateMcpSettings()`（后台读盘，不阻塞首屏）。实现 `apps/web/src/mcp/initialize.ts:73`，
  `initialize.ts:74` 是幂等门。
- 域注册唯一生产调用点：`apps/web/src/mcp/toolProbeWiring.ts:117` `registerMcpTools(...)`。
  全仓再无第二处（`git grep -l registerMcpTools` 只命中 `tools/mcp/` 自身与 `apps/web/src/mcp/`）。
- 用户入口：设置面板 → `apps/web/src/agentNew/ui/McpAddServerForm.tsx:42` 表单提交 → `submitMcpDraft()`。
- 模型入口有两条：显式 `connect_mcp_server`（`tools/mcp/src/connect-mcp-server/connect-mcp-server.ts:46`）
  与直接调用占位工具 `mcp__<服务>__<工具>`（`tools/mcp/src/placeholderTool.ts:99`）。

## 数据怎么走（逐步；每步引 file:line）
1. **声明**（用户配一个 server）→ `installFlow.ts:68 submitDraft()` 校验草稿 → `installFlow.ts:96`
   `persist(...)` 落盘。落点按 `host.kind` 二选一（`initialize.ts:52`）：`server` 宿主写
   `~/.webAgent/config.json` 的 `mcp.servers`（`serverMcpConfigStorage.ts:29,77`），`static` 宿主写
   localStorage 键 `web-agent.mcp-servers.v1`（`persistence.ts:8,133`，写前剥凭据 `persistence.ts:87`）。
   落盘后 `installFlow.ts:110` 安装即探测（`probeOnInstall.ts`），把工具名清单写进缓存。
2. **登记 ≠ 连接** → `service.ts:263` 把配置里**全部**服务 `manager.register()` 进登记表
   （`clientManager.ts:103`：只登记、不发请求、不起进程，已登记的原样返回）；`service.ts:276` 才对
   「`autoConnect` 且 `mayLaunchMcpServer(config)`」的服务真连。
3. **注册（占位）** → 缓存读盘完成后经 `initialize.ts:112` 的闭包回调 `syncPlaceholders()` →
   `placeholderSync.ts:197 sync()`。desired 式子写在 `placeholderSync.ts:10-13`：**在登记表里 且
   `status !== 'connected'`** 时取缓存清单，否则 ∅。占位形状由 `placeholderTool.ts:99` 造，
   `inputSchema` 恒为 `{ type: 'object' }`（`placeholderTool.ts:123`，绝不编造参数名）。
4. **连接** → `connect_mcp_server.execute`（`connect-mcp-server.ts:264`）或占位 execute
   （`placeholderExecute.ts:196`）都只调 `manager.reconnect(id)`，两者的 manager 能力面都被收窄为
   `Pick<..., 'reconnect'|'get'|'list'>`（`connect-mcp-server.ts:65`、`placeholderExecute.ts:43`），
   **不含 `connect(config)`**——模型永远只能选服务，不能造连接目标。
   → `clientManager.ts:243 this.connector.connect(config)` → `connectorRouter.ts:25` 按
   `config.transport` 分派：`streamable-http` 走 `streamableHttp.ts:285`（官方 SDK + 4 MiB 响应闸），
   `stdio` 走 `apps/web/src/mcp/serverStdioConnector.ts:100` → `POST /api/invoke/mcp_connect`
   （`serverMcpCommands.ts:152`）→ `packages/host-node/src/mcp/manager.ts:57` → `sessionSpawn.ts:28`
   真 spawn 子进程（`childProcess.ts:38`，**永不 `shell:true`**）。
5. **对账** → `clientManager.ts:253 reconcile()` → `toolReconciler.ts:91 reconcileMcpTools()`：
   `connection.listTools()` → 逐条 `createMcpToolAdapter`（`toolAdapter.ts:368`）→ **全部校验完成后**
   才动 registry（`toolReconciler.ts:158`）。同名占位在 `toolReconciler.ts:164` 被真实工具直接覆盖，
   随后 `toolReconciler.ts:169` 释放占位登记。
6. **执行** → 真实工具 `toolAdapter.ts:404 execute` → `connection.callTool` → `normalizeMcpToolResult`
   （`toolAdapter.ts:323`）。命中占位则走 `placeholderExecute.ts:176`：状态复查 → 单飞连接
   （`placeholderExecute.ts:139 connectOnce`）→ 存在性检查（`placeholderExecute.ts:208`，registry 有人
   **且**占位登记表没人，否则会调回自己变成无限递归）→ `registry.run` 委派（`placeholderExecute.ts:223`，
   刻意不用 `ctx.callTool`，那条路的防环判据会把「占位与真实工具同名」判成 tool cycle）。
7. **结果去哪** → `ToolResult` 回主循环；连接成功后 `refreshOnConnect.ts:74` 把真实清单刷回缓存，
   `toolNameCacheProjection.ts:51` 把同一个对象引用投影进界面 atom `state.ts:65 mcpLastKnownToolsAtom`。

## 每部分负责什么 / 状态归谁 / 谁能调谁
| 部分 | 职责 | 持有的状态 | 谁可以调它 | 不许做 |
|---|---|---|---|---|
| `tools/mcp/clientManager.ts` | 连接生命周期状态机 | 登记表、在途控制器、退避表、保活表 | app 装配点、两个连接工具（收窄面） | 不认识占位（`clientManager.ts:51` 只透传）、不碰磁盘 |
| `serverRecords.ts` / `serverQueue.ts` | 登记表投影 / 按 serverId 串行 | 记录 Map、队尾 Map | clientManager | 不决定状态何时变 |
| `toolReconciler.ts` | 远端清单 → registry 增删改 | 无（返回新表） | clientManager | 抛出即 registry 未被改动 |
| `toolAdapter.ts` | 一个远端工具 → 一个可执行 `Tool` | 无（纯工厂） | reconciler | 不猜业务语义；JSON 边界防御 |
| `placeholderClaims/Tool/Sync/Execute/Result.ts` | 未连接服务的名字占位与透明连接 | claims 登记表、单飞表 | app 装配点 | 占位绝不覆盖真实工具 |
| `failureClassification.ts` | 失败 → 暂时/永久 + 原因标签 | 无（纯函数） | clientManager、两个连接工具 | 永久结论只能来自对端不参与撰写的信号 |
| `reconnectSchedule.ts` / `keepaliveMonitor.ts` | 退避预算 / 探活判死 | 定时器 + 次数 | clientManager | 都不自己发起重连 |
| `connectorRouter.ts` + `streamableHttp.ts` | transport → connector 分派；HTTP 实现 | 路由表 | 装配点 | 路由器不认识具体传输 |
| `connect-mcp-server/` | 唯一域内静态工具 | 无 | registry | 不接受 URL/命令行；不回显被拒目标 |
| `apps/web/src/mcp/initialize.ts` | 一次性装配（139 行） | 无 | `main.tsx` | 不自己探宿主（`initialize.ts:64`） |
| `apps/web/src/mcp/service.ts` | 长期编排：hydrate/增删改/确认（426 行） | 订阅、队列、缓存句柄 | `commands.ts` 单例 | 不认识宿主是什么 |
| `toolNameCache*.ts`（4 个） | 清单缓存契约/通道/串行写/投影 | 进程内快照 | service | 绝不存 `inputSchema` |
| `stdioLaunchConsent.ts` + `launchConsent*.ts` | 起进程确认（绑命令行指纹） | 待确认队列 atom | service | 指纹比对只有一处 |
| `serverStdioConnector.ts` 等 7 个 | server 宿主 stdio 传输桥 | SSE 流、会话集合 | 装配点 | 不改 `McpConnector`/`McpConnection` 契约 |
| `packages/host-node/src/mcp/`（28 文件） | 真 spawn、JSON-RPC 会话、四条命令 | 会话表/tombstone | `createNodeHostInvoke.ts:63` | 不 shell、不把 stderr 混进 stdout |

## 形状（分支线：目录/文件形状 + 计数；必需 vs 可选）
- `tools/mcp` 66 个跟踪文件，`src` 下 61：**30 个源**（29 `.ts` + 1 `.d.ts`）、**30 个测试/夹具**、
  1 个 `.md`。是 tools 家族最大的成员，但只有 **1 个工具目录** `connect-mcp-server/`。
- **两种形状要分开看**：
  - **工具目录形状**（与其它六域同形）：精确 1/1 `{<tool>.ts, <tool>.md, *.test.ts, *.fixtures.ts}`，
    另加 5 个该工具私有的拆分文件（`connectInputSchema/connectSkill/connectFailureResult/
    connectedServerResult/connectTargetProbe`）与 3 个 lastKnownTools 文件。
  - **传输形状**：`McpTransport` 2 个成员（`types.ts:27`）。connector 实现 2 个，**落点不同**：
    `streamable-http` 的住域内（`streamableHttp.ts`，只用 `fetch`），`stdio` 的住应用层
    （`apps/web/src/mcp/serverStdioConnector.ts`，要宿主能力）。1/2 在域内，1/2 在 app 层。
- **placeholder\* 实为 14 个文件**（任务给的 12 是旧数），5 个源 + 9 个测试/夹具，逐一职责：
  `placeholderClaims.ts`（名字→哪个服务的哪个占位实例，权属只按登记不看名字长相）、
  `placeholderTool.ts`（占位的**纯形状**：同样入参得同样 Tool）、
  `placeholderSync.ts`（占位的**生命周期**：desired 式子 + 四个重算时机）、
  `placeholderExecute.ts`（一次占位调用的**编排**：单飞连接 → 委派）、
  `placeholderResult.ts`（占位独有的两条回执 + `viaPlaceholder` 标记）；
  测试/夹具：`placeholderClaims.test`、`placeholderExecute.{test,failure.test,fixtures}`、
  `placeholderSync.{test,connect.test,registry.test,fixtures}`、`placeholderTool.test`。
  `placeholderResult.ts` 是**唯一没有 colocated 测试**的源文件。
- **失败分类计数**（`failureClassification.ts`）：状态 2 类（`error` / `reconnecting`，`:23`）、原因
  8 类（`:8-16`）、结构化永久 kind **2** 个（`:97-113`）、「对端撰写」豁免 kind **1** 个（`:130`）、
  本包自有的永久消息规则 **15** 条（`:150-172`）。判定顺序：结构化 kind → HTTP 状态码 → 认证措辞
  （只改标签）→ 对端撰写（落暂时）→ 消息规则 → 默认暂时（`:267-316`）。
- **重连策略**（`reconnectSchedule.ts:37`）：1s→2s→4s→8s→16s→30s，共 6 次约 61 秒，**不加抖动**；
  手动 connect/reconnect/disconnect/remove 与一次连接成功都 `cancel()` 并把预算还回去
  （`clientManager.ts:122,142,162,188,258`）。重试自身绝不走 `cancel`（`clientManager.ts:461`）。
- **保活**（`keepaliveMonitor.ts:41`）：30s 探一次、单次 10s 超时、连续 2 次判死（最坏 80s）；
  只对实现了 `ping` 的连接起表（`types.ts:82`），stdio 不实现，绝不退化成用 `listTools` 当心跳。
- **清单缓存什么时候被信任**：两道门。① 呈现层 `lastKnownTools.ts:93-103`——`cachedAt` 可用、
  `probeStatus === 'success'`、清洗后条目非空，三者缺一即进 gaps 桶（措辞明说「不等于没有工具」）；
  ② 占位层 `placeholderSync.ts:86`——同样要 `probeStatus === 'success'`，且服务必须在登记表里、
  `status !== 'connected'`。探针**抛错**时 `placeholderSync.ts:212-215` 直接 `continue`，不动这个服务的
  占位——「问不到」不等于「没有工具」。
- 必需：`manager`（`index.ts:52` 缺失就在装配期抛）。可选：`lastKnownTools` 探针（`index.ts:39`）、
  `placeholders` 登记表（`types.ts:141`，不接=系统里没有占位，行为与占位上线前逐字节一致）、
  `connector`（不给就默认只有 HTTP，`clientManager.ts:83`）。

## 样板（点名 1–2 个成员 + 为什么：奠基 / 最简 / 最近且干净）
- `tools/mcp/src/streamableHttp.ts`——**奠基**：域内自带 connector 的原形，`connect()` 先拒绝不属于
  自己的 transport（`:289`），再把 SDK 的 `Client` 包成 `McpConnection`（`:171`）。
- `apps/web/src/mcp/serverStdioConnector.ts`——**最近且干净**（commit `6a5e9ef`，2026-08-19）：
  新增一个 connector 的完整样本。文件头 `:7-18` 明写「三处结构差异都源于传输」，`McpConnector` /
  `McpConnection` 两个契约一字不改，于是 `tools/mcp` 那套协议编排在两个宿主上跑同一份代码。

## 加一个（触碰文件；每项标来源：git 配方交集 / 汇合点代码 / 已有清单；不一致处写出）
**A. 加一个 connector（同一 transport、换一个宿主）**——来源：git 配方 `6a5e9ef`（18 文件）与
`bf71e9c`（31 文件）的交集：**新增一群同名 `.ts` + `.test.ts` + 一个 `.testHarness.ts`，外加恰好一个
被「改」的既有装配文件**。
- `apps/web/src/mcp/<host>StdioConnector.ts` + `<host>StdioConnection.ts` + `<host>McpCommands.ts`
  （+ 事件流/解析）——新增，实现 `McpConnector` / `McpConnection`。来源：git 配方。
- `apps/web/src/mcp/initialize.ts:79`——**唯一必改的旧文件**：给 `createMcpConnectorRouter({...})`
  多传一路。来源：git 配方（该文件是 app 层 churn 第 1，16 次）。
- `apps/web/src/main.tsx`——只在需要新的宿主判定分支时改。来源：git 配方。
- `tools/mcp/**` **一个文件都不用碰**——`connectorRouter.ts:12` 自证这是 composition seam。

**B. 加第三种 transport**——来源：汇合点代码（**无历史先例**：两种 transport 由同一个初始 commit
`6d99f0d` 引入，`connectorRouter.ts` 此后再未改过）。按代码，穷举分支在这些地方：
- `tools/mcp/src/types.ts:12-27`——`McpServerConfig` 联合与 `McpTransport`。
- `tools/mcp/src/serverConfig.ts:15,34,59`——`cloneConfig`、`validateConfig`（`:54` 的 `never` 会在
  这里编译期报错，是唯一机械提醒）、`runtimeFor`（决定 `ToolRuntime`，从而决定浏览器下可见性）。
- `tools/mcp/src/connect-mcp-server/connectTargetProbe.ts:41`——`describeTarget`：新传输不补一条就返回
  `undefined`，core 走「答不上来 → 必须确认」的从严分支（`:48-50` 明说最坏是多问用户一次）。
- 装配点 `apps/web/src/mcp/initialize.ts:79` 多一路 connector。
- **应用层还有第二份联合**：`apps/web/src/mcp/types.ts:4` `McpTransport`、`:27,55`
  `PersistedHttpMcpServer` / `PersistedStdioMcpServer`；连带 `config.ts`、`credentialFields.ts`、
  `jsonConfig.ts`、`service.ts`、`state.ts` 都按 transport 分支（`git grep -l "streamable-http"` 在
  非测试文件上命中 11 个：`apps/web/src/mcp` 7 个 + `tools/mcp/src` 4 个）。两份联合各改一遍——见「待确认 #2」。
- `docs/mcp-integration.md` 的「支持范围」表要加一列。

## 标准之外
### 另一类（同目录、不同机制）
- `tools/mcp/src/index.ts:48` `registerMcpTools(registry, dependencies)`——**七个域里唯一收第二个参数**
  的 registrar（`:4-7` 写明理由：本域工具需要一个活的进程级运行时依赖）。其余六域是
  `register<Domain>Tools(registry)`，由 `tools/standard/src/index.ts:34` 一把装齐。
- `connect-mcp-server.ts:220,226`——**唯一把 `skill` 与 `inputSchema` 做成 getter** 的工具：manifest 与
  enum 在调用当刻现算，增删服务立刻生效，无需重新 `registerMcpTools`。
- placeholder 五件套不是「一个工具」，是「registry 里的名字占位 + 透明连接编排」，注册者是同步器
  而非 registrar，因而**不在** `manager.registered` 表里，只在 claims 登记表里（`placeholderClaims.ts:5-9`）。
- 危险确认：`mcp__*` 走 `packages/agent-core/src/runtime/dangerousTools.ts:31` 的**前缀**判定，
  `connect_mcp_server` 走 `:45` 的**等值**判定且不进 `DANGEROUS_TOOLS`（连接能力不可授权给子 Agent）；
  两者都被排除出会话级「一律允许」（`sessionApprovalMemory.ts:8`）。

### 漂移 / 遗留（少、晚、不合形状——引用并说明；是「别模仿」不是「删」）
- **`tauriStdioConnector.ts` 已随 `e52c31d` 删除，但 12 个文件的注释仍以它为对照系**
  （`apps/web/src/mcp/serverStdioConnector.ts:3`、`serverStdioConnection.ts:3,49`、
  `serverMcpCommands.ts:3,13,91` 等）。新写 connector 时别再拿它当参照——它不在仓库里了。
- `packages/agent-core/src/runtime/turnToolVisibility.ts:41-53` 记着一个「stdio 占位在 server 宿主上
  可见但不可用」的窗口，理由是「stdio 的 Node 实现要等 C 线才有」。C 线已于 `6a5e9ef`（2026-08-19）
  落地，窗口已闭合，注释文字未更新。
- **CLI 宿主完全没有 mcp 域**：`apps/cli/src/runtime.ts:116` 只 `registerStandardTools`（六域），
  全仓 `tools-mcp` 的消费者只有 `apps/web/src/mcp/*`。而 `runtime.ts:106` 的注释又说「MCP 域的管理器
  随桥一起创建」——那是 host-node 的**桥**有 mcp 命令，不是 CLI 有 mcp **工具**。见「待确认 #1」。
- `failureClassification.ts:44-51,93-95,126-128` 的表以「host-node 的哪个文件抛哪个 kind」为准，
  但两边**没有任何机械门禁**，只有一句「加 kind 时要回来重查」。见「待确认 #3」。

### 待确认（≤5；只问改变新代码去向的；点名成员；每条两种解释）
1. **CLI 要不要接 MCP**（`apps/cli/src/runtime.ts:116` vs `apps/web/src/mcp/initialize.ts:73`）：
   A 刻意不接——MCP 装配绑着设置面板与起进程确认 UI，headless CLI 没有确认交互，接了就是静默起进程；
   B 只是还没接——host-node 已经提供了四条 `mcp_*` 命令，CLI 进程内直调即可。
   答案决定新代码去向：接的话 `apps/web/src/mcp/` 那 40 个实现文件里的装配/编排部分要抽成宿主无关的包，
   不接的话它们就该继续留在 `apps/web`。
2. **`McpTransport` 的两份联合是不是有意重复**（`tools/mcp/src/types.ts:27` 与
   `apps/web/src/mcp/types.ts:4`）：A 有意——app 层的持久化类型不该 import 域包类型，两份各自演进；
   B 是漂移——加第三种传输时必须两处同改，漏一处的症状是「配置存得下、连不上」。
   答案决定新 transport 的类型落点，以及要不要加一条比对测试。
3. **host-node 新增 failure kind 时靠什么保证不漏**（`tools/mcp/src/failureClassification.ts:97-113`
   与 `packages/host-node/src/mcp/errors.ts`）：A 接受人工纪律——注释已写明「加 kind 时回来重查」，
   且默认落到「暂时失败」是安全侧；B 该有锁定测试——`errors.ts` 的 kind 全集与这两张表比对，
   新 kind 未分类即失败。答案决定下一次改 host-node 错误面时要不要同时写门禁。
4. **`placeholderSync` 的 `onSkip` 只 `console.warn`**（`apps/web/src/mcp/toolProbeWiring.ts:139-141`）：
   A 够用——跨服务撞名是罕见的配置问题，控制台留痕即可；B 该进可观测/设置面板——用户看不到
   「某个工具为什么一直不出现在清单里」。答案决定下一个诊断信号是加 `console` 还是加一条 trace。

## 文档与代码不一致处
- `docs/mcp-integration.md`（「工具清单缓存 · 呈现分两层」一节）说工具名进 `connect_mcp_server` 的
  manifest（「≤1,200 字符、≤12 个服务 × 12 个名字」）、完整清单（工具名 + 短描述）进 guide
  （「≤6,000 字符、≤50 个服务 × 40 条」）；**代码两层都已不再列任何单条工具名**——
  `lastKnownToolsText.ts:64-85` 的 manifest 只给「未连接服务数 + 无清单服务 ID + 一句提示」，
  `lastKnownToolsText.ts:95-99,112-116,125-148` 的 guide 只给「每服务的 UTC 探测时间 + 工具总数」。
  D2/D3b 上线后名字已由占位工具自己承担（`lastKnownToolsText.ts:4-12`）。上限常量仍是 1,200 / 6,000
  （`:28,34`），但 `MANIFEST_MAX_GAP_IDS = 20`（`:30`）与文档的「12 × 12」无关。
- `CLAUDE.md:140` 说 `tools/mcp` 是「第七个域，不在标准包里，由应用层按需装配」——属实
  （`tools/standard/src/index.ts:34` 只装六域），但「应用层」在代码里**只有 `apps/web` 一处**；
  CLI 与 server 宿主都没有这条装配路径。
- `docs/mcp-transparent-connect-blueprint.md:3` 自称「已实施（D0–D4）」，核对属实：占位五件套、
  reconciler 放行（`toolReconciler.ts:136-147`）、`classifyMcpToolCallRisk`（`dangerousTools.ts:204`）、
  文案去重（`lastKnownToolsText.ts`）都在代码与测试里。**可以引用。**

## 证据核过：commit `1ebe4a0`，2026-08-20；本次打开文件数：约 40

## 裁决（2026-08-20，dol）

- #1 → **由方向裁决取代**（questions B1/B2）——问的是「CLI 接不接 MCP」，负责人的答案是更上一层的：mcp 逻辑本来就该在后端。那么 `apps/web/src/mcp/` 那 40 个实现文件里的装配/编排部分要迁到后端，而不是在 web 与 cli 之间抉择。
- #2 → **统一成一份（后端的）**（questions B5）——`McpTransport` 不要两份联合，以后端那份为准。
- #3 → **删前端那张表，只留后端**（questions A10）——失败分类不要在前后端各维护一张靠人对齐；前端不再分类，分类结果由后端带过来。这比「加锁定测试」更彻底，与方向裁决同向。
- #4 → **未提交**——合并时砍掉（`onSkip` 只 `console.warn`），保持未决。
- **方向裁决（全仓，questions B2 / 本轮追认）**：agent 循环目标跑在**服务端**，前端纯展示，
  tools 与 mcp 的逻辑都在后端。本线正文描述的是**当前**形态，不是目标形态——**本线受影响很大**：MCP 连接编排、清单缓存、占位工具这一整套目标位置在后端，前端只保留配置界面与状态展示。
