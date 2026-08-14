# Core 可逆历史与 redo 迁移 Issue 树

状态：**规划已冻结，尚未开始实现**。本文件是这项迁移的唯一执行账本；每张卡完成后由主会话
更新状态和证据，执行 agent 不并发修改本文件。

## 目标与裁决

把 `@web-agent/core` 从「完整 checkpoint 快照 + 截断式回退」迁回与
`/Volumes/work/self/einfach-agent-rust` 相同的历史语义：**可序列化的追加日志、单一游标、
按 turn/batch 的 undo、按 `next` 的 redo、不可逆屏障**。

这不是给现有 checkpoint 列表加一个 redo 按钮。当前 `jumpToCheckpoint` 会立即切掉内存中的
未来项，SQLite driver 也物理删除未来行；未来已不存在，无法 redo。迁移后的 checkpoint 只能
是 hydration/压缩优化，不再是历史真相。

不做：选择性 undo；自动撤销外部副作用；本树内的 UI 视觉重做；发布或 schema 无兼容迁移的
一次性破坏切换。

### 已确认事实

- `packages/agent-core/src/state/checkpointWriters.ts` 的 `jumpToCheckpoint`、
  `rewindBeforeCheckpoint` 与 `revertToPlanStageCheckpoint` 都是破坏性截断。
- `packages/agent-core/src/runtime/commands/checkpointCommands.ts` 同时编排 abort、状态恢复、
  持久化删除、browser card 删除和内容回收；历史语义与宿主操作缠在一起。
- `@einfach/core` 的 `createUndoRedo` 用 `WeakMap` 和 atom 身份，不可作为持久化历史方案。
- Rust 参考实现的 `History` 不认识 Store/AtomId；cursor 只产出 entry，applier 批量写回；
  turn 内子 agent 继承 root turn id；undo 前由集成层 bump session epoch。

### 红线

1. 日志 key 必须是稳定的业务逻辑 key，绝不能是 atom 实例/创建顺序/数组下标。
2. 每个变更在写入前捕获 `prev`，与 `next` 一起持久化；不得通过扫描旧日志事后推算。
3. undo 只移动 cursor，不能删除 redo 尾；仅当 cursor 不在栈顶且发生**非空**新写入时，才截掉
   redo 尾，`seq` 仍单调且不复用。
4. history、cursor 不 import Einfach Store、CoreInstance、持久化 driver、浏览器卡片或 UI；
   applier 只经显式 port 批量回写。
5. 一次原子业务写入 = 一条 history entry；entry 内 undo 反序写 `prev`，redo 正序写 `next`。
6. undo 先提升 session epoch，再 abort/拒绝在飞 effect 的陈旧回写；不可逆 entry 是显式
   barrier，不能只在回退后显示提示。
7. 双写期保留 checkpoint 读取兼容，但不得让新路径调用 `truncateAfter`；切换前后均要可恢复。
8. 新增/大改普通文件不超过 300 行；日志状态机或 applier 如确属单一强内聚内核可放宽至 500，
   卡验收必须写出资格理由并运行 `wc -l`。
9. 不使用 `git stash`、不碰本卡外文件、不 broad-stage；每卡只能暂存其列出的明确路径。

## 目标分层

```text
业务 writer ── record(prev,next,logical key) ──> History log + cursor
       │                                               │
       └────────────── live Einfach store <── applier(prev|next)
                                                       │
                         persistence <── entries + cursor + optional snapshot
                                                       │
                   host command <── epoch / abort / barrier / timeline projection
```

建议文件职责（不是预先创建清单；按卡创建）：

| 路径 | 一句话职责 | 上限 |
| --- | --- | --- |
| `src/history/types.ts` | 定义可序列化历史数据形状 | 300 |
| `src/history/log.ts` | 追加 entry 并维护游标与序号 | 500，单一状态机 |
| `src/history/cursor.ts` | 选择 turn/batch 的 undo/redo entry | 500，单一状态机 |
| `src/history/record.ts` | 在写入前组装非空 change | 300 |
| `src/history/apply.ts` | 经 port 以正确顺序批量回写 entry | 300 |
| `src/state/historyKeys.ts` | 定义 session 历史的稳定逻辑 key | 300 |
| `src/state/historyMutation.ts` | 让历史域写入走同一记录入口 | 300 |

## 树与波次

```text
H0 语义裁决与写入盘点（DONE）
└─ H1 可序列化 History log
   ├─ H2 cursor / barrier 状态机
   ├─ H3 record 变更捕获契约
   └─ H4 历史持久化格式与 driver
      └─ H5 session logical key 与 applier
         └─ H6 epoch 与 effect barrier 接线
            └─ H7 对话 turn 双写接线
               ├─ H8 计划阶段与 subagent turn 归一
               └─ H9 undo/redo command 与 timeline 投影
                  └─ H10 主路径切换与旧数据迁移
                     ├─ V1 全链路恢复/分支/并发验证
                     ├─ V2 持久化与产物验证
                     └─ H11 移除 checkpoint 截断实现
                        └─ V3 独立架构审计与交付
```

波次：W0=`H0`；W1=`H1`；W2=`H2/H3/H4`；W3=`H5`；W4=`H6`；W5=`H7`；W6=`H8/H9`；
W7=`H10`；W8=`V1/V2`；W9=`H11`；W10=`V3`。同一现有文件只允许一个 active owner。

## 卡

### H0 · 语义裁决与写入盘点

- **波次 / 依赖 / 状态**：W0 / — / DONE（本树建立时完成）
- **owner / 模型**：主会话 / architecture
- **改动面**：仅本文件。
- **目标**：固定上述红线，盘点现有 checkpoint 与 runtime 路径，排除“checkpoint redo”伪解。
- **非目标**：不创建生产模块、不改现有回退行为。
- **证据**：本文件“已确认事实”、目标分层和逐卡独占面；建树前 `git status --short` 为空。

### H1 · 可序列化 History log

- **波次 / 依赖 / 状态**：W1 / H0 / READY
- **owner / 模型**：待派 / strong（状态机与持久化契约）
- **独占面**：新建 `packages/agent-core/src/history/types.ts`、`log.ts` 及各自 colocated 测试；
  只允许为出口新增最小 `history/index.ts`。不得改 state/runtime/persistence 现有文件。
- **目标**：实现 JSON-safe `Change`、`Entry`、`History`；`append`、单调 `seq`、cursor、空写
  不入日志、undo 后新写才丢 redo 尾并报告 drop event。
- **非目标**：不认识 Einfach、session、turn、工具副作用或 IO；不写 applier。
- **验收**：单测覆盖空 entry、cursor 两侧、redo 尾覆盖与 seq 不复用；
  `pnpm exec vitest run packages/agent-core/src/history` 绿；新增文件逐个 `wc -l` 合规。

### H2 · cursor 与不可逆屏障状态机

- **波次 / 依赖 / 状态**：W2 / H1 / BLOCKED
- **owner / 模型**：待派 / strong（状态机）
- **独占面**：新建 `packages/agent-core/src/history/cursor.ts` 与测试；可只改 H1 已稳定导出，
  不改 `log.ts` 内部实现。
- **目标**：实现 `undoBatch`、`redoBatch`、`undoTurn`、`redoTurn` 与 `Blocked { applied,
  barrierSeq }`；turn 判据由调用方提供，第一条无条件选中。
- **非目标**：不执行写回，不记“已确认越过 barrier”的隐式状态，不做选择性 undo。
- **验收**：多 turn、部分阻断、redo 精确反演、边界 Nothing 均有测试；纯 cursor 测试不创建
  Store；行数若超 300，说明单一状态机资格且不超过 500。

### H3 · 变更捕获契约

- **波次 / 依赖 / 状态**：W2 / H1 / BLOCKED
- **owner / 模型**：待派 / strong
- **独占面**：新建 `packages/agent-core/src/history/record.ts` 与测试。
- **目标**：提供写前捕获 `prev`、过滤 no-op、将一次业务 transaction 收束为一条 entry 的纯工具；
  明确返回值不得被悄悄丢弃的调用约定。
- **非目标**：不自行订阅 atom，不用 WeakMap，不改任何现有 writer。
- **验收**：同一 key 在一个 transaction 内连续写入时，变更顺序足以让 applier 反序回到首值；
  no-op 不损毁 redo 尾；仅依赖 H1 的公开类型。

### H4 · 历史持久化格式与 driver

- **波次 / 依赖 / 状态**：W2 / H1 / BLOCKED
- **owner / 模型**：待派 / strong（schema/恢复）
- **独占面**：新增 reversible-history persistence contract/driver 与相应
  `packages/persistence-{idb,sqlite}/` 实现和测试。不得触碰现有 checkpoint driver 或 hydrate。
- **目标**：持久化完整 entry 序列、cursor、nextSeq 与 schema version；读取旧会话返回“无新历史”
  而非失败；写入必须保留 redo 尾。
- **非目标**：不删除 `checkpoints` 表，不迁移旧数据，不接到真实会话命令。
- **验收**：IDB/SQLite round-trip 保留 cursor 与 redo tail；格式缺失降级可用；相关 driver 测试、
  `pnpm --filter @web-agent/persistence-sqlite build` 和 IDB 包 build 均绿。

### H5 · session logical key 与 applier

- **波次 / 依赖 / 状态**：W3 / H2、H3、H4 / BLOCKED
- **owner / 模型**：待派 / strong（状态边界）
- **独占面**：新建 `src/state/historyKeys.ts`、`historyMutation.ts`、`src/history/apply.ts` 与测试；
  如需入口只改 history barrel。不得改 checkpoint/runtime command 文件。
- **目标**：为 items、plan、context、阶段回退点等**历史域**定义稳定 key 与显式 codec；applier
  通过 port 在一次 Einfach batch 中反序 `prev` / 正序 `next` 回写，保证 derived 只见完整世界。
- **非目标**：不把 run、queue、UI transient 伪装成可 redo 的业务历史；不使用 atom identity。
- **验收**：同 entry 内重复 key 的 undo/redo 往返；未知 key fail-closed；端口可在无 UI 下测试；
  所有 `wc -l` 合规。计划与 root metadata 双份投影的单一真相须在测试中固定。

### H6 · epoch 与 effect barrier 接线

- **波次 / 依赖 / 状态**：W4 / H5 / BLOCKED
- **owner / 模型**：待派 / strong（并发/副作用）
- **独占面**：新建 history runtime integration 模块及其测试；仅可改 session epoch/abort 相关
  runtime 文件，禁止改 checkpoint commands。
- **目标**：undo 前提升 epoch，令迟到 model/tool/evaluator 写回 fail-closed；把工具副作用写入
  entry metadata，并把 `Blocked` 转成需明确确认的运行时事件。
- **非目标**：不尝试反向执行 tool，不以“事后 toast”替代 barrier。
- **验收**：undo 后迟到回写被拒；barrier 前的新变更会正确回退、barrier 本身不越过；确认后的
  第二次操作才可越过；相关 loop/abort 测试绿。

### H7 · 对话 turn 双写接线

- **波次 / 依赖 / 状态**：W5 / H5、H6 / BLOCKED
- **owner / 模型**：待派 / strong（核心集成）
- **独占面**：`sessionWriters`、model run lifecycle、checkpoint commit/update 入口及其测试；
  不改 checkpoint rollback/command/UI 文件。
- **目标**：root turn id 在入口分配，内部 model/tool/subagent 状态写入汇入同一 turn entry；
  双写期仍保留现有 checkpoint 以支持旧 hydrate，但新日志完整记录可回放状态。
- **非目标**：不改用户可见回退命令，不调用 `truncateAfter`，不删除 checkpoint。
- **验收**：一个 root turn 的多次写入 undo/redo 后历史域 primitive 等值；新路径不写物理截断；
  中断/恢复路径不生成幽灵空 entry。

### H8 · 计划阶段与 subagent turn 归一

- **波次 / 依赖 / 状态**：W6 / H7 / BLOCKED
- **owner / 模型**：待派 / strong
- **独占面**：planning stage rollback、subagent runtime 的历史 metadata 接线与测试；不改
  conversation command、持久化或 UI。
- **目标**：计划阶段成为 batch 粒度，不另立一套 snapshot 回退；子 agent entry 继承 root turn id，
  默认 turn undo 能完整覆盖其工作。
- **非目标**：不支持跳过某个子 agent 的选择性 undo，不删除旧阶段 checkpoint。
- **验收**：阶段 redo 能恢复精确状态；子 agent 的多 entry 与 root entry 一次 turn undo/redo
  往返；未闭合 tool call 不会被重放为非法 transcript。

### H9 · undo/redo command 与 timeline 投影

- **波次 / 依赖 / 状态**：W6 / H2、H6、H7 / BLOCKED
- **owner / 模型**：待派 / strong（跨层集成）
- **独占面**：新增 history command 模块、Core public facade、timeline projection 和其测试；
  checkpoint commands 仅允许由本卡调用共用 host cleanup port，禁止修改其旧语义。
- **目标**：暴露按 turn/batch 的 undo/redo、canUndo/canRedo、barrier confirmation；把 abort、
  卡片裁剪、transient 清理放在命令外壳，历史内核保持纯净。
- **非目标**：不直接物理删除 history，不在 UI 组件里读写 session store。
- **验收**：redo 在未发生新写入时可用；新写后 redo 尾消失且诊断可见；核心无 React/浏览器导入；
  command 相关 vitest 与 `node scripts/check-boundaries.js` 绿。

### H10 · 主路径切换与旧数据迁移

- **波次 / 依赖 / 状态**：W7 / H8、H9 / BLOCKED
- **owner / 模型**：待派 / strong（迁移）
- **独占面**：hydrate、persistence bridge、历史命令装配和 migration tests；不删除旧模块。
- **目标**：新会话以 reversible history 为真相；旧 checkpoint 会话继续可读，并在首次新写后以
  明确规则进入新格式；失败时回退到只读 checkpoint，不丢用户数据。
- **非目标**：不在此卡删表或移除旧 API。
- **验收**：新旧会话、包含 redo 尾会话、格式损坏会话均有恢复测试；升级后重启仍可 undo/redo；
  telemetry 能区分 legacy fallback。

### H11 · 移除 checkpoint 截断实现

- **波次 / 依赖 / 状态**：W9 / H10、V1、V2 / BLOCKED
- **owner / 模型**：待派 / strong
- **独占面**：checkpoint rollback writers/commands、旧 HistoryDriver API、SQLite/IDB checkpoint
  清理和相关测试；由单一 owner 串行完成。
- **目标**：删除作为“历史真相”的快照回退、`truncateAfter` 调用和物理截断 schema；保留已批准的
  snapshot compaction/hydration 实现。
- **非目标**：不删用户仍需的 transcript 快照或 archive 功能。
- **验收**：生产源 `rg 'truncateAfter|jumpToCheckpoint|rewindBeforeCheckpoint'` 只剩明确的
  migration tombstone/测试；全仓类型、测试、build、dist smoke 通过；删前后迁移 fixture 可读。

### V1 · 全链路恢复、分支与并发验证

- **波次 / 依赖 / 状态**：W8 / H10 / BLOCKED
- **owner / 模型**：待派 / independent-audit
- **独占面**：只新增独立 integration tests；不改生产实现或既有测试。
- **目标**：按 Rust 验收复核 turn/batch 往返、redo 尾覆盖、barrier、epoch 和 derived 一致性。
- **验收**：undo→redo 所有历史 primitive 逐值相等；连续跨 turn；新写分支；迟到 effect；
  子 agent；计划阶段均有负例与正例。

### V2 · 持久化、产物与性能回归验证

- **波次 / 依赖 / 状态**：W8 / H10 / BLOCKED
- **owner / 模型**：待派 / independent-audit
- **独占面**：只新增/调整验证脚本和黑盒测试；不改 history 生产模块。
- **目标**：确认跨重启日志/cursor/redo tail 完整、包产物可消费、checkpoint 压缩不会重新变成真相。
- **验收**：SQLite 与 IDB round-trip；`pnpm build`、`pnpm check:boundaries`、`pnpm check:dist`
  均绿；给出历史增长与 snapshot compaction 的可比诊断数据。

### V3 · 独立架构审计与交付

- **波次 / 依赖 / 状态**：W10 / H11、V1、V2 / BLOCKED
- **owner / 模型**：待派 / independent-audit
- **独占面**：只读审计，允许更新本文件状态；不改实现。
- **目标**：逐条核验红线、文件职责、公共面与 Rust 语义，而不是只看测试是否绿。
- **验收**：无 `WeakMap`/atom identity 历史键；history/cursor 无 Store/UI/IO import；无现役
  destructive rollback；新增/大改文件行数报告；完整命令与退出码留档。

## 统一交付门禁

每张生产卡至少给出其聚焦 `vitest` 命令、`pnpm --filter @web-agent/core build`、新增/大改文件
的 `wc -l` 输出和 `git diff --check`。切换后必须额外通过：

```sh
pnpm test
pnpm build
pnpm check:boundaries
pnpm check:dist
```

任何卡发现直接 `store.setter` 绕过 H5 的历史域写入，或发现现有 checkpoint 没有覆盖的状态，
应停止扩张改动面、把发现追加到本树，并由主会话拆出独占补卡后再继续。
