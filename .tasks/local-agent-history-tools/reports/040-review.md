# 040 独立复审

VERDICT: FAIL

## 结论

六个 owner 的定向测试、TypeScript、boundary、state 与 diff-check 均通过，且文件均不超过 300 行；但实现没有可靠读取既有 archive locator，文件读取上限存在 TOCTOU 缺口，触限时还可能完全丢失 warning。root adapter 也绕过了现有 `RecoveryDriver` 的腐坏语义。因此 040 尚不能进入 done。

## Critical

无。

## Important

1. child discovery 忽略索引中的权威 `archiveBasePath`，用未规范化的逻辑 ID 猜物理目录，既会漏读合法历史，也没有验证索引 locator 与逻辑 target 的绑定。

   - `packages/host-node/src/history/legacyChildHistory.ts:47-53` 只解析 `conversationId/runId/updatedAt`，丢弃实际 run index 的 `archiveBasePath`。
   - `packages/host-node/src/history/legacyChildHistory.ts:124-127` 随后用逻辑 ID 重建目录；`packages/host-node/src/history/legacyChildPath.ts:59-62` 直接把逻辑 ID 当磁盘 segment。
   - 既有 writer 会先规范化 segment：`packages/subagents/src/archive/skillCache.ts:6-13,47-53` 会 trim、替换字符并截到 96 字符。因此例如逻辑 conversation ID `session id` 的真实目录是 `session_id`，当前 adapter 要么在 `assertSegment` 拒绝，要么查错目录。
   - 既有 reader 明确把 `archiveBasePath` 作为 run index 字段并校验固定布局：`packages/subagents/src/state/subagentRunHistoryAtoms.ts:22-47`。040 的自造 fixture 只覆盖逻辑 ID 恰好等于磁盘 segment 的特例（`legacyChildHistory.test.ts:15-24`），不是与真实 writer 对拍。
   - 最小修复：解析并严格校验 index 的 `archiveBasePath`（固定相对布局、conversation/run segment、realpath containment），由该 locator 定位 trace；逻辑 target 仍使用 index 的原始 conversationId/runId。增加含空格、超长或需替换字符的真实格式 fixture，以及 locator/ID 不匹配和 symlink escape 测试。不得回退 cwd 猜测。

2. 2 MiB 与总读取字节上限不是实际 I/O 上限，且发现本身仍可无界分配。

   - `legacyChildHistory.ts:56-61` 先 `stat` 再 `readFile`。文件可在两步之间增长或被替换，`readFile` 会按新文件完整分配；这不满足“单文件最大 2 MiB/总读取硬上限”。
   - `legacyChildHistory.ts:128-136` 用无上限 `readdir` 一次性物化整个 traces 目录，然后才在 `:132` 限制已接受 record 数；大量目录项仍造成无界发现内存/工作量。
   - `legacyChildHistory.ts:122,135-142` 的总量账本依据读取前的 `stat.size`，实际读取与记账不是同一受限操作。
   - 最小修复：使用打开后的同一 file handle 做有界读取（最多 cap+1 字节并核验 file identity/类型），返回实际读取字节；用 `opendir` 迭代并给检查过的目录项也设硬上限。总预算必须在每次读取前扣减并由实际字节结算。

3. 达到发现/字节上限时不保证返回 warning，更没有可续读信号。

   - `legacyChildHistory.ts:137-139` 会把唯一 oversized trace 标为 truncated 并跳过；但 `:147-155` 仅当 `sorted[0]` 存在才附 `OUTPUT_TRUNCATED`。因此“只有一个超限 trace”最终返回空数组且没有任何 warning，调用方无法区分“没有历史”和“被上限截断”。
   - `legacyChildHistory.ts:132` 达到 100 条后继续遍历所有剩余项，只设置布尔值；adapter 合同 `:34-39` 也没有 cursor/continuation，无法兑现任务要求的 warning/cursor。
   - 当前 2 MiB 测试只断言 `undefined`（`legacyChildHistory.test.ts:56-60`），恰好固化了静默丢弃。
   - 最小修复：让 discovery 结果独立携带 warnings/continuation，即使零 records 也能报告截断；命中任一硬上限立即停止。若 cursor 由 060 统一生成，040 至少必须返回明确的 truncated 状态和稳定 continuation key，不能把信号挂在第一条 history 上。

4. 直接注入 `SqlExecutor` 没有复用既有 recovery 读取抽象，并改变了腐坏数据语义。

   - 现有抽象已经提供只读 `RecoveryDriver.listLatest()`：`packages/agent-core/src/state/persistence/recoveryDriver.ts:15-20`；SQLite 实现通过统一 `decodeRow` 检查 row、JSON、session ID 与 generation，腐坏即抛错：`packages/persistence-sqlite/src/sqliteRecoveryDriver.ts:34-48,61-70`。
   - 040 在 `legacyRootHistory.ts:53-61` 复制了一份较弱 decoder，并在任意异常时返回 `undefined`；`:103-106` 静默丢掉该 row。于是相同 `recovery_snapshots` 经 current driver 会暴露 corruption，经 legacy adapter 却伪装成“不存在”。
   - 这也使测试 mock 必须伪造无关写方法（`legacyRootHistory.test.ts:25-29`），而不是证明生产 recovery facade 集成。
   - 最小修复：优先注入 `Pick<RecoveryDriver, 'listLatest' | 'loadLatest'>`（实际只需 `listLatest`），复用 driver 的 schema/codec/错误语义；若装配约束确实只能给 executor，则抽出并复用 SQLite recovery row decoder，腐坏必须抛出，不能 catch 后跳过，并补真实 SQLite 集成测试。任务文字写了注入 `SqlExecutor`，但这并不能推翻仓库已存在的 recovery 抽象与其 fail-loud 语义；当前实现不满足“既有 recovery 抽象”。

## Minor

1. 非 assistant/tool 的合法 trace 被报告为 malformed。

   - `legacyChildHistory.ts:64-72` 把 codec 失败、字段失败、非法时间以及合法但不接收的 role 都折叠成 `undefined`，`:81-82` 一律附 `MALFORMED_LEGACY_RECORD`；测试也把 user 行计为 malformed（`legacyChildHistory.test.ts:32-44`）。
   - 最小修复：解析结果区分 `accepted`、`ignored-role` 与 `malformed`；user/system 等合法但不接入的记录静默跳过，仅真正坏行产生 warning。

2. root targeted search 会重复读取全表，并可能组合两个不同时间点的结果。

   - `legacyRootHistory.ts:129` 对同一 target 连续调用两次 `find`，每次都会执行 `records()` 的全表 SELECT（`:99-111`）。
   - 最小修复：只 await 一次并复用结果。

## 已确认满足

- root 投影保留 recovery conversation entry 的 `item` 对象为 `modelItem`（`legacyRootHistory.ts:67-78`），固定 `status:'legacy'`、`complete:false` 与非 canonical warning（`:18-21,79-91`）；list 的 canonical target key 去重在 `:114-121`。
- child trace 投影只接 assistant/tool，逐行继续处理后续记录，固定 legacy/partial（`legacyChildHistory.ts:64-99`）；没有 workspace locator 时不发现（`:101-110`）。
- 路径入口要求绝对 workspace root，拒绝危险 segment/agentPath，并检查既存祖先 realpath containment（`legacyChildPath.ts:16-18,27-40,48-66`）；未发现 cwd 猜测。
- owners 未调用 SQL execute 或任何文件写 API；测试确认 trace 未改变。六个 owner 行数为 137/56/68/47/175/61。

## 亲自验证

- 定向 Vitest：3 files / 11 tests passed。
- `pnpm exec tsc -b`：passed。
- `pnpm check:boundaries`：passed（仅既有观察项）。
- `pnpm check:state`：passed。
- `git diff --check`：passed。

---

# R1 独立复审

VERDICT: FAIL

## 结论

R1 已实质关闭原 4 个 Important 中的 recovery 抽象、bounded I/O，以及原 2 个 Minor；archive locator 的正常读取与 containment 也已修复。但 continuation 仍不可消费，search 内部面仍丢弃所有 legacy warning/truncation，且 index 的坏 locator 可覆盖同 target 的既有合法记录。因此新增 API 还不能由 060 无损合并。

## Critical

无。

## Important

1. continuation 只有输出，没有恢复输入；oversized trace 的 key 语义还会跳过未返回记录。

   - `legacyChildHistory.ts:39-44` 定义 continuation snapshot/key，但 adapter 的 `listHistories()` 在 `:45-50` 不接 continuation；`discover()` 在 `:119-157` 也始终从 index 第一条、目录第一项重新遍历。060 即使把它铸成公共 cursor，下一页也只能再次命中同一硬上限，无法前进。
   - `legacyChildIndex.ts:15-23,37-78` 同样只输出 continuation，不接受它，也没有核验传回的 `indexSnapshot` 或从 `lastRunKey` 之后恢复。
   - `legacyChildHistory.ts:145-152` 在当前 trace 的 cap+1 probe 触限时，把尚未返回的当前 `key` 当成 `lastRunAgentKey`。若后续按“last key exclusive”实现恢复，会直接跳过该 history；若 inclusive，则同一个 oversized trace 会永久卡住。测试 `legacyChildHistory.test.ts:52-58` 只断言 key 存在，没有证明第二页可继续。
   - 最小修复：给 discovery 增加 continuation 输入；先比对当前 index snapshot，不同则稳定 stale；按明确定义的 resume key 恢复且不重新遍历前缀。区分“最后已消费 key”和“导致截断的 next key”，并增加两页测试，证明第二次调用前进且不重复/遗漏。单个 trace 永久超过 2 MiB 时应明确跳过并推进，同时保留 warning，而不是生成不可越过的 cursor。

2. `search()` 的内部 API 无法把 legacy warning、截断和 continuation 交给 060。

   - child `search` 返回类型仍是裸 `Promise<readonly AgentHistorySearchHit[]>`（`legacyChildHistory.ts:45-50`）。untargeted search 虽调用 `discover()`，却只取 `.records`（`:163-171`），直接丢掉 index malformed warnings、`OUTPUT_TRUNCATED`、`truncated` 与 continuation。
   - targeted search 也只返回 hits；record 上的 `LEGACY_PARTIAL_HISTORY` 和 trace 的 `MALFORMED_LEGACY_RECORD` 不在结果里。root adapter 同样以裸 hits 返回（`legacyRootHistory.ts:32-37,103-113`），丢掉固定 legacy partial warning。
   - 公共 020 R3 明确要求 search result 含 `warnings` 和 `nextCursor`（`packages/agent-core/src/history/historyQuery.ts:136-147`）。060 无法从已丢失的信息恢复这些字段，因此当前“同构内部方法”不可无损合并。
   - 最小修复：让 root/child search 返回 envelope（hits、warnings、truncated、continuation/snapshot），targeted 与 untargeted 都保留 partial/malformed；child search 接受并消费上一项所述 continuation。为零 hits + truncated、targeted malformed trace、root partial 三种场景加契约测试。

3. 后出现的坏 locator 会覆盖同 target 先前的合法 index 记录，不满足坏行隔离。

   - `legacyChildIndex.ts:49-59` 在只检查三个字段为 string 后就按逻辑 key 覆盖 `latest`；locator 的固定布局、normalization binding 与 containment 到 `:61-75` 才校验。
   - 因而同一 conversation/run 先有合法 record、后有 locator mismatch 或 symlink escape record 时，合法 record 已被坏行移除，最终只得到 warning、没有 run。坏行不只是被隔离，而是吞掉了先前可读历史。
   - 最小修复：逐行完成 locator 校验后才参与 latest-wins，或在 latest 候选从新到旧选择第一条合法记录；增加“valid 后跟 invalid 同 key，仍返回 valid 且附 warning”的测试。

## Minor

无新增 Minor。

## 原 findings 关闭证明

- 原 Important 1（archive locator）：正常路径已关闭。index 保留 `archiveBasePath` 并以原逻辑 ID 的 writer normalization 校验（`legacyChildIndex.ts:61-75`、`legacyChildPath.ts:7-10,44-58`）；targeted load 必须先 `findLegacyRun` 命中 index（`legacyChildHistory.ts:112-117`）；index/run/trace 既存祖先均做 realpath containment（`legacyChildPath.ts:17-41,55-70`）。测试覆盖 normalization、binding、targeted absence 与 index/run symlink escape（`legacyChildPath.test.ts:18-40`、`legacyChildIndex.test.ts:27-43`、`legacyChildHistory.test.ts:71-79`）。上述同 key 坏记录覆盖仍是残余缺口。
- 原 Important 2（硬读取上限）：关闭。`legacyBoundedFile.ts:9-38` 在同一 file handle 上 stat/read cap+1/stat，最多分配并读取 cap+1，返回实际 `bytesRead`；discovery 从 index 实际字节开始记账，为 probe byte 预留预算（`legacyChildHistory.ts:126-150`）。目录使用 `opendir`，检查第 257 项时立即 return（`:129-139`），不再全量 `readdir`。
- 原 Important 3（零记录触限信号）：零记录 warning 已关闭，oversized index/trace 都返回独立 envelope（`legacyChildIndex.ts:42-47`、`legacyChildHistory.ts:119-125,176-184`），测试覆盖两类零记录场景。continuation 可消费性未关闭，见 Important 1。
- 原 Important 4（RecoveryDriver）：关闭。root 只注入 `Pick<RecoveryDriver,'listLatest'>` 并直接传播异常（`legacyRootHistory.ts:81-84`）；测试证明 fail-loud（`legacyRootHistory.test.ts:36-41`）。
- 原 Minor 1（ignored role）：关闭。parser 显式区分 accepted/ignored/malformed，只有 malformed 加 warning（`legacyChildHistory.ts:52-78`）；测试中 user/system 不再计坏行（`legacyChildHistory.test.ts:35-47`）。
- 原 Minor 2（single read search）：关闭。targeted root search 只 await 一次 `find`（`legacyRootHistory.ts:103-108`），mock call count 覆盖（`legacyRootHistory.test.ts:23-30`）。
- 020 R3 对齐：root/child history 的 `itemCount` 等于投影出的非删除 items 数，所有 legacy item 都是 `materialized:true`（`legacyRootHistory.ts:45-73`、`legacyChildHistory.ts:68-95`），与 `historyQuery.ts:45-88` 一致。

## R1 亲自验证

- 定向 Vitest：5 files / 13 tests passed。
- `pnpm exec tsc -b`：仅报 030 owner `packages/host-node/src/rollout/queryRepository.test.ts` 当前缺少并行修改中的模块及隐式 any；040 十个 owners 无 TypeScript 错误。
- 十个 owners 行数：115/42/71/41/39/26/91/54/184/80，全部 `<=300`。

---

# R2 独立复审

VERDICT: FAIL

## 结论

R1 的 search envelope 与 locator latest-wins 两项已经关闭；continuation 的 snapshot stale、exclusive trace 恢复、oversized consumed 以及 100+1 histories 也已实现。但目录检查项硬上限仍无法恢复：首次在处理任何 trace 前截断，continuation 没有目录项位置，下一页会从头重复并再次截断。因此 R1 Important 1 尚未完全关闭。

## Critical

无。

## Important

1. directory-entry cap 生成的 continuation 不前进，且恢复页仍重复处理同一目录前缀。

   - `legacyChildHistory.ts:137-146` 先把整个目录的合格名字收集到 `names`，检查到第 257 个 entry 时立即在 `:142-144` 返回；此时尚未进入 `:147-162` 的 trace 循环，所以 `lastKey` 仍是输入 continuation（首轮为空），没有记录任何目录枚举进度。
   - 下一次 `listHistories(first.continuation)` 会在 `:128-140` 把 `checked` 重置为 0，并重新从同一目录第一项开始；相同 257 个 entry 会再次在同一点返回。`lastRunAgentKey` 只能描述已消费 trace，无法描述被计入硬 cap 的非 trace entry 或尚未处理的文件名。
   - 当前测试 `legacyChildHistory.test.ts:116-123` 只断言第一页 truncated，没有尝试恢复，因而没有覆盖该永久循环。相比之下，oversized 与 100+1 trace 的两页测试只在目录总 entry 数未超过 256 时通过（`:65-92`）。
   - 这也不满足“恢复跳过前缀处理”：即使 continuation 位于同一 run，`:137-146` 仍会枚举并计数全部较早目录项，之后才在 `:153-154` 跳过已消费 agent。若目录本身超过 256 项，任何 continuation 都无法越过前缀。
   - 最小修复：按稳定 entry 顺序流式消费目录，并把“最后已检查目录 entry”纳入 continuation，或建立同等有界且可恢复的稳定枚举页；恢复时在计入本页 `checked` 前 exclusive 跳过前缀。增加 257+ entries 的两页测试（包含大量非 trace 项和后续合法 trace），证明第二页前进、无重复遗漏，并证明每页检查项/文件实际字节硬 cap 独立成立。

## Minor

无新增 Minor。

## R1 三项复核

- continuation：部分关闭。`LegacyHistoryContinuation` 明确 last-consumed/exclusive（`legacyHistoryQuery.ts:7-18`）；正常 index snapshot 含 bounded 内容 SHA-256（`legacyChildIndex.ts:10-12,83-86`），恢复在读取 trace 前校验并稳定抛 `AGENT_HISTORY_CURSOR_STALE`（`legacyChildHistory.ts:120-134`）。已消费 oversized trace 的 key 会让下一页跳到后续 trace（`:151-161`），100+1 traces 无重复遗漏测试通过。但 directory-entry cap 仍阻塞，见 Important 1。
- search envelope：关闭。root targeted/untargeted 均返回 `LegacyHistorySearchResult` 并汇集 partial warning（`legacyRootHistory.ts:32-36,103-114`）；child targeted 汇集 record partial/malformed，untargeted 保留 page truncated/continuation/index warnings（`legacyChildHistory.ts:172-186`）。共享类型 `legacyHistoryQuery.ts:13-25` 明确暴露 records/hits、warnings、truncated、continuation，060 可据此合并并铸造公共 cursor。
- locator latest-wins：关闭。`legacyChildIndex.ts:59-80` 每行先解析字段、校验 normalization binding 与 realpath containment，只有成功后才 `latest.set`；后置坏 locator 只加 warning，不覆盖前置合法记录。对应 valid+invalid same-key 测试在 `legacyChildIndex.test.ts:46-55`。

## R2 亲自验证

- 定向 Vitest：5 files / 18 tests passed。
- `pnpm exec tsc -b`：passed。
- `pnpm check:boundaries`：passed（仅既有观察项）。
- `pnpm check:state`：passed。
- owner/report `git diff --check`：passed。
- 11 个 owners 均 `<=300` 行，最高 `legacyChildHistory.ts` 206 行。

---

# R3 独立复审

VERDICT: PASS

## 结论

R2 最后一项 Important 已关闭。directory continuation 现在绑定 run、exclusive checked offset 与目录 snapshot；恢复先跳过已检查前缀，再开始本页检查项计数。301 个实际目录项可跨页结束且 trace 无重复遗漏，目录改变或消失会 stale。未发现 Critical、Important 或 Minor 新问题。

## Findings

### Critical

无。

### Important

无。

### Minor

无。

## 最后一项关闭证明

- continuation 类型包含 `directory.runKey/checkedOffset/snapshot`（`legacyHistoryQuery.ts:7-16`），目录 snapshot 不同稳定抛 `AGENT_HISTORY_CURSOR_STALE`（`:25-29`）。
- discovery 先用 index snapshot 拒绝 stale，再按 run key 跳过更早 run（`legacyChildHistory.ts:121-142`）；目标目录消失在 `:143-150` 转成 stale，存在时在打开枚举前核对 snapshot（`:151-155`）。
- 枚举 offset 在每个 entry 到达时推进；恢复前缀通过 `offset <= checkedOffset` 直接 continue，发生在本页 `checked += 1` 之前（`:156-165`）。因此旧前缀不消耗新页 256 项配额。
- 非 trace entry 在分类完成后保存当前 offset（`:166-171`）；trace 在 bounded read 后更新 last-consumed key，oversized 同时保存当前 offset（`:173-185`）。record/byte cap 在消费下一项之前保存 `offset - 1`（`:161-164`），不会把未处理项标成已消费。
- 跨页测试创建原 fixture trace 加 300 个目录项，其中 4 个新增 trace；第一页精确停在 offset 256，第二页结束，合并后 5 个 agent 无重复遗漏（`legacyChildHistory.test.ts:116-134`）。目录新增后的旧 continuation stale 在 `:136-145` 覆盖；目录删除由生产分支 `legacyChildHistory.ts:145-148` 明确处理。
- 原 record cap 与 oversized 组合未回退：100+1 traces 两页仍无重复遗漏（`legacyChildHistory.test.ts:79-92`），oversized trace 被消费后下一页读到后续 trace（`:65-77`）。每页实际文件读取仍从 index bytes 重新建立 8 MiB 预算，trace 继续走同 handle cap+1；跳过的目录前缀不读取 trace 文件。

## R2 快速回归

- search 的 root partial、child targeted partial/malformed、untargeted truncated/continuation envelope 保持不变；对应测试通过。
- child index 仍逐行完成 locator validation 后才 latest-wins；valid + invalid same key 测试通过。
- 11 个 owner 均保持单一职责且 `<=300` 行，最高 `legacyChildHistory.ts` 238 行；`legacyHistoryQuery.ts` 45 行。

## R3 亲自验证

- 定向 Vitest：5 files / 19 tests passed。
- `pnpm check:boundaries`、`pnpm check:state`、owner/report `git diff --check`：passed（boundary 仅既有观察项）。
- `pnpm exec tsc -b`：仅上述 050 test owner 两项错误；040 的 11 个 owners 无 TypeScript 错误。
