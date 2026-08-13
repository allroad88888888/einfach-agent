# 一个内核，三个宿主：装配式 Agent Runtime 设计

写给两类人：想自己搭一个 agent runtime 的，和正在选型 agent 框架的。

这篇讲的不是"我们做了个更强的 agent"，而是一个更窄的问题：**内核该管什么、不该管什么**，
以及这条线怎么不靠自觉、靠 CI 守住。文中所有路径和 API 都能在仓库里对上。

## 一、问题：复用难，是因为 core 什么都想管

大部分 agent 框架的 core 里塞着这些东西：内置工具的实现、存储层、UI 事件、子 agent 调度、
上下文压缩策略、日志落盘。它们能跑，而且第一个宿主上跑得很好。

问题在第二个宿主。

- 想把浏览器里的 IndexedDB 换成桌面端的 SQLite → 得改 core，因为 core 直接 import 了 driver。
- 想长一个 headless CLI → 得绕开 core 里那些 React/DOM 的引用。
- 想裁掉一半工具做个嵌入式小 agent → 做不到，工具是 core 硬编码的。
- 想在同一个进程里跑两个互不干扰的实例 → core 里全是模块级单例。

判断一个 core 干不干净，最快的办法不是读它的架构文档，是读它的 `package.json` 和 import 列表。
本项目 `packages/agent-core/package.json` 的 `dependencies` 只有四项：`@web-agent/ai`（模型请求）、
`@einfach/core`（状态引擎）、`@tauri-apps/api`、`@tauri-apps/plugin-dialog`。没有 React，
没有任何工具包，没有任何存储/观测实现包。

## 二、设计原则：内核只留四样东西

1. **工具契约 + registry**：什么是工具、怎么校验、怎么按 run 冻结一份目录。不含任何具体工具。
2. **主循环**：组装上下文 → 请求模型 → 分派工具 → 回填 → 提交 checkpoint。
3. **hook / 插件面**：横切行为的挂载点。
4. **状态 / 持久化 / 观测的 contract**：只定义接口，不含实现。

其余全部经**槽位**注入：项目 Skills 扫描、计划运行时、子 agent 委派、观测出口、持久化 driver、
工具集本身。

### 横切行为是插件，不是主循环里的 if

一个 agent 主循环最容易腐烂的地方，是"再加一个特判"。上下文超预算了压一下、finish reason 是
`length` 要续写、模型连着三轮调同一个工具要打断、老会话的 settings 字段要迁移——四个需求，
四个 if，主循环就废了。

这些在 `packages/agent-core/src/runtime/core/plugins/` 里是插件。默认集合是三个：

```ts
// packages/agent-core/src/runtime/core/plugins/defaultPlugins.ts
export const defaultCorePlugins: readonly CorePlugin[] = [
  { activate: migrationPlugin },
  { activate: loopGuardPlugin },
  { activate: finishReasonPlugin },
]
```

它们由 `pluginHost` 在 run 激活时**延迟 import**（`activateRun` 里 `await import('./plugins/defaultPlugins')`），
和调用方传进来的插件拼成一份，再 `assemblePlugins` 把同名槽 fan-out 成一个复合 hook 交给 loop。
loop 侧只有"槽为 undefined 就跳过"这一个分支。

同目录下还有 `compactionPlugin.ts`，挂 `transformContext` 槽。它现在**不在**默认集合里——
上下文压缩改走了 durable context checkpoint 路径。这恰好是槽位设计的好处：一个横切行为进来又
出去，主循环一行没动，`transformContext` 槽还在那儿等下一个插件。

## 三、证据一：`createCore` 的槽位

`packages/agent-core/src/runtime/core/createCore.ts` 的签名，就是"内核不管什么"的清单：

```ts
export function createCore(opts?: {
  config?: Partial<RuntimeConfig>
  observability?: ObservabilityPort
  registerTools?: (registry: ToolRegistry) => void
  plugins?: readonly PluginInput[]
  projectSkillsProvider?: ProjectSkillsProvider
  skillRegistry?: SkillsRegistry
  planRuntime?: PlanRuntimeFactory | null
  delegation?: DelegationRuntimeFactory | null
}): CoreInstance & CommandApi
```

几个值得单说的：

**`registerTools`：工具是装进去的，不是内建的。**
`createCoreInstance`（`packages/agent-core/src/runtime/core/coreInstance.ts`）只造一个**空** registry，
装什么由调用方决定。模块级的 `defaultCore` 造出来是没有工具的，应用和测试各自调一次
`registerStandardTools(defaultCore.tools)` 才有标准工具集。这一步反转掉之后，core 到具体工具的
唯一一条入边就断了——工具才拆得成 `@web-agent/tools-shell`、`tools-fs`、`tools-agents` 这些独立包，
嵌入方也才可能只装其中两个域。

**`delegation`：子 agent 不是内核功能，是注入的能力 + 一组工具。**
core 里只有 `DelegationCapability` / `SubagentScheduler` 这些 port 定义
（`packages/agent-core/src/runtime/delegationContract.ts`），实现在 `@web-agent/subagents`，
由装配层传 `createDelegationAssembly` 进来。模型侧的入口是 `@web-agent/tools-agents` 的四个工具：
`delegate_agent` / `observe_agent` / `join_agent` / `cancel_agent`。
换句话说，**子 agent 走的是和读文件同一条通路**——工具契约。没注入 delegation 的宿主，就是一个
没有子 agent 的 agent，core 不需要为此有任何分支。

**`observability` / 持久化：core 只持有出口。**
`ObservabilityPort`（`packages/agent-core/src/observability/port.ts`）是只写的观测边界，
一个 `CoreInstance` 独占一个。持久化同理，`createPersistenceBridge` 把写事件转成 driver 调用，
driver 未配置时全部 no-op——所以 runtime 的单测不配任何存储也是绿的。

**每个实例是真隔离的。** rootStore、session store 缓存、tool registry、abort registry、plugin host、
config 全是这次调用私有的闭包，两次 `createCore()` 互不影响（`coreInstance.test.ts` /
`createCore.test.ts` 守着这条）。

## 四、证据二：三个宿主，同一个内核

**浏览器 / 桌面 UI**：`apps/web/src/main.tsx`，装配代码在文件顶部：

```tsx
registerStandardTools(toolRegistry)
configureDefaultSkillsRegistry(builtInSkillsRegistry)
configureDefaultProjectSkillsProvider(buildProjectSkillsProvider())
defaultCore.planRuntime = createDefaultPlanRuntime
configureDefaultDelegation(createDelegationAssembly)
```

**headless CLI**：`apps/cli/src/runtime.ts`，整个文件 60 行：

```ts
export function assembleCliRuntime(options: AssembleCliRuntimeOptions): void {
  registerStandardTools(toolRegistry)
  configureDefaultSkillsRegistry(builtInSkillsRegistry)
  const bridge = buildNodeProjectSkillsBridge()
  configureDefaultProjectSkillsProvider((workspaceRoot) => scanProjectSkills(workspaceRoot, bridge))
  defaultCore.planRuntime = createDefaultPlanRuntime
  configureDefaultDelegation(createDelegationAssembly)
  configurePersistence({ history: createMemoryHistoryDriver() })
  configureTraceOutput(options.verbose)
  configureCommands({ /* 三个 provider 的 key + globalThis.fetch */ })
}
```

两段的前几行几乎逐字相同。差别全部落在**宿主特有的那几样**上：

| 槽位 | Web / 桌面 | CLI |
| --- | --- | --- |
| Skills 扫描 | 浏览器/Tauri 文件桥 | Node 文件桥 |
| 会话与历史 | IndexedDB / SQLite | 内存 driver |
| 观测 driver | IndexedDB / SQLite | verbose 时写 stderr |
| 模型传输 | Tauri 原生代理 / dev 中继 / 拒绝 | `globalThis.fetch` |
| 凭据 | 桌面受管标记，Key 不进前端 | 环境变量或配置文件 |

**桌面端**没有第三份装配：`apps/desktop/tauri.conf.json` 的 `frontendDist` 指向 `../web/dist`，
直接复用 Web 的产物，只多一层 Rust 桥（`apps/desktop/src/` 下的 `shell.rs`、`mcp.rs`、
`model_proxy.rs`、`web_agent_config_store.rs` 等）负责 shell、MCP stdio、模型代理和凭据读取。
所以"三个宿主"实际是**两份 TS 装配 + 一层原生实现**。

CLI 那 60 行，是这套设计最直接的收益证明：跑 headless 不需要动 core 一行。

## 五、证据三：边界由 CI 强制，不靠自觉

架构约定写在文档里，三个月后必然被破。`scripts/check-boundaries.js` 把五条规则做成了门禁：

```js
const coreRules = [
  { name: 'core 禁入 React', packages: ['react', '@einfach/react'] },
  { name: 'core 禁入工具域', matches: (v) => v === '@web-agent/tools' || v.startsWith('@web-agent/tools-') },
  { name: 'core 禁入能力包', packages: [/* subagents、persistence-*、observability-* */] },
  { name: 'core 禁入 Tauri SQL 插件', packages: ['@tauri-apps/plugin-sql'] },
]
const capabilityRule = {
  name: '能力包禁入工具域',
  matches: (v) => v === '@web-agent/tools' || v.startsWith('@web-agent/tools-'),
}
```

前四条扫 `packages/agent-core/src`，第五条扫五个能力包。当前输出：

```text
边界观察项：
- packages/agent-core/src/runtime/workspaceDialog.ts:2 观察项：core 使用 Tauri dialog 插件
边界检查通过（扫描 225 个非测试 TS/TSX 文件，生效 5 条规则）。
```

它在 CI 里排在测试前面：`check-docs → check-boundaries → pnpm test → pnpm build`。
"core 不依赖 React"这句话，因此是**可执行的**，不是一句愿望。

依赖方向一句话：

```text
@web-agent/ai  ←  @web-agent/core  ←  { @web-agent/tools-*、能力包 }  ←  app
```

箭头一律指向被依赖方，`agent-core` 不得反向依赖任何 `tools-*` 包，也不依赖 React。

## 六、收益长什么样

**换存储。** `HistoryDriver`（`listCheckpoints` / `loadCheckpoint` / `saveCheckpoint` / `truncateAfter`）
和 `SessionsPersistence`（`saveSessions` / `loadSessions` / `saveWorkspaces` / `loadWorkspaces`）
两个接口定在 core，实现分别在 `@web-agent/persistence-idb` 和 `@web-agent/persistence-sqlite`。
装配层一个三元表达式就切换完了，而且 SQLite 那份是**动态 import** 的——浏览器 bundle 里根本不含它。

**换观测。** 同一套：`configureObservability({ driver })`。Web 用 IndexedDB，桌面用 SQLite，
CLI 直接把 span/event 名字写进 stderr——CLI 那个 driver 是 8 行内联对象。

**长出新宿主。** 前面那 60 行。

## 七、取舍：代价是真实的

这套设计不是免费的，以下几条我认为是真代价，不是"看似缺点其实是优点"那种。

1. **装配层样板变多。** 每个宿主都要把 skills、planRuntime、delegation、persistence、observability、
   传输、凭据一项项接上。少接一项不会编译报错——只是那个能力**静默消失**。忘了
   `configureDefaultDelegation`，模型就只是"没有子 agent"，日志里也不会有红字。
   槽位注入把一类错误从编译期推到了装配期，这是实打实的调试成本。

2. **加一个包要改三处。** workspace 包不单独编译，`vite.config.ts` 的 `resolve.alias` 和
   `tsconfig.app.json` 的 `paths` 都直接指向各包的 `src`。新增或改名包时两处都得同步，
   漏一处就是类型和运行时各错各的。

3. **模块级 `defaultCore` 是个妥协。** 多实例隔离并没有 100% 收口：`createCore.ts` 的注释里
   自己写着，Planning 的 getter/writer、持久化 bridge，以及 subagent runtime 内的 registry/权限调用
   仍有 `defaultCore` 兼容路径。它适合隔离普通会话与主循环，但不能宣称完全隔离。
   诚实标注比假装做完了强。

4. **边界脚本是正则，不是类型系统。** 它按行扫 import 字面量，只跳过以 `//` 或 `*` 开头的整行注释，
   不解析行内注释和跨行语句。动态拼接的模块名它抓不住。它挡的是"随手 import 了一个不该 import 的包"
   这种日常失误，不是对抗性绕过。

5. **core 还留着一处宿主依赖。** `workspaceDialog.ts` 直接 import 了 `@tauri-apps/plugin-dialog`。
   它现在是"观察项"——会打印、但不 fail CI。这是已知欠账，不是设计意图。

6. **抽象本身有认知成本。** "工具在哪注册的""这个 hook 谁挂的"这类问题，在装配式结构里要多跳一层
   才能回答。对只有一个宿主、且未来也只会有一个宿主的项目，这层抽象大概率不划算。

## 八、结尾

如果只留一句：**内核的价值不在于它能做多少事，在于它拒绝知道多少事。**

落到可操作的三条：

- 内核只留契约、循环、hook 和 port，其余全部经参数注入；
- 横切行为写成插件，主循环里一个特判都不留；
- 把依赖方向写成脚本挂进 CI——写在文档里的架构约定，寿命大约三个月。

代价是装配层会变啰嗦，一部分编译期错误变成运行期的"能力静默缺失"。
如果你的 agent 只会有一个宿主，这笔交易不一定划算；
如果你已经在为第二个宿主复制粘贴 core，那就该动手了。
