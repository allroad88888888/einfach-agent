# 线：持久化与观测 driver 家族

一句话：同一份 core 契约（会话列表 / 恢复快照 / 事务日志 / trace span-event / trace 读取）各有
IndexedDB 与 SQLite 两套零依赖驱动包，由 `apps/web/src/host/resolveHost.ts` 判定的宿主两态在
`main.tsx` 启动时选中并注入。

类型：分支线——挂在主线运行链路的 `apps/web/src/main.tsx:117-125`（启动装配时）与
`packages/agent-core/src/runtime/persistenceBridge.ts` / `packages/agent-core/src/observability/trace.ts`
（运行时被主循环调用时）。

## 入口（一个实例从哪开始；引 file:line）
- 装配入口：`apps/web/src/main.tsx:117`（`core.persistence.configure({...await createHostPersistenceDrivers(host), ...})`）
  与 `main.tsx:124`（`configureHostObservability(host)`）。两处共用同一次 `resolveHost()` 结果
  （`main.tsx:141`），不各自重探宿主。
- 宿主两态判定：`apps/web/src/host/resolveHost.ts`，靠 `GET /api/health` 握手，失败或超时落
  `static`（CLAUDE.md 现行文本 §持久化与运行环境，与代码一致）。

## 数据怎么走（逐步；每步引 file:line）
1. 契约声明——四份纯类型接口，均在 `packages/agent-core/src`：
   - `SessionsPersistence`：`state/persistence/contract.ts:4-9`，4 方法
     （saveSessions/loadSessions/saveWorkspaces/loadWorkspaces）。
   - `RecoveryDriver`：`state/persistence/recoveryDriver.ts:15-21`，4 方法
     （listLatest/loadLatest/saveLatest/deleteSession）。
   - `HistoryLogDriver`：`state/persistence/historyLogDriver.ts:47-52`，3 方法
     （load/save/deleteSession）。
   - `TraceDriver`：`observability/types.ts:34-37`，2 方法（writeSpan/writeEvent）。
   - `TraceLogReader`：`observability/logReader.ts:12-15`，1 属性 + 1 方法（source/readAll）。
   四份契约经 `state/persistence/index.ts` 与 `observability/index.ts` 两个 barrel 对外公开，
   是四个 driver 包唯一允许 import 的 core 面。
2. 两套实现各自补齐全部方法（逐个读过，非抽样）：
   - persistence-idb：`sessionsPersistence.ts:58/85/108/132`、`indexedDbRecoveryDriver.ts:89-169`、
     `indexedDbHistoryLogDriver.ts:72/86/100`。
   - persistence-sqlite：`sqliteSessionsPersistence.ts:49/97/118/149`、`sqliteRecoveryDriver.ts:61-118`、
     `sqliteHistoryLogDriver.ts:48/59/69`。
   - observability-idb：`indexedDbLogDriver.ts:57-66`、`indexedDbLogReader.ts:48-69`。
   - observability-sqlite：`sqliteLogDriver.ts:31-76`、`sqliteLogReader.ts:126-156`，另有一个
     契约之外的第三实现 `devSqliteLogReader.ts`（见下「加一个」与「其实合规」）。
3. 宿主选型——两处**逐字同构**的判据「这一态有没有 SQL 通路」：
   - 持久化：`apps/web/src/persistence/persistenceDrivers.ts:64-75`，`host.kind === 'server'` 时
     `await import('@einfach-agent/persistence-sqlite')` 并 `configureSqlExecutor(loadExecutor)`
     （:23-36），否则退回 idb 三件套（:71-75）。
   - 观测：`apps/web/src/host/hostObservability.ts:34-39`（`traceSqlExecutorLoader`）与
     `:62-77`（`configureHostObservability`）；`static + DEV` 有一条**有意不对称**分支
     （:69-74）：写 IndexedDB、读走 `createDevSqliteLogReader()` 经 Vite 中继读本机 SQLite，
     便于同机看 `pnpm serve`/CLI 写下的 trace。
4. 执行面注入——两个 SQLite 包各自持有**互不相干**的模块级 loader，同一物理库文件上的两条
   逻辑连接：`persistence-sqlite/src/sqliteShared.ts:36-39`（`configureSqlExecutor`）与
   `observability-sqlite/src/sqliteLogTransport.ts:48-52`（`configureTraceSqlExecutor`，故意
   不同名，理由见该文件 :8-13）。两者都是惰性 + memoized、未注册即 reject（不给兜底）。
5. core 内部消费点：
   - `packages/agent-core/src/runtime/persistenceBridge.ts:52-66`（`PersistenceBridge` 接口）、
     `:89-101`（`configure` 收四个依赖）、`:119-179`（`persistSessions`/`persistWorkspaces`/
     `persistDeleteSession`/`persistRecovery` 四个写入口，全部 fire-and-forget 或显式 facade）。
   - `packages/agent-core/src/observability/trace.ts` 的 `configureObservability` 收
     `{ driver: TraceDriver }`，运行时经 `ObservabilityPort` 的 `startSpan`/`endSpan`/`addEvent`
     调用 driver（`observability/port.ts:38-65`）。
6. 结果去哪：会话列表/恢复快照/事务日志落各自 driver；trace span/event 落 `TraceDriver`，
   TraceViewer 经 `TraceLogReader.readAll()` 读回（`traceViewer/` 消费 `createTraceLogReader()`）。

## 每部分负责什么 / 状态归谁 / 谁能调谁
| 部分 | 职责 | 持有的状态 | 谁可以调它 | 不许做 |
|---|---|---|---|---|
| core 契约（`state/persistence/*`、`observability/{types,logReader}.ts`） | 定义方法签名与零依赖内存参考实现 | 无（纯类型 + `createMemory*` 用于测试/CLI） | 四个 driver 包、`apps/cli` | 不认识任何具体存储 API |
| `persistence-idb` / `persistence-sqlite` | 实现 SessionsPersistence/RecoveryDriver/HistoryLogDriver | 各自的 IDB 数据库 / SQLite 表 | `apps/web/src/persistence/persistenceDrivers.ts` | 不做宿主判定、不互相 import |
| `observability-idb` / `observability-sqlite` | 实现 TraceDriver/TraceLogReader | 各自的 trace 表 | `apps/web/src/host/hostObservability.ts` | 不做宿主判定；sqlite 允许反向依赖 idb（见下） |
| `persistenceBridge.ts` | 把 atom 快照转成 driver 调用，串行化+CAS+屏障配对 | 每会话写队列状态（`SessionWriteState`） | `main.tsx` 装配、`commands/`、`modelRun.ts` | 不直接碰 IDB/SQLite API |
| `trace.ts`（`ObservabilityPort`） | 把 span/event 生命周期转成 driver 调用 | `activeSpans` Map | 主循环各时机点位 | 不阻塞主流程（best-effort） |

## 形状（分支线：目录/文件形状 + 计数；必需 vs 可选）
- 成员 4 个（git 跟踪），均在 `packages/`：`persistence-idb`（12 个 tracked 文件）、
  `persistence-sqlite`（16 个）、`observability-idb`（8 个）、`observability-sqlite`（22 个）。
- 精确共同形状（4/4）：`package.json`、`README.md`、`src/index.ts`、`tsconfig.json`、
  `tsconfig.build.json`、`tsup.config.ts`。`tsconfig.{json,build.json}` 在 idb/sqlite 两个
  persistence 包间逐字节相同（`diff` 验证为空）；`tsup.config.ts` 仅文件头包名与「唯一运行时
  依赖」注释不同。
- 持久化一对（idb 4 源文件 / sqlite 5 源文件）与观测一对（idb 2 源文件 / sqlite 5 源文件+1 测试
  专用 harness）不是同一形状，差异在「有没有外部 SQL 执行面」这条轴上，详见下「其实合规」。
- 必需：四份契约方法全部实现（已逐一核对，见上）。可选：`sqlite` 侧独有的 `*Shared.ts` /
  `*Transport.ts`（执行面注入）、`sqliteLogSchema.ts`（表结构+迁移）、`devSqliteLogReader.ts`
  （跨宿主调试读）、`*.atomicity.integration.test.ts`（原子性黑盒契约测试，仅 persistence 一对有）。

## 样板（点名 1–2 个成员 + 为什么：奠基 / 最简 / 最近且干净）
- `persistence-idb`——奠基：`ff2982a`（2026-08-12）是四者中最早的抽取提交，只动
  `apps/web/src/main.tsx`、`docs/assembly-core-issues.md`、`package.json`、`tsconfig.app.json`、
  `vite.config.ts` 五处装配点 + 包内文件，diffstat 干净（11 files）。
- `persistence-sqlite`——最简：`sqliteShared.ts` 把「执行面注入」这条 sqlite 独有的关注点单独
  拆出（T5 单一职责），是新增 sqlite 侧 driver 时最值得抄的隔离方式。

## 加一个（触碰文件；每项标来源：git 配方交集 / 汇合点代码 / 已有清单；不一致处写出）
- `apps/web/src/main.tsx`——来源：配方交集（3 次抽取提交 `ff2982a`/`2f58462`/`37dec4d` 均改它）
  + 汇合点代码核实（:117-125 现仍是唯一装配点）。
- `package.json`（根）——来源：配方交集 + 代码核实（:31-34 四个 workspace 依赖仍在）。
- `vite.config.ts`——来源：配方交集 + 代码核实（:261-264 四条 alias 仍在，`resolve.alias`）。
- `tsconfig.app.json`——来源：配方交集 + 代码核实（:28-31 四条 `paths` 仍在）。
- 新包自身：`package.json`/`README.md`/`src/index.ts`/`tsconfig.json`/`tsconfig.build.json`/
  `tsup.config.ts`——来源：形状统计（4/4 精确共同集）。
- 若新增的是**新存储后端**（而非现有两态的第三选项）：还要改
  `apps/web/src/persistence/persistenceDrivers.ts`（`createHostPersistenceDrivers` 的分支）与/或
  `apps/web/src/host/hostObservability.ts`（`configureHostObservability` 的分支）——来源：
  汇合点代码，不在配方交集里（配方只抓「包新增那一刻」的机械改动，选型分支是后续加宿主态时改的，
  两者不是同一次提交）。
- **不一致处**：配方交集含 `docs/assembly-core-issues.md`，但该文件已被 `d182b17`（"docs: sync
  docs with the assembly core structure and retire the issue tree"）删除，当前 `git ls-files` 里
  不存在。今天「加一个 driver 包」不应再触碰这个文件；若要记录改动意图，落点是 CLAUDE.md 的
  「当前结构」`packages/persistence-{idb,sqlite}/` 一行（`CLAUDE.md:134`）或对应 `docs/`。

## 标准之外
### 另一类（同目录、不同机制）
（无——四个包全部是「同一契约的两套实现」这一种机制，未发现挂着 driver 包名字却干别的事的成员。）

### 漂移 / 遗留（少、晚、不合形状——引用并说明；是「别模仿」不是「删」）
- `packages/persistence-sqlite/src/sqliteDriver.ts:1,9,22-23`、`sqliteShared.ts:7`、
  `sqliteRecoveryDriver.ts:3-4`、`sqliteSessionsPersistence.ts`（文件头历史注释）、
  `observability-sqlite/src/sqliteLogTransport.ts:4-5`、`sqliteLogSchema.ts:5-6`——注释仍写
  「桌面壳注入 Tauri SQL 插件」「tauri-plugin-sql 背后是连接池」。`apps/desktop`（Tauri 桌面壳）
  已被 `e52c31d`（"refactor: remove the desktop app and its host state"，与本次证据核对是
  仓库最近一批提交之一）整体删除，`git ls-files apps/desktop` 为空；当前宿主只有 `server`/
  `static` 两态（`apps/web/src/host/resolveHost.ts`），`server` 态的 SQL 执行面是
  `POST /api/invoke/sqlite_*` 打 host-node，不是 Tauri 插件。这是纯注释性滞后（机制描述过时，
  代码逻辑本身未受影响，因为 P1/P4 已把执行面抽成注入的 `SqlExecutor`，讲哪个宿主提供它对
  driver 包透明）——不是本线的功能性缺口，但下次改这几个文件顺手更新更好，别照抄「Tauri」当
  新宿主的样板。

### 待确认（≤5；只问改变新代码去向的；点名成员；每条两种解释）
1. **`docs/assembly-core-issues.md` 被删后，「加一套 driver」的文档落点该是哪里**
   （`CLAUDE.md:134` vs `docs/README.md` 下某专题文档）：A——就用 `CLAUDE.md`「当前结构」清单
   那一行，改动小、和现状一致；B——`docs/` 下应该有一份专门的「driver 家族如何扩展」说明，
   现在没有算缺口，需要新开。答案决定新增 driver 包时除了代码还要不要新开一份 docs。
2. **observability-sqlite 依赖 observability-idb**（`observability-sqlite/package.json` 的
   `dependencies` 含 `@einfach-agent/observability-idb`，源头是 `devSqliteLogReader.ts:1`
   `import { createIndexedDbLogReader } from '@einfach-agent/observability-idb'` 作 fallback）
   是否是这个家族里唯一允许的跨包依赖先例：A——只在「同一域内 sqlite 需要 idb 兜底」这种场景
   成立，persistence 家族因为没有跨宿主调试读需求，永远不会出现同款依赖，以后也不必比照；
   B——这是一条通用允许模式（sqlite 包可以反向依赖 idb 包做 fallback），以后 persistence 侧
   如果长出类似「DEV 下用 idb 兜底 sqlite 读失败」的功能也可以照做。答案决定新写
   fallback 逻辑时能不能引这个先例。

## 文档与代码不一致处
- 本次任务给出的「已知机械证据」里引用的 CLAUDE.md 文本（"Tauri：会话/历史和 trace 使用
  SQLite，文件/shell/Git 通过 Rust command 执行"）在**当前** `/Volumes/work/ai/web-agent/CLAUDE.md`
  里已不存在（`grep -n "Tauri" CLAUDE.md` 零命中）——该文件已在 `e52c31d` 之后的一串 docs 提交
  （`a6b8546`/`3c42476`/`00f1d95`/`1ee4762`，均在“证据核过”commit 之前）里更新为「宿主只有两态」
  的现行描述（`CLAUDE.md:300-311`），与代码一致。即：CLAUDE.md **本身没有过时**，过时的是本轮
  任务上下文里携带的那份旧文本，只是备忘，不构成需要修复的仓库内不一致。
- 四个 sqlite 侧源文件的历史注释仍描述 Tauri 场景（见上「漂移」一节），与现行 `CLAUDE.md` 和
  `resolveHost.ts` 的两态模型不一致，是真实的仓库内文档（注释）滞后，已按硬规则单列。

## 证据核过：commit `1ebe4a0`，2026-08-20；本次打开文件数：29

## 裁决（2026-08-20，dol）

## 裁决（2026-08-20，dol）

- #1 → **未提交**——合并时按 question-filter 砍掉（driver 家族的文档落点），保持未决。
- #2 → **待答**（questions B6）——负责人问「idb 是啥」，已解释；答案受方向裁决影响，见下。
- **方向裁决（全仓，questions B2 / 本轮追认）**：agent 循环目标跑在**服务端**，前端纯展示，
  tools 与 mcp 的逻辑都在后端。本线正文描述的是**当前**形态，不是目标形态——**本线可能整条作废**：IndexedDB 那套 driver 存在的理由是「浏览器自己存」。前端纯展示后，persistence-idb / observability-idb 是否还需要，要在方向落地时一并定。
