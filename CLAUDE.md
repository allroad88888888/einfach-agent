# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本文件是仓库内编码 Agent 的快速工作约定。项目现状和启动方法以 `README.md` 为准，
专题设计入口见 `docs/README.md`。

## 命令

这是 pnpm workspace，`packages/*` 和 `tools/*` 使用 `workspace:*`。不要使用 `npm install`。

- `pnpm install`：安装并链接全部 workspace 包。
- `pnpm dev`：Vite 前端预览。**它没有本机后端**——`/api/health` 404，宿主解析成 `static`，
  文件/shell/Git 那一类工具整类不进模型清单。要真跑本机能力用 `pnpm serve`。
- `pnpm serve`：起本机 Node 后端（`apps/server`，默认 `127.0.0.1:4765`，端口被占用时自动往后试；
  `-- --help` 看全部选项），托管前端产物并在 `/api/*` 提供本机能力。**它服务的是构建产物**：
  没先跑过 `pnpm build` 会得到一页 503 提示页，而不是旧界面。
- `pnpm build`：`tsc -b` → `vite build` → `pnpm --filter @einfach-agent/server build`。
  仓库没有 lint 脚本，`tsc -b` 是唯一的静态门禁。**这三步顺序不能倒**：server 的 build 收尾要把
  `apps/web/dist` 复制进自己的 `dist/public`，那份前端产物由上一步产出，全新 checkout 上反过来直接失败。
- `pnpm test` / `pnpm test:watch`：Vitest。
- `pnpm exec vitest run <file>`：单文件；`pnpm exec vitest run -t "<name>"`：按用例名过滤。
- `node scripts/check-docs.js`：Markdown 门禁——相对链接必须真实存在，且禁止引用迁移前的旧源码
  路径（规则见脚本里的 `legacySourcePathPattern`，连在文档里写出那个字面量都会失败）。
  改任何 `.md` 都要跑，CI 里它排在测试之前。
- `pnpm check:state`：状态机制不变量门禁（五条）——derived 必须纯、**全仓**会话状态写入必须收口在
  core 的 `state/` 或 `runtime/commands/`、每个会话 atom 都得有归宿、core 之外读 core 的 atom 必须经
  `useRootAtomValue` / `useAgentAtomValue`（判据与各张表见 §状态与 UI 边界）。改 atom、writer、
  新增写入点或在组件里读 core 的 atom 时要跑——**新增会话 atom 不登记归宿会静默不进快照；
  用错 store 读会静默拿到默认值**。`pnpm check:boundaries` 管的是**包之间**的边界，两者职责不同。
- `pnpm check:dist`：可发布包的 dist 门禁——把每个包 `pnpm pack` 进临时工程装一遍，dist 缺失、
  公开 ESM 入口解析不了、`.d.ts` 在 NodeNext 下不可用都会红。它验的是 `pnpm -r build` 的产物，
  **不是** `pnpm build` 的（后者只出 `apps/web` 与 `apps/server`）。
- `pnpm cli -p "<prompt>"`：headless CLI 宿主跑一轮真实 run（读 `~/.webAgent/config.json`
  或环境变量取模型 Key；`--help` 看全部选项）；无 `-p` 进入 REPL。
- 子 Agent 治理：`pnpm subagent:replay` / `subagent:capacity` / `subagent:archive:retention` /
  `subagent:index:compact` / `subagent:skills`。

CI（`.github/workflows/ci.yml`）只有一条 job，顺序是 `check-docs → check-boundaries → check-state →
pnpm test → pnpm build → pnpm -r build → check-dist`。最后两步排在 `pnpm build` **之后**且不能省：
`pnpm build` 不构建 `packages/*` 与 `tools/*` 的 dist，而 npm tarball 里装的就是那些 dist——少了它们，
dist 陈旧化在 CI 里完全没有症状（包 scope 改名那次，17 个包的 dist 一直留着旧名直到发布路径上才暴露）。

`.github/workflows/release-npm.yml` 是**休眠**的：只由 `npm-v*` tag 触发，而可发布包都是
`private: true`（用户裁决「不发布，仅本地跑」），它的前置判定必然红。那是自我说明的信号，不是缺陷；
别去"修"它。

## 构建与解析模型

workspace 包**不单独编译**：`vite.config.ts` 的 `resolve.alias` 与 `tsconfig.app.json` 的
`paths` 都把 `@einfach-agent/*` 直接指到各包的 `src`。改包无需 build，但新增/改名包时这两处
alias 必须同步添加，否则类型或运行时会各错各的。`tsconfig.app.json` 的 `include` 覆盖
`apps/web/src`、`apps/cli/src`、`apps/server/src`、`packages/*/src`、`tools/*/src`。

「不单独编译」只对**开发与测试**成立。本地分发装的是各包的 `dist/`（`pnpm -r build` 产出，
`apps/server` 另有一步把 `apps/web/dist` 嵌进 `dist/public`），改了 src 而不重建 dist 在仓库内
毫无症状——只在 `pnpm pack` 出去之后才兑现，所以有 `pnpm check:dist` 这道门。

Vitest 的 root 是仓库根（不是 Vite 的 `apps/web` root），jsdom + `apps/web/src/test/setup.ts`，
`isolate: true`：每个测试文件独立 worker，setup 在 worker 内注册标准工具，并只在用例之间重置
`defaultCore` 的 root/session store。测试文件是并行的，以 `vite.config.ts` 为准
（`README.md` 里"测试按串行模式运行"的说法已过时）。组件测试用
`apps/web/src/test/renderWithStore.tsx`：它按生产装配绑三层 store（`store` = 界面、`rootStore` =
core 跨会话、`agentStore` = 会话），三个默认是三个**不同**实例——共用的话「组件从错的那一层读」
在测试里恰好也能跑通，而生产里读到的是默认值。依赖模块级单例命令（settings / mcp / plugins）的
用例要显式传 `{ store: uiStore }`。IndexedDB 测试用 `fake-indexeddb`。

## 模型凭证与传输

**真实 Key 从不进前端。** `apps/web/src/main.tsx` 注进 core 的只是一个受管凭据标记
（`hostManagedCredentialMarker`，字面量 `'desktop-managed-credential'`；名字里的 `desktop` 是历史，
含义是「宿主受管」，core 把它当 apiKey 一路带到受管传输那一层，改字面量要连着断言它的测试一起改）。
Key 由**本机 Node 后端**读写 `~/.webAgent/config.json`（host-node 的 config 域），浏览器经
`/api/invoke/model_credential_*` 交给它，三条命令的返回体只有 `{ configured, source }`——
**任何路径都不回传 Key 本身**。没有后端的 `static` 宿主拿到的是如实回答「存不了」的凭据宿主，
设置面板据此把输入框整块收起来，而不是给一个存进去也发不出去的框。

配置文件的三条边界都在 host-node 的 `config/configPaths.ts`：旧 `~/.web-agent/config.json` 只在新
文件不存在时被**复制**过来（写原文不重排键，旧文件不删不改）；`WEB_AGENT_CONFIG_DIR` 只能
**选目录**，进不来也带不走一个 Key，且设了它就没有 `legacyPath`——迁移在机制上不可能发生，而不是
靠某处记得写一句 if（覆盖目录的语义是「另一套独立配置」，悄悄继承主配置的凭证正是隔离要防的）；
覆盖目录已存在时必须是 0700 的目录，不合格是受控失败且**不回落默认目录**，回落会让用户以为在用
隔离配置、实际写的是主配置。

**传输与凭据宿主必须由同一个判据选出来**，否则会走成「Key 存进了后端、请求发给了另一条通路」，
而两边都不报错。判定是宿主两态外加一条**正交**的构建模式轴：`server` 宿主走 `apps/server` 的
`POST /api/model/request`；否则 DEV 构建走 `scripts/model-preview-relay` 的 Vite 中继（它只认
`DEEPSEEK_API_KEY` 这类环境变量）；再否则 fail-closed 直接拒绝模型请求。**`server` 必须判在 DEV
之前**——凭据宿主那侧只有 `server → unavailable`，没有 DEV 分支。DEV 判的是构建模式而不是宿主，
两者正交：`pnpm dev` 是 static 宿主 + 有中继，`pnpm serve` 是 server 宿主 + 没有中继。
`scripts/public-model-credential-guard.ts` 在 Vite 配置阶段执行——任何 `VITE_*_API_KEY` 都会让
dev/build 直接失败，别试图用 `VITE_` 变量传密钥。

Kimi 的上传、`ms://` 引用编码和清理语义属于 `agent-ai` adapter；后端那一层只有一张按
(供应商, 作用域, method, path) 精确匹配的端点白名单（host-node 的 `model/providerRoute.ts`），
保持 provider-neutral 受限传输。

## 当前结构

- `apps/web/src/main.tsx`：默认应用装配；注册标准工具、配置模型传输、选择持久化和观测 driver，
  并在应用根绑定**界面 store**（`apps/web/src/uiStore.ts`）与 core 的 root store。
- `apps/web/src/agentNew/ui/`：React UI，包含会话、消息、计划、确认、子 Agent 树和输入区。
- `apps/web/src/host/`：宿主分流的装配面——`resolveHost()`（唯一权威）与按它选出的桥、模型传输、
  凭据宿主、观测 driver、刷盘时机。**装配点不自己探宿主**，重探一次的后果不是报错，是两处结论
  不同时静默走岔。
- `apps/web/src/mcp/`：MCP 应用层（配置、持久化、连接编排、工具清单缓存、stdio 起进程确认、
  server stdio connector）。**在 `main.tsx` 里随应用启动装配**，不是等设置弹窗打开才装——
  否则 `autoConnect` 形同虚设。详见 [docs/mcp-integration.md](docs/mcp-integration.md)。
- `apps/server/`：本机 Node 后端（`pnpm serve` / bin `einfach-agent`）：`/api/health` 握手、
  `/api/invoke/:command` 命令面、`/api/model/request` 流式模型代理、`/api/events` 反向事件流
  （SSE），以及前端产物的静态托管。`/api/*` 只有一道门，四道防线按序判：回环对端地址 → Host →
  Origin → token，**默认拒绝**——这个 API 面暴露 `run_shell_command` / `write_workspace_file`，
  拿到它等于在用户机器上任意代码执行。
- `apps/cli/`：headless CLI 宿主，进程内直接登记同一份桥；主目录由它自己用 `node:os` 解析一次
  并注入。
- `packages/host-node/`：**唯一一份宿主能力实现**——workspace 读写/patch/change journal、shell、
  Git、SQLite、MCP stdio、模型转发、`~/.webAgent/config.json`。浏览器经 HTTP、CLI 进程内，
  两条路跑的是同一份代码。
- `packages/agent-ai/`：DeepSeek/GLM/Kimi 请求、流式响应、provider 私有图片准备、adapter 重试
  和 vendor 能力描述表。
- `packages/agent-core/`：装配式 Agent Runtime 内核：工具契约/registry、loop、插件、观测与持久化
  contract、恢复快照与 atoms；不含具体工具域或宿主 driver。
- `packages/agent-react/`（`@einfach-agent/react-plugin`）：React 侧插件安装面、timeline renderer
  registry，以及 **core 两个 store 的 React 绑定**（`RootStoreProvider` / `AgentStoreProvider` 与
  `useRootAtomValue` / `useAgentAtomValue`，界面与 agent 分住不同 store 的那条缝）；core 不依赖 React。
- `packages/agent-plugin-example/`：插件契约的可运行样例，改插件 API 时同步更新。
- `packages/subagents/`：委派调度、批次编排、归档治理与子 Agent 视图 state。
- `packages/persistence-{idb,sqlite}/`：IndexedDB / SQLite 会话与恢复快照持久化 driver。
- `packages/observability-{idb,sqlite}/`：IndexedDB / SQLite trace driver 与 reader。
- `apps/web/src/traceViewer/`：React TraceViewer 与其 view state。
- `tools/{shell,fs,interaction,planning,skills,agents}/`：六个标准工具域；skills 的 loader、registry
  和内置内容在 `tools/skills`，默认 plan runtime 在 `tools/planning`。
- `tools/standard/`（`@einfach-agent/tools`）：meta 聚合包，`registerStandardTools` 一次装齐六域。
- `tools/mcp/`：第七个域，**不在**标准包里，由应用层按需装配。
- `docs/`：当前说明与演进蓝图，入口是 `docs/README.md`。

依赖必须维持：

```text
agent-ai ← agent-core ← {tools-*、能力包} ← app
```

`agent-core` 不得反向依赖任何具体 `tools-*` 包，也不依赖 React，**也不得依赖 `host-node`**——
host-node 是命令桥的一种实现，core 反过来引它等于把「宿主是什么」重新焊回 core。
这三条由 `pnpm check:boundaries` 判。

`agent-core/src` 的分区：`runtime/`（主循环、命令与到点分派）、`runtime/core/`（`CoreInstance`、
plugin host、loop hooks、默认插件）、`state/`（atom、writer、persistence contract）、`execution/`
（执行图）、`planning/` 与 `skills/`（契约）、`subagents/`（子 run 机制与委派协议）、`timeline/`、
`observability/`（port 与纯逻辑）、`tools/`（抽象与 registry，不含具体工具）。

## 状态与 UI 边界

默认运行时使用一个 `defaultCore`。每个 `CoreInstance` 私有持有 root/session store、工具与
abort registry、运行时配置、plugin host、观测 port 与 persistence bridge；`createCore()` 创建隔离
实例。`projectSkillsProvider`、`planRuntime`、`delegation` 与观测 port 由装配层按槽注入，持久化
driver 由宿主配置 bridge。默认实例本身不自动安装工具，应用和测试入口负责调用
`registerStandardTools`。

- **界面一个 store，agent 那边是 core 自己的两个**：
  - **界面 store**（`apps/web/src/uiStore.ts`，全局唯一，不按会话分桶）—— 设置面板、MCP、插件、
    trace viewer、工作区重命名草稿、消息滑动窗口、展开折叠、输入框草稿与图片附件。刷新即丢。
  - **core 的 root store** —— 只放跨会话状态：工作区、会话元数据、当前会话 ID。
  - **core 的 per-session agent store** —— items、run、plan、执行图等会话状态，进恢复快照与事务日志。
- **einfach 只有一个 `StoreContext`**，`<Provider store>` 嵌套只能覆盖不能并存。所以**环境 store
  给界面**（`main.tsx` 应用根绑一次），core 的两个各走自己的 Provider（`RootStoreProvider` /
  `AgentStoreProvider`），读用 `useRootAtomValue` / `useAgentAtomValue`
  （`packages/agent-react/src/coreStoreBindings.tsx`）。方向是刻意的：漏改一处的后果是
  「core atom 从界面 store 读到默认值」，会话列表/消息列表当场空掉、dev 里一眼可见；反过来
  （环境给 core）漏改一处是「新写的界面 atom 落进 core 的 store」，行为与拆分前一模一样、
  毫无症状，等于没拆。**响亮地失败优于静默地正确。**
- **derived 不能跨 store**：einfach 的派生只在一个 store 里取 `get`，所以一张派生图上的所有 atom
  必须同住一处。两个实例：`@einfach-agent/subagents` 的视图 atom 整族住 agent store
  （`subagentTreesAtom` 从 `executionGraphAtom` / `itemsAtom` 派生，写入命令本来也写
  `getSessionStore(id).store`）；`plugins/initialize.ts` 的 `pluginWorkspaceRootAtom` 从两个 root atom
  派生，只能在 core 的 root store 上求值。放错 store 不报错，只是恒读到默认值。
- **界面 store 不按会话分桶**，所以「用户正在输入的东西」必须在切会话时显式清掉，否则会话 A 打
  一半的字会跟着切到 B（`agentNew/ui/sessionScopedViewState.ts`，由 `ActiveSessionProvider` 调用）。
  刻意不做成按 sessionId 分桶的 atom family —— 那等于把「每会话一个 store」换个写法再做一遍。
- UI 只允许读取 atom、调用 `runtime/commands.ts` 暴露的命令。
- UI 不直接调用 writer、不 setter 业务 atom、不持有 runtime store。
- writer 和 await 后回写必须保留 ghost guard、runId stale guard 与 AbortSignal 检查。
- **derived 的 read fn 必须是纯函数**：禁读时钟、随机数、全局可变量，禁做 IO，输入只能来自 `get`。
  恢复是「从快照重放」，重放要能得出同样的结果；违反后 undo 重算出的派生值与原来不一致，
  且**全程不报错**。需要「当前时间」时把它做成 primitive atom，由 command 层在写入时取值。
- **会话 atom 的写入必须收口**在 core 的 `state/`（writer）与 `runtime/commands/`，或登记为所有者模块。
  事务日志需要每次写入都留下 `(key, prev, next)`，而显式声明是唯一可行解——自动捕获要给每个被追踪
  atom 常驻订阅和基线值，成本 O(被追踪 atom 数)，在 family 场景下不成立。绕过它的写入不进日志，
  undo 越过时该 atom 停在新值、其余全部回滚，状态自相矛盾且只在 undo/崩溃恢复时才浮出来。
  **这条管整个仓库，不只是 core**，且认的是**会话 atom 全集**而不只是槽位：门禁早一版只扫
  `packages/agent-core/src`，渲染层可以直接写入账槽位而无人知晓；再早一版按名字只认槽位，于是
  应用层从 barrel 拿到 `withdrawnTurnNoticeAtom` / `contextStatsAtom` 就地 `useSetAtom` 也照样放行
  ——而规则声称的是「会话 atom 的写入必须收口」，不是「槽位的写入」。UI 要改会话状态只能走
  commands（这两处已分别改走 `dismissWithdrawnTurnNotice` / `applyRecoveredCacheTotals`）。
  作用域不含 root store 的跨会话登记表与 `apps/web` 的 mcp/settings/plugins atom——它们不是会话状态。
- **槽位可以只进快照、不入账**（`slotJournalShape.js` 的 `snapshotOnly`，**当前为空**）。这一类给
  「必须刷新后还原、但按轮记账没有意义」的槽位留位置。唯一的成员曾是 `composerDraft`，它已随
  UI store 拆分离开会话状态：草稿刷新即丢是明确裁决，而它当年进快照的理由（「回退会把用户原话从
  items 截断再放回输入框，那一刻草稿是唯一副本」）在实现里根本不存在——`rollbackPlanStage` 只截断
  items 并立一条提示，从不回写草稿。
- **进日志的值不许随累积状态长大**。整值记账（`writeSlot` 存 `(before, after)` 两份完整槽位值）
  只适用于有界的槽位。对随对话/会话增长、且条目自带载荷的槽位，开销是 `cap × 累积长度`——**二次**。
  内存里看不出来（新旧数组共享条目引用），但 JSON / structuredClone 不认共享引用、会把每个都
  展开成完整副本，**落盘那一步才兑现**：实测 `items` 一份 0.32 MB 的对话要写 33 MB。
  这类槽位改走增量 op（`state/listSlotLog.ts` 的 append/patch/remove、`executionGraphSlotLog.ts`
  的节点粒度），并配一条「同一次写入在长短两种累积量下的 ops 载荷逐字节相等」的测试。
- **不在槽位表里的会话 atom 必须说得出凭什么能重建**。`SESSION_SLOTS` 是「一个会话的完整状态」的
  穷举表，新增一个会话 atom 却不登记进去时，它只是不进快照、不进账，**静默缺席**——刷新后会话少
  一块内容，而且不报错。三类正当归宿（恢复树红线 10）：能从别处**算回来**、有**明确的补偿设计**、
  **刷新即恢复安全默认**；说不出机制 = 缺口，不是设计。门禁另收第四类 `knownLoss`（已知缺口、接受
  丢失）——它不是第四种正当归宿，而是给「已裁决先不修」一个有名字的去处，否则唯一的落法就是编一句
  理由塞进前三类。

上面最后四条、加上「会话 atom 只能从 agent store 读」，共**五条**由 `pnpm check:state` 机械判定，
CI 里排在 `check:boundaries` 之后。入口是 `scripts/check-state-invariants.js`（只做装配），五条判据
各住 `scripts/state-invariants/` 下一个模块，**表和理由都在那里，不在入口**：`derivedPurity.js` /
`writeChokepoint.js` / `slotJournalShape.js` / `atomDisposition.js`（规则 4 的登记表另住
`atomDispositionTable.js`：判定与账分开，改 atom 的人只需要读表）/ `agentStoreBinding.js`。

**规则 5**：core 之外，任何从 `@einfach-agent/core` import 进来、且在 core 的 atom 枚举面里的标识符
（规则 4 的会话 atom 全集 + `rootAtoms.ts` 的跨会话登记表），都不许出现在裸 `useAtomValue` /
`useAtom` / `useSetAtom` 里——那读的是环境 store（界面 store），拿到的是该 atom 的**默认值**，
组件照常渲染一份空状态、不抛异常。会话的读 `useAgentAtomValue`、跨会话的读 `useRootAtomValue`，
写一律走命令。

前两条逐行扫源码；第三条走**穷举分类**——`SESSION_SLOTS` 的每个 key 必须恰好落在
`slotJournalShape.js` 的 `deltaJournaled`（走增量 op）/ `boundedWholeValue`（整值记账，每项须写明
凭什么不随累积状态长大）/ `snapshotOnly`（进快照不入账）之一，漏分类、陈旧条目、一键两表都是
error；登记为增量的还会回到 `sessionSlots.ts` 源码确认那次 `slot(...)` 真的传了第 4 个参数
（registrar），免得「表说走增量、实际仍是整值」这种漂移静默复发。载荷体量本身仍靠 colocated 测试盯
（「同一次写入在长短两种累积量下的 ops 载荷逐字节相等」）。

第四条把同一套穷举思路往外推一层：`state/sessionAtoms.ts`、`state/sessionTransientAtoms.ts`、
`state/subagentContinuationAtoms.ts` 与 `execution/graph.ts` 里的**每一个 atom** 必须恰好落在
`atomDispositionTable.js` 的 `slot` / `derived` / `recomputable` / `compensated` / `safeDefault` /
`knownLoss` 之一，后四类每项还要写一句**指得出代码位置**的理由。未分类、陈旧条目、一 atom 两表都是
error；`slot` 与 `SESSION_SLOTS` 是**双向**比对（表说是槽位而槽位表里没有、或反过来，都 error），
`derived` 会回源码确认确实是 `atom((get) => …)` 形态——把 primitive 登记成 derived 是最省事的蒙混，
而 primitive 有写入面、丢了就是真丢。规则 3 保的是「已在槽位表里的都被想过记账形态」，
规则 4 保的是「该进槽位表的没漏」。

枚举面**自身**也不许悄悄过期：core 里任何含 atom 声明的文件，要么在 `sessionAtomSource.js` 的
`SESSION_ATOM_FILES` 里，要么在 `CORE_NON_SESSION_ATOM_FILES` 里写明凭什么不是会话状态
（当前三条：root store 的跨会话表、`sessionHistory` 的派生只读视图、`recoveryProjection` 的两个
命令 atom）。新开一个 `state/fooAtom.ts` 而不登记直接 error——否则「静默缺席」只是换个层级复发。

**治理边界按「是不是会话状态」划。** 拆分之前这条容易搞反，因为界面根本没有自己的 store：
`main.tsx` 拿 `core.rootStore` 当环境 store，于是 mcp/settings/plugins/traceViewer 那几十个 atom 物理上
住在 core 的跨会话登记表里；右栏又被切到会话 store，于是消息窗口、草稿、图片附件住在**会话** store 里。
两处都是「渲染层随手 `useAtom`，值落在 core 的某个 store 上」，而那从不构成把它们纳入恢复契约的
理由——判据一直是「这份内容除了它自己还活在哪里」。

拆分之后判据与 store 归属**重合**了：界面的住界面 store，core 的住 core 的 store，"这是不是会话状态"
由它住哪个 store 回答，不再需要一张手工表解释「这个其实是界面的」。规则 4 的 `safeDefault` 因此从
7 条掉到 3 条（掉的四条全是展开/折叠偏好，理由清一色「不含任何内容」——那不是归宿，是它们本就
不该在 core 里），`workspaceRenameStateAtom` 也从 `rootAtoms.ts` 搬进了 `apps/web`。
`apps/web` 的 atom 仍不在规则 4 的枚举面内，现在的理由是物理的：它们不在 core 的任何一个 store 里。

规则 2 只管**会话 atom**（会进 per-session 事务日志的那些）；root store 的跨会话登记表、应用层与
子 Agent 视图 atom 都在管辖之外。`writeChokepoint.js` 里两张表分工不同：**所有者模块**是按设计拥有
某个 atom 写入权的模块，**欠债表**是该收口而未收口的，当前两张都是空的。

所有者模块表有一条硬约束，脚本会判：**它不能豁免 `SESSION_SLOTS` 里的 atom**。曾经
`executionGraphAtom` 与 `subagentContinuationsAtom` 登记在里面，理由写的是「接事务日志时它们就是
被 transaction 包住的那一层」——接上之后没人回来兑现，于是那两个槽位从未入账，撤销一轮只退了
一部分状态。现在槽位名从 `state/sessionSlots.ts` 源码抽出来机械比对，命中即 error。

## 运行链路

`sendMessage` 创建 run，经 `modelRun.ts` 的稳定入口进入 `runToolLoop.ts` 主循环：

1. 写入用户消息与 running 状态。
2. 组装 system prompt、上下文、工具摘要和 `request_tool_schema`。
3. 模型按需请求完整工具 schema。
4. `callTiming` 非空的工具由 `timedDispatch.ts` 在相应点位执行并投影为 timeline item；九个核心
   时机为 session/run/turn、压缩和子 Agent 的开始/结束，`<domain>:<event>` 由宿主经受限 API 分派。
5. 模型可见工具经 registry 校验后，通过受限 `ToolContext` 执行；普通结果回填并继续循环，ask-user、
   计划审批或危险工具确认会暂停。
6. 完成后经 persistence bridge 落盘 `RecoverySnapshotV1` 与会话元数据。

供应商私有请求和重试留在 `packages/agent-ai/`；子 Agent 已按单体循环、批次编排和辅助职责拆分。
主循环已按 lifecycle、bootstrap、循环周期、模型请求和工具执行拆分；`modelRun.ts`
只保留稳定导出，`runToolLoop.ts` 负责循环编排。

压缩、finish reason、loop guard、迁移这些横切行为是 `runtime/core/plugins/` 里的**插件**，
不是主循环里的分支。要改这类行为先看能不能落在插件 hook 上。

工具不得直接 import store/atom 来获得额外能力。文件、shell、计划、渲染、委派等副作用必须使用
`ToolContext` 暴露的能力，确保 workspace confinement、权限确认、stale guard 和审计仍然生效。
完整工具契约见 `packages/agent-core/src/tools/TOOLS-SPEC.md`；标准工具的**实际清单以各域
registrar 为准**（`tools/<domain>/src/index.ts`），文档里的数量容易过时。

## 持久化与运行环境

**宿主只有两态**（`apps/web/src/host/resolveHost.ts`，判定靠 `GET /api/health` 握手，
探测失败或超时一律落 `static`）：

- `server` —— 浏览器 + 本机 Node 后端。会话/历史与 trace 都走 SQLite，执行面是
  `POST /api/invoke/sqlite_*`，库文件由 host-node 的 `sqlite/databasePath.ts` 决定（与 CLI 共用
  同一份）；文件/shell/Git 经 `POST /api/invoke/:command` 打到 host-node。
- `static` —— 纯静态产物，没有后端。不登记命令桥，本机能力工具整类不可见；持久化只剩 IndexedDB。
- 选 driver 的判据是「**这一态有没有 SQL 通路**」，不是「有没有本机能力桥」——持久化与观测两处
  逐字相同的判断，写岔了会得到「写进 SQLite、从 IndexedDB 读」这种两头对不上的装配，它不报错，
  只让 TraceViewer 恒空。唯一有意的不对称在 `static` + DEV：trace 写 IndexedDB 而读取走 Vite 中继
  去读本机那份 SQLite，为的是同机调试时能看见 `pnpm serve` / CLI 写下的 trace。
- **不可逆动作在撤销账本上留屏障**。事务日志能还原的只有状态；跨进程边界发出去的动作还原不了
  （当前只有一处：显式停止 run 时经宿主 disposer 真删 provider 侧的上传）。真的发出过释放时
  `markUndoBarrier` 在当前最新账目上立屏障，越过它的撤销一律拒绝而不是「看起来成功了」。
  撤销自身**永不释放**（withhold）：状态马上要回滚，本来就没有东西真的变成不可达。判据见
  `state/undoBarrier.ts`。
- 每个会话落两份记录：`RecoverySnapshotV1`（运行态的唯一真相）与撤销日志（`HistoryLogDriver`），
  屏障跟着日志走（`PersistedHistoryLog.barrierTxId`）—— 分开存会出现「账在、屏障没了」。
  **两者必须成对**：日志在快照落盘成功的同一时刻整份刷出，并存下那次快照的 `generation`；
  读回时 `generation` 不一致就整份丢弃日志（撤销不可用，状态仍对）。刻意不用 einfach 的
  `HistoryPersistPort` 增量镜像——它逐笔跟随内存，而快照只在耐久性栅栏落盘，两者时点不一致时
  undo 会把更早状态的 `before` 写进当前世界。理由详见 `state/persistence/historyLogDriver.ts`。
- **`runtime: 'server'` 的工具只在登记过宿主命令桥的宿主下进模型清单**——今天等价于「`static`
  态看不见它们」。判据是 `hasHostBridge()`（`modelTurnPrefix.ts` 取值，`turnToolVisibility.ts`
  过滤；同一判据另见 `toolCallGate.ts` 与 `subagents/childToolVisibility.ts`）。**不许退回按宿主
  品牌判**：这条判据早先写的是某个具体宿主的探测函数，于是「有没有本机能力」被焊死成了「是不是
  跑在那一个宿主里」，新宿主接上桥也照样看不到工具。问「登记桥了没有」才是它真正要回答的问题。
  注意 `runtime: 'server'` 与宿主态 `server` **同名但不是一回事**：前者说的是「这个工具要本机
  能力」，后者说的是「当前宿主是哪一态」。
- `.webAgent-archive/` 保存子 Agent 长期归档与索引，不应提交到 Git。
- workspace 里的 `.webAgent/skills/` 与 `.claude/skills/` 是项目 Skills 目录，会被 project skills
  loader 自动扫描进 L1 清单；它们不是用户配置目录。本仓库自己就有这两个目录，改它们等于改运行时
  行为，不只是改编辑器配置。
- **同样这两个目录在用户主目录下也会被扫**（`~/.webAgent/skills/`、`~/.claude/skills/`），进清单时
  前缀是 `user/` 而不是 `project/`。两个作用域各占一个前缀、各算一份 32 个上限，撞名裁决只在同一
  作用域内发生。每条条目**自带 `rootPath`**（它的路径相对哪个根），读取必须原样把它传给桥——拿会话
  workspace 去读主目录的文件会被 confinement 挡下，而报错文案指向「路径越界」，与真实原因无关。
  第三种根来自**被符号链接进来的 skill 目录**：桥既不递归进 symlink、也会在 confine 模式下把根外
  链接整条滤掉，所以 loader 只用越界许可**列出**那两个目录，再把每个链接当它自己的根去读
  （`linkedSkillDirScan`；桥这两条语义现由 host-node 的 `workspace/read/listFiles.test.ts` 与
  `workspace/common/resolveWorkspaceRoot.test.ts` 钉住）。主目录由宿主给，两条路径不同：`server`
  宿主经桥的 `get_user_home_dir` 问后端要（core 的 `runtime/userSkillsRoot.ts`），**CLI 不走这条**
  ——它自己就是那台机器，`node:os` 的 `homedir()` 在装配层解析一次，既注入桥的 `homeDir` 槽也直接
  当扫描根，反过来向桥要等于绕一圈问自己、还凭空多出一个会漂移的权威；`static` 没有桥，
  拿到 undefined，只扫工作区。详见
  [docs/project-skills-blueprint.md](docs/project-skills-blueprint.md) 的「作用域」。

## 测试与修改约定

- TypeScript strict 开启；完成修改至少运行相关测试和 `pnpm build`。
- runtime/state 修改优先补充 colocated `*.test.ts(x)`。
- 模型 adapter 的"除 AbortError 外返回 fallback、不向 UI 抛出"是有意契约。
- 新工具放到对应 `tools/<domain>/src/<tool-name>/`，同目录包含实现、说明和测试，
  再由域包 registrar 注册；只加文件不注册 = 模型看不到。
- 用户可见的助手文案保持中文。
- `docs/` 里"当前实现说明"与"演进蓝图"是两类文档：蓝图描述目标形态，不代表 API 已交付，
  引用前必须核对实现和测试。已完成的阶段 PLAN 只保留在 Git 历史中。
- 追调用链、评估改动波及面时可用仓库自带的 CodeGraph 索引（`.codegraph/`，见 skill
  `codegraph`）；纯文本检索仍用 grep。
