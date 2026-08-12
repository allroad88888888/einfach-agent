# MCP 透明连接蓝图

> **状态：已实施（D0–D4，2026-08-12）。** 本文作为设计记录保留；当前实现以
> [MCP 集成](mcp-integration.md) 为准，引用具体行为前仍应核对实现与测试。落地拆分见
> [MCP 未决决策落地 Issue 树](mcp-decisions-issues.md) 的 D 分支。

## 决策与边界

已拍板：**显式连接工具与透明连接两者都要**。

- 保留 `connect_mcp_server`：显式预热、语义明确的起进程确认点、唯一能连「没有缓存清单」的服务的入口。
- 新增**占位工具**：把未连接服务的「上次已知」工具清单注册进 ToolRegistry，模型直接调用
  `mcp__<服务>__<工具>` 时先透明连接再执行。
- 上下文成本（占位摘要进每次请求的工具清单）**已被接受**，量化与缓解见「上下文预算」。

三条不可推翻的设计输入：

1. 工具名缓存**刻意不存 `inputSchema`**（见 [`toolNameCache.ts`](../apps/web/src/mcp/toolNameCache.ts)
   文件头）。透明模式下真实 schema 必须连上之后取，占位绝不伪造参数定义。
2. 起进程确认**不新造判定点**：仍是 `classifyToolRisk` 一处策略 + 起进程指纹一处判据，
   未确认的 stdio 在 Auto 模式下也必须暂停（commit `fee2264` 的语义）。
3. 依赖方向不变：`agent-ai ← agent-core ← tools-* ← app`。缓存住在 app 层，tools-mcp 只吃注入的
   只读读出口，core 只吃注入的事实。

## 一眼流程

```text
冷启动 hydrate ──> 已登记但未连接的服务 ──> 按缓存清单注册占位工具
                                             │
模型看见 manifest 里的 mcp__s__t ────────────┘
   │
   ├─ request_tool_schema(mcp__s__t) ──> 返回【占位】的透传 schema + guide（不连接）
   │
   └─ 直接调用 mcp__s__t(args)
        │
        ├─ 风险判定：服务未连接 + stdio + 命令行未确认 → 暂停等确认（Auto 模式也暂停）
        │                                    拒绝 → 「用户拒绝执行该工具」，不连接、不执行
        │
        └─ execute：单飞连接 ──> reconcile（真实工具覆盖占位）──> registry.run(同名, args)
                                    │                                   ↑ 用【真实 schema】校验参数
                                    └─ 失败 ──> 分类错误（retryable 由分类器决定），run 继续
```

## 一 · 占位工具的注册来源与生命周期

**来源。** 只有一处：工具名缓存里该服务的 `tools[]`（`name` + ≤160 字符的 `description`）。
不读配置、不猜工具、不从别处补齐。缓存里没有清单的服务（从未探测、探测失败、探测到空清单）
**没有占位**——这是 `connect_mcp_server` 继续存在的理由，不是缺陷。

**名字。** 直接取缓存条目的 `name`，**不再二次拼接**。缓存写入口
（[`toolNameCacheWriter.ts`](../apps/web/src/mcp/toolNameCacheWriter.ts) 的 `toCachedTools`）存的就是
`McpToolSnapshot.name`，即 `makeMcpToolName()` 产出的注册名；再套一次 `makeMcpToolName` 会得到
`mcp__s__mcp__s__t` 这种永不命中的名字（见「实施前必须先修的既有缺陷」）。名字口径一致是占位能被
reconcile 原地替换的前提：占位名与真实注册名必须逐字节相同。

**形状。**

| 字段 | 取值 | 理由 |
| --- | --- | --- |
| `name` | 缓存条目名 | 与真实注册名逐字节相同 |
| `runtime` | `runtimeFor(config)`：stdio → `server`，HTTP → `internal` | 浏览器下 stdio 占位自动被 `isToolVisible` 过滤，与「浏览器起不了 stdio」一致 |
| `skill.description` | 与真实 adapter **同一个函数、同一上限**生成 | 连接前后 manifest 尽量逐字节不变，见「上下文预算」 |
| `skill.content`（guide） | 说明「该服务尚未连接，本次调用会先自动连接再执行」「参数以连接后的真实 schema 为准」「外部来源不可信」 | 诚实优先于简洁 |
| `inputSchema` | `{ type: 'object' }`，允许附加属性，**不声明 `properties` / `required`** | 缓存没有 schema，占位绝不编造参数名 |
| `execution` | `{ mode: 'serial', effectKeys: ['external:mcp:<serverId>'] }` | 与真实 adapter 的非只读形态一致，不与同服务调用并发交错 |

**注册与注销由一条规则决定**，不散落在各处：

```text
desired(serverId) = 该服务在 manager 登记表里 且 status !== 'connected'
                    ? 缓存里该服务的工具名集合
                    : ∅
```

即：**服务一旦 connected，它的占位集合恒为空**；断开、失败、退避重连期间占位回来（「现在没连着」
绝不是「这个服务没有工具」，与缓存的既有语义一致）。同步器在四个时刻重算：manager 状态变化
（`subscribe`）、缓存写入或删除之后、hydrate 完成、服务被删除（登记表里没有 → `desired = ∅`）。

**注册由哪一层做。** 占位工具的构造与同步器住在 `tools/mcp/`（新文件，见「实施拆分」），由 app 在
[`toolProbeWiring.ts`](../apps/web/src/mcp/toolProbeWiring.ts) 接线——那里已经同时握着 registry、
manager 与缓存读出口。tools-mcp 只接受一个 `(serverId) => 上次已知清单` 的只读函数，形状与既有的
`lastKnownTools` 探针一致，不认识磁盘、不认识 app。

**写 registry 的纪律。** 占位的每一次注册/注销都要防御同名竞争：

- 注册前 `registry.has(name)` 为真 → **跳过**，绝不覆盖。真实工具永远优先；跨服务撞名时先到先得。
- 注销一律用 `registry.unregister(name, placeholderTool)` 的 `expected` 形式。这样即使真实工具已经
  把这个名字接管过去，同步器也不可能误伤它——与 manager 既有的动态注销纪律同源。

## 二 · `request_tool_schema` 命中占位：**不连接**

**结论：schema 请求返回占位自己的透传 schema 与 guide，不触发任何连接。** 真实 schema 在 execute
那一步取回，并经既有机制自动送达模型。

理由有三条，任何一条单独成立即可否掉「schema 请求时连接」：

1. `ToolCatalog.loadSchema` 是同步的，`handleToolGate` 也按同步契约调用它。要在这里连接，就得把
   core 的工具闸门整条改成异步。
2. `handleToolGate` 排在 `classifyToolRisk` **之前**。让 schema 请求能起本机进程，等于把起进程动作
   挪到确认闸门够不到的位置，必须再造第二个确认点——直接违反「不新造判定点」。
3. schema 请求是探索性动作（模型可能只是在比较几个工具），让它有权拉起子进程，风险与收益不成比例。

**真实 schema 怎么到模型手上（无需模型再问一次）。** 连接成功后 reconcile 以同名注册真实工具，
签发更高的 `registrationVersion`；下一轮 `refreshVisibleTools` 对每个可见工具重读目录，发现版本变化
就把可见集合里的占位快照换成真实快照。于是**真实 `inputSchema` 随下一轮请求的顶层 `tools` 字段自动
下发**，与「schema 不进消息历史」的既有协议完全一致。

由此本设计**消除了一类中间态**：不存在「请求 schema 时连接失败」的回执，连接失败只可能出现在
execute 路径（见第六节）。缓存不存 schema 的既有决定因此完整兼容——占位从头到尾没有声称过自己有
真实 schema。

## 三 · execute 命中占位：连接 → reconcile → 委派

一次占位调用的完整步骤：

1. **入口校验**：`args` 必须是对象（由 registry 用占位的透传 schema 保证）。
2. **状态复查**：`manager.get(serverId)`。记录已消失 → 结构化错误（服务已被删除）；已 `connected` →
   跳过第 3 步直接委派。
3. **单飞连接**：按 serverId 合并在途连接，同一时刻只允许一次。**这是必需项而不是优化**——
   `manager.reconnect()` 对一条已连上的连接是「先注销全部工具再重建」，第二次调用会把第一次刚建好的
   连接拆掉、把正在用它的调用打断。连接超时用 `MCP_CONNECT_TIMEOUT_MS`（180 秒），**不吃**工具调用的
   硬超时。
4. **reconcile**：由 manager 在连接成功路径内完成（与显式连接同一条路），真实工具覆盖同名占位。
5. **委派**：`registry.run(name, args, ctx)`。参数在这一步、对着**真实工具的 `inputSchema`** 完成校验
   与规范化（含 default 填充），再进入真实 adapter 的 `execute`。

**参数校验发生在哪一步、对着哪份 schema——两段，缺一不可：**

- 第一段（占位的透传 schema）：只保证「args 是一个对象」。它不校验业务参数，也不假装校验过。
- 第二段（真实 schema）：由 `registry.run` 在委派时执行。因此**没有任何一次远端调用是用未经真实
  schema 校验的参数发出的**。第二段失败时返回 `ok:false` + 校验错误 + 一句提示：真实 schema 已随下一轮
  请求下发，请按它重新发起调用，不要沿用本次猜测的参数——这与 `tool_schema_autoloaded` 的既有措辞同源。

**为什么委派用 `registry.run` 而不是 `ctx.callTool`。** `ctx.callTool` 的防环判据是
`[...stack, 当前工具名].includes(目标名)`，而占位与真实工具**共用同一个名字**，必然判成
`tool cycle`。这不是可以绕过的实现细节：占位模块必须闭包住装配期注入的 registry，走
`registry.run` 委派（它同样提供 schema 校验、错误封装与 AbortError 透传）。委派时不传
`expectedRegistrationVersion`——外层执行器已经按占位版本做过一次原子校验，内层要执行的正是刚注册的
那一版。

**典型代价。** 与任何懒加载工具一样：一轮加载 schema、一轮调用。参数猜对时占位调用与普通工具同为
两轮；猜错时多一轮（第三轮已带真实 schema，可自愈）。**透明连接的收益是稳健性与可发现性，不是轮次**——
模型不再需要理解「连接状态」这个概念，也不会因为忘记调 `connect_mcp_server` 而撞墙。

## 四 · 起进程确认：复用同一条链路

**必须复用、不得新造：** 策略仍只在 `classifyToolRisk`
（[`dangerousTools.ts`](../packages/agent-core/src/runtime/dangerousTools.ts)）一处，指纹比对仍只在
app 的起进程确认记录一处，`mcpConnectTarget` 探针仍是 `serverId → { spawnsLocalProcess, command,
launchConsented }` 的那一个。新增的只有**一条事实**：这次 `mcp__*` 调用会不会在本机起进程。

- **事实由装配期合成**：注册名 → serverId（app 侧的缓存/登记表映射）→ 交给既有的
  `createMcpConnectTargetProbe`。合成后的探针在**服务已连接时返回 undefined**——已连接的调用不会
  拉起任何进程。
- **风险表**：未连接 + stdio + 命令行未确认 → `dangerous` 且 `requiresConfirmation`（该标记的语义就是
  「Auto 模式也要暂停」），`reason` 复用 `describeMcpLaunch()` 的文案，用户在卡片上看得到将要执行的
  命令行；未连接 + stdio + 已确认 → `dangerous`（与今天执行一条命令同级）；HTTP 或已连接 →
  维持今天的 `mcp__*` = `dangerous`，Auto 模式直接执行，**零回归**。
- **默认方向**：探针答不上来（未接线、id 未登记、探针抛错）时**不能**一律从严——那会让已连接服务的
  每次普通 MCP 调用都在 Auto 模式下停下来问，属于回归。安全性改由一条装配硬约束保证：
  **占位注册与该探针必须在同一处接线、同进同退**（与 `toolProbeWiring.ts` 现有的「两根线不许只接一半」
  同一条纪律）。没有占位就没有透明连接，也就没有可被静默拉起的进程。

**确认被拒绝时怎么收场。** 走既有路径：写入 `{ error: '用户拒绝执行该工具' }` 作为该 tool_call 的结果，
run 继续；**不连接、不执行、不改任何持久化状态**，占位保持注册。两条附带结论：

- `mcp__*` 本来就被排除在会话级「一律允许」记忆之外，所以拒绝之后不会被某次记忆悄悄放行。
- **模型路径的一次确认不回写起进程指纹**（指纹只由用户路径写入，这是它「改了命令 = 确认作废」性质的
  单点来源）。代价是同一个未确认服务在连上之前每次都会问一次；而一旦连上，后续调用不再问——重复
  询问的上限是「每次连接一次」，可接受。

## 五 · reconcile 与占位共存

**头号阻塞项（D2 必须先解决）。** 今天的
[`toolReconciler.ts`](../tools/mcp/src/toolReconciler.ts) 判定冲突的条件是
「`registry.has(name)` 且这份注册不是本服务上次注册的那个实例」。占位由同步器注册、不在 manager 的
`registered` 表里，于是**每一个有缓存清单的服务，连接时都会 100% 抛
`MCP tool name conflicts with an existing tool`**，被失败分类器判成 `tool_name_collision` 永久失败。
不先处理这一点，占位一上线就等于把所有 MCP 服务连接全部打死。

修法（保持「抛出即 registry 未被改动」的既有契约）：

- 冲突判定增加一条放行——这个名字正被**本服务的占位**占着时不算冲突。判据来自占位登记表
  （`owns(name)`），不看名字长相。
- 覆盖阶段：`registry.register(realTool)` 直接覆盖同名占位（register 后注册者胜，签发新版本），同时把
  该名字从占位登记表释放。释放只发生在 mutate 阶段，校验阶段仍然零副作用。
- 连接成功后该服务的占位集合归零（第一节的规则），剩下的「远端已消失」占位由同步器以 `expected`
  形式注销。

**远端清单与缓存不一致（工具没了 / 改名）。** 模型直调一个已消失的占位时：连接成功 → reconcile 后
registry 里没有这个名字 → 委派前的存在性检查失败 → 返回结构化回执：服务已连接，但该工具不在真实清单
里（可能已改名或下线），附**当前真实清单**（复用 `describeConnectedServer` 的 ≤50 条名字与短描述），
并写明「以真实清单为准，原样重试无意义」。新注册的真实工具在本 run 内可被点名加载与执行
（工具集 epoch 的「成员只增不减」），所以这条回执是可自愈的。

**同一批里的第二个占位调用。** 第一次调用完成连接后注册版本已变，第二次调用的
`expectedRegistrationVersion` 对不上 → 既有的 `tool_registration_changed` 自愈回执接住（「重读 schema
再调用」），下一轮请求带的已经是真实 schema。不需要为此新增任何机制。

**命名冲突语义**（三条，优先级从高到低）：真实工具 > 先注册的占位 > 后注册的占位。占位从不覆盖任何
已存在的注册；真实工具总是覆盖同名占位；两个服务的占位撞名时后者跳过（并在诊断里留痕，不静默）。

## 六 · 连接失败的降级：不让 run 挂死

失败翻译**不新写一套判断**，直接复用
[`connectFailureResult.ts`](../tools/mcp/src/connect-mcp-server/connectFailureResult.ts)：

| 失败 | 占位调用返回 |
| --- | --- |
| 连接抛错 | `MCP_CONNECT_FAILED`；`retryable` 严格等于 `classifyMcpFailure().status === 'reconnecting'`；`hint` 取既有 reason 表；`details` 带 `serverId` / `transport` / `status` / `reason` |
| 连接超时（180 秒） | `MCP_CONNECT_TIMEOUT`，`retryable: true`，不经分类器 |
| 服务已被删除 / 未登记 | 不可重试的结构化错误，绝不回显任何连接目标 |
| 连接成功但工具已消失 | 见第五节，附当前真实清单 |
| 远端调用本身失败 | 真实 adapter 的既有语义（`MCP_REMOTE_ERROR` / `MCP_TOOL_TIMEOUT` / `MCP_TRANSPORT_ERROR`） |

回执统一带上「这不是你的参数错，是它所属服务没能连上」的语气，并在 `details` 里标出这是一次透明连接
（`viaPlaceholder`），让 trace 能把两类失败分开统计。

**「不挂死」的四条硬保证：**

1. 一次调用只尝试**一次**连接；退避重连仍然只属于 manager，占位不自己重试。
2. 连接有独立超时（180 秒），不吃工具调用的硬超时——否则一个连不上的 stdio 服务能把一次 run 卡住
   整整一小时。
3. `execute` 永远返回 `ToolResult`，绝不抛（AbortError 除外，仍作为控制流透传给 run 状态机）。
4. 连接失败**不清空缓存、不注销占位**：「这次没连上」不是「这个服务没有工具」。

## 七 · `connect_mcp_server` 的新分工

保留，定位收窄为三件事：

1. **显式预热**：用户或模型预期要连续调用某服务时，一次连上，后续调用零连接延迟、零确认打断。
2. **诊断**：返回真实清单、状态与分类后的失败原因，是唯一能主动暴露「这个服务为什么连不上」的入口。
3. **兜底发现面**：**没有缓存清单的服务没有占位**（探测失败、从未探测、凭据缺失导致探测失败）,
   它们只能经这个工具被看见和连接。

**文案去重（D4 的判据）：**

- manifest 描述**不再逐条列举已有占位的工具名**——那些名字已经以占位形式在工具清单里出现，重复即
  双倍上下文。改为一行状态摘要：未连接服务数、其中「无已知清单」的服务 ID（这部分必须保留，否则它们
  对模型彻底不存在）、以及一句「已知工具已直接出现在工具清单里，可直接调用」。
- guide 保留诊断信息（探测失败原因、UTC 时间戳、被预算丢弃的条数），同样不再重复占位已表达的逐条
  工具名。
- 「上次已知」的限定语与时间戳照旧：占位的 `description` 来自缓存，本身就是历史数据，guide 里要写明
  连接后一律以真实清单为准。

## 八 · 上下文预算

**计量口径。** 占位只进 `buildToolManifestText()` 生成的稳定 system 前缀，形如
`· <name> [<runtime>] — <description>`；**不进请求顶层的 `tools` 字段**（那是懒加载 schema 的预算，
占位只有被点名加载时才占一个槽，与普通工具无异）。

**上限推导。** 占位数据完全来自缓存，因此直接被缓存的既有三条上限压住：单服务 ≤200 条、单条描述
≤160 字符、**整份缓存序列化 ≤20,000 字符**。最后一条是真正的天花板——「50 服务 × 200 工具」的理论
乘积达不到，实际占位 manifest ≈ 缓存文本 + 每行约 20 字符的装饰，**约 3 万字符（≈8–10k tokens）为
硬上限**；典型场景（3 个服务 × 15 个工具）约 1 万字符（≈3k tokens）。这就是决策已接受的那笔成本。

**真正的增量不是稳态字节，而是前缀失效。** manifest 进稳定前缀，占位集合每变一次就记一次
`profile_changed`、provider 前缀缓存整段失效。变更点：hydrate 后首次装载、每次连接/断开、每次缓存刷新。

缓解（按收益排序）：

1. **让连接前后的 manifest 尽量逐字节相同**：占位与真实 adapter 的 manifest 描述由**同一个函数、
   同一上限（160 字符）**生成。远端描述在 160 字符以内时，连接前后该行完全不变，前缀零失效。注意
   今天的行为更差——连接会让 manifest 凭空多出 N 行，占位方案在最坏情况下也只是「N 行的描述被替换」，
   不比现状更糟。
2. 占位只在「未连接」时存在，连接后不叠加，总行数不随连接次数增长。
3. 装载时机收敛在启动 hydrate，run 中途的缓存刷新不影响当前 run（工具集 epoch 已经把 run 内清单冻住），
   最多影响下一个 run 的前缀。
4. 描述截断沿用既有的 160 字符上限，不新增机制。

**子 Agent 边界不变**：占位沿用 `mcp__*` 的既有约束——按危险工具处理、不可显式授权给子 Agent，
必须留在父级执行边界内。透明连接因此不可能从子 Agent 边界内发生。

## 实施前必须先修的既有缺陷

> 已修复（issue 树 D0）：`findLastKnownToolProvider` 改为直接比较缓存条目名，
> `toRegisteredName` 注入链整条拆除。以下保留原始分析。

**缓存里存的是注册名，反查却按远端名。** `toCachedTools()` 写入的是
`McpToolSnapshot.name`（即 `mcp__<serverId>__<remoteName>`），而
`findLastKnownToolProvider()` 对每个缓存条目又套了一次 `makeMcpToolName(serverId, entry.name)`，
得到 `mcp__s__mcp__s__t`，与模型给的名字永不相等。后果：B4 的 `tool_provider_not_connected`
回执在生产环境**从未触发过**（单元测试用远端名做 fixture，所以一直是绿的）。

对本设计的影响有两处，都是硬前提：占位名字必须直接取缓存条目名、不得二次拼接；「注册名 → serverId」
的反查（第四节的事实合成也要用它）必须改成直接比较。建议作为一条独立的 bug 修复先落地，不要塞进
占位注册的 commit 里。

## 实施拆分建议

对照现有 D2 / D3 / D4 的粒度，**建议调整为五个 issue**（本文不修改 issue 树文件，调整由树的维护者决定）：

| 建议 issue | 内容 | 为什么单独成一次 commit |
| --- | --- | --- |
| **D2a**（新增） | reconciler 与占位共存：冲突判定放行本服务占位、覆盖阶段释放占位登记 | 这是 D2 的前置阻塞，且是唯一会让「所有 MCP 连接 100% 永久失败」的改动，必须可独立验证与回滚 |
| **D2**（沿用，缩小） | 占位工具构造 + 同步器 + 装配接线；execute 暂时返回既有的「请先调用 `connect_mcp_server`」结构化回执 | 独立可上线：模型从「未知工具」升级为「清单可见 + 明确下一步」，不引入任何新的起进程路径 |
| **D3a**（新增） | 起进程风险面扩展：`classifyToolRisk` 的 `mcp__*` 分支 + 装配期事实合成 + Auto 模式暂停 | 改动落在 `agent-core`，是安全关键、可独立测试；**必须先于或与 D3b 同一 commit**，绝不能排在它之后 |
| **D3b**（原 D3） | 透明连接 execute：单飞连接 → reconcile → `registry.run` 委派 → 失败/消失/超时映射 | 行为开关落在这一次，前面三条都是它的地基 |
| **D4**（不变） | `connect_mcp_server` 文案分工与去重 | 只改文案与预算，独立验证 |

依赖顺序：既有缺陷修复 → D2a → D2 → D3a → D3b → D4，全串行。

**文件行数约束（硬规则，派活时要带上）**：`tools/mcp/src/clientManager.ts` 已 495 行、
`tools/mcp/src/toolAdapter.ts` 已 503 行，都顶在上限。占位工具的构造、同步器与登记表**一律新文件**，
不得往这两个文件里塞；同步器（生命周期）与占位工具工厂（形状）是两件事，也不要合成一个文件。

## 明确不做的事

- **不让 schema 请求触发连接**（第二节）。
- **不把 `inputSchema` 写进工具名缓存**：schema 属于按需加载那一层，缓存它会诱使模型直接调用未连接的
  工具，破坏惰性加载的分层。
- **不让占位自己重试**：退避重连是 manager 的唯一职责。
- **不让模型路径的一次确认回写起进程指纹**：指纹只由用户路径写入。
- **不取消 `connect_mcp_server`**：没有缓存清单的服务只剩它这一条路。
