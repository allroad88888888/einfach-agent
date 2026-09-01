# 050 独立审查

结论：**REVIEW_FAIL**

审查范围仅限 050 frontmatter 的 9 个 owners；读取了任务 index 与 `050-report.md`，未重跑执行者测试，未修改产品代码，未派子 agent。

## Findings

### Critical

1. append 前 projection reconcile 的失败会阻断 source append，破坏“source 强、projection 最终一致”的核心边界。

   - `service.ts:125-128` 在 `store.append` 前无条件 `await reconcilePath(filePath)`；除 `ENOENT` 外的 schema/SQLite/offset/corruption 错误都会直接 reject，根本不会尝试 durable JSONL append。
   - 只有 source 已成功后的第二次 reconcile 才在 `service.ts:130-135` 被转换为 `projectionWarning`。因此 projection 已处于持续故障或 lag-corruption 状态时，新的合法历史也写不进 source，command 表现成 source failure。
   - 现有 fault test 只让 `afterRecordUpsert` 在 append 后 reconcile 失败，未覆盖“append 前 reconcile 已失败”的真实滞后状态。

2. 未知 item 的 tombstone 被静默丢弃，append-only 原始证据发生不可恢复的数据丢失。

   - `service.ts:82-86` 对 `item_deleted` 在 projection 中查不到 item 时直接返回 `false`；但 projector 明确支持以 deleted-only row 记录未知 item tombstone（`projector.ts:79-88`）。
   - delete 先于 upsert、局部/旧生产者只发送 tombstone、或 projection 缺失对应 item 时，合法 delete mutation 不进入 JSONL。之后即使重建也无法恢复删除事实，且后续 upsert 会把本应删除的 item 复活。
   - “未知”不等于“已经删除”；只有现存 tombstone 且 reason 等价时才可能去重。当前实现把两种状态合并。

### Important

1. idempotence 只覆盖 item upsert/delete，没有覆盖全部 mutation，也没有可靠处理跨进程竞态。

   - `service.ts:88` 对 `session_meta`、`turn_context`、`run_state` 一律保留；同一 root backfill/重试会重复追加这些等价 records，违背 append 前按投影 event/item 状态过滤相同 mutation 的目标。
   - batch 内虽然用临时 item map 模拟 item 状态，却没有对 session/turn/run 做同批状态推进；测试也只断言单个 item。
   - service queue 仅是本 driver 实例内变量（`service.ts:107-112`）。server 与 CLI 两个进程可同时从相同旧 projection 判断“非重复”，随后在 JSONL lock 下依次写入两份等价 mutation；store lock 没有覆盖 reconcile/dedupe 判定。至少需要在 source serialization 边界重新验证，或以 source/event identity 提供可证明的跨进程幂等策略。

2. command 没有在任何 rollout I/O 前严格校验 target、mutation 与 `ModelItem`。

   - `commands.ts:22-25,49-56` 不要求 plain object、不拒绝额外 target keys，也允许空 `conversationId/runId/agentPath`；mutation 同样不做 exact-key 校验，调用方提供的 mutation 自带 `target` 会被静默覆盖，而不是拒绝合同漂移。
   - `commands.ts:71-75` 将 `raw.item` 直接断言为 `ModelItem`；任意有限 JSON（例如 `{ role: 'admin' }`）均可进入 driver。`pending` 的任意非 boolean 值被静默归一为 `false`，不是严格收窄。
   - 公共 codec 已有 exact keys、plain-object、非空字符串、数组/对象/深度上限和完整 ModelItem role/content/tool-call 校验；command 自制校验的上限也与 codec 不一致（对象 10,000 keys 对 256 keys，字符串 1,000,000 对 512 KiB）。非法输入最终可能在 store 已 `mkdir`、获取 lock 后才由 `encodeAgentRolloutRecord` 拒绝（`jsonlStore.ts:128-137`），所以“未知输入在 I/O 前拒绝”不成立。

3. reconcile discovery 过宽，错误结果又丢失 source 身份，无法可靠追踪逐 history 进度/错误。

   - `service.ts:43-59` 递归接受 `rollouts/` 下任意层级、任意名称的 `.jsonl`，没有验证它是否符合 root/child canonical layout。残留、人工备份或其他用途 JSONL 会被当作 rollout source 投影。
   - 任一 source 失败时 `service.ts:145-146` 返回固定 `historyId: ''`、offset 0；调用方无法知道哪个 path/history 失败，也无法把 warning 与其余成功 history 对应。任务要求返回“逐 history 进度/错误”，空 identity 不满足可运维性。

4. host 装配没有注册 rollout flush，且一次 source failure 会使 service `flush()` 永久粘住。

   - `createNodeHostInvoke.ts:135-160` 每张 route table 只创建一个 rollout driver，两条 route 也各注册一次；这一点通过。但 driver 没有通过已有 `registerHostDisposer` 装配 `rolloutDriver.flush()`，进程关停时无法保证本进程 queue 排空。
   - `service.ts:152-155` 先直接等待 `queue`。若任一次 source append reject，`queue` 保持 rejected；flush 在调用 `store.flush()` 前就退出，store 的 failure ledger 不会被清除。以后即使新 append 可通过 `queue.catch(...).then(...)` 正常执行，每次 flush 仍截取当前结果；若没有新 operation 替换 queue，则相同旧失败会永久重复。实现没有测试 source failure 后 flush、第二次 flush 或 disposer 接线。

### Minor

无。

## 验收逐条核对

1. **不通过**：等价 item upsert 的串行用例可去重、实际 update 会追加；但 session/turn/run 不去重，未知 tombstone 被丢弃，跨进程重复判定不原子。
2. **不通过**：source 自身失败会 reject，append 后 projection fault 会返回 warning；但 append 前 reconcile 的 projection failure 会错误阻断 source，未证明 reconcile 后 warning/offset 在该路径恢复。
3. **不通过**：命令名表中 rollout 两条各一次，route table 也各一 handler；批条数/总 JSON bytes 有界。但 target/mutation exact shape 与 ModelItem 未在 I/O 前严格校验。
4. **有执行者证据**：报告称定向 Vitest 3 files / 13 tests 通过；依约未重跑。测试遗漏上述 pre-reconcile fault、全 mutation/unknown tombstone、strict codec parity、discovery error identity 与 flush failure。
5. **有执行者证据**：报告称 host-node build 与 boundaries 通过；依约未重跑。
6. **通过**：service 158 行、service test 64 行、commands 105 行、commands test 44 行、rollout index 3 行；其余 owner 文件也均低于 300 行。service/command/export 基本按职责分离，未发现 `part1`/`xxx2`/大杂烩式拆分。

## 修复门槛

- projection 的 pre-reconcile/dedupe 失败不得阻止合法 source append；返回 source records 加 projection warning，并保留后续 reconcile 能追平的路径。
- 对五类 mutation 做状态等价判定与 batch 内状态推进；未知 tombstone必须持久化。补足跨进程幂等策略，不能只靠进程内 queue。
- command 在调用 driver 前复用或等价实现公共 codec 的 exact-shape、plain-object、非空 target、完整 ModelItem 与统一有界校验；非法输入不得创建目录、SQLite schema 或 lock。
- discovery 只枚举 canonical rollout source，并让每个 warning 带可定位的 history/source identity。
- 将唯一 rollout driver 的 `flush()` 注册到 host disposer；flush 即使 queue/store 曾失败也要结算并清除截止点 failure，补 source failure 后连续 flush 的测试。

---

# R1 复审

结论：**REVIEW_PASS**

本轮仅静态复审更新后的任务、index、执行报告、原 review 与 050 扩展后的 11 个 frontmatter owners；未重跑测试，未修改产品代码，未派子 agent。

## Findings

### Critical

无。原 2 个 Critical 均已关闭。

### Important

无。原 4 个 Important 均已关闭，未发现 R1 引入新的 Critical/Important。

### Minor

无。

## 原 findings 回归

1. **pre-reconcile projection failure 阻断 source：关闭。** service 将 pre-reconcile/dedupe 放进 prepared callback；异常分支返回原 mutations、定位 warning 与同一个 `afterAppend`（`service.ts:133-151`），store 随后仍分配 ordinal、codec 校验并 `fsync` source（`jsonlStore.ts:147-162`）。post-project 自身也把异常收成 warning（`service.ts:135-143`），所以只有 source/lock/codec 写入失败会 reject。测试覆盖连续两次 projection hook failure 后第二次 append 仍有 source record 与 warning（`service.test.ts:104-114`）。

2. **未知 tombstone 丢失：关闭。** 五类状态均从 event records 还原；item upsert/delete 共用 `item:<itemId>` 状态键（`service.ts:36-42,50-70`）。projection 无该 item 时 map 无值，首个 tombstone 必然保留；只有完整 mutation（包括 reason）相等才去重，reason 改变会追加。测试直接覆盖未知 tombstone 首写、同 reason 去重、不同 reason 追加（`service.test.ts:81-88`）。

3. **仅 item 去重、跨进程竞态、batch 状态：关闭。** `mutationKey` 为 session、turn context、item、run state 分别建立当前状态槽，逐条比较后无论保留与否都推进内存状态（`service.ts:36-42,58-69`），因此同批重复五类 mutation 只留第一份。prepared callback 在 target source lock 获取后执行，source append 与 afterAppend 也都在释放该锁前完成（`jsonlStore.ts:139-165`）；独立 driver/process 不能同时基于旧 projection 判断。测试覆盖五类同批推进、双 driver 与两个独立进程完整等价 backfill（`service.test.ts:48-79`），store 测试另证 prepare 观察到串行 source 状态。

4. **strict command / codec parity / no-I/O：关闭。** append/reconcile envelope 先要求 plain object 与 exact keys（`commands.ts:23-35,61-68,81-87`）；每个 mutation 被包装成 synthetic persisted record 后交公共 codec 解码（37-52 行），因此沿用 exact mutation/target fields、非空标识、完整 ModelItem、JSON 深度/数组/对象/单行边界。独立 target 也经同一 codec probe，并逐 mutation 检查完全相同（69-75 行）。这些步骤全部发生在 `driver.append` 前；测试用 fake driver 证明 extra/persisted fields、缺省字段、非法 ModelItem 与 target mismatch 均未触达 driver（`commands.test.ts:46-59`）。

5. **canonical discovery 与错误 identity：关闭。** discovery 只接受 hashed conversation 下的 `root.jsonl` 或完整 hashed run/agent child layout（`service.ts:73-100`）；每个候选首 record 经 codec 解码，并反向用逻辑 target 解析 expected path/historyId 做三方一致性检查（102-116 行）。失败结果保留由 canonical path 推导出的 historyId，warning 同时包含 history 与 source path（30-33、167-169 行）。测试覆盖忽略非 canonical backup 以及 broken canonical source 的可定位 warning（`service.test.ts:116-128`）。

6. **nonsticky flush 与 disposer：关闭。** service tail 无论 operation 成败都归一为 resolved（`service.ts:122-127`），flush 因而总能继续进入 store ledger（175-178 行）；store 对截止 operation 全部 settle、删除已覆盖 failures，再抛一次（`jsonlStore.ts:178-186`）。source failure 后第一次 flush reject、第二次 resolve 已有测试（`service.test.ts:130-137`）。每张 host route table 仅创建一个 driver，并将其 flush 注册一次到已有 disposer（`createNodeHostInvoke.ts:135-142`）；测试确认与 MCP disposer 合计恰为两个且均可执行（`createNodeHostInvoke.test.ts:137-142`）。

## prepared append / failure 推演

- **锁边界：通过。** `mkdir → acquire target lock → prepare → read last ordinal → durable append/fsync → afterAppend → release` 顺序明确（`jsonlStore.ts:143-165`）。同 target 的跨 driver/process dedupe 判定与 source 写入原子串行；不同 target 仍可并行。
- **projection 持续故障：可接受降级。** pre-reconcile 失败时无法证明等价，因此实现宁可将重试再次写成新 ordinal，也不丢 source 证据；post-project mutation/upsert 与后续 reconcile 按 ordinal 幂等，恢复后会收敛。返回的 warning 带 source/history，重复不是静默发生。这符合更新任务明确裁决的“失败时跳过 dedupe 但仍强写 source”。
- **afterAppend：通过。** afterAppend 位于 durable source 之后且仍在 source lock 内；service adapter 捕获 projector throw 并返回 warning，不会把已成功 source 伪装成 append reject。pre-warning 优先保留，确保调用方知道本次曾跳过去重。
- **source failure 连续 flush：通过。** source append reject 进入 store failure ledger；service tail 不粘 reject。第一次 flush 清除截止 failure 后抛出，第二次 flush 没有旧 failure 可再次抛出。

## 验收核对

1. **通过（静态证据）**：五类 mutation、batch 内状态、未知 tombstone、实际 update 与跨 driver/process 等价 backfill 均有实现及测试证据。
2. **通过（静态证据）**：source failure reject；pre/post projection failure 均返回 source success + warning，后续 reconcile 可追平。
3. **通过**：两条 command 在唯一 registry 各一次；严格 codec-parity 校验在 driver/I/O 前完成，总 records/bytes 也有界。
4. **有执行者证据**：报告称定向 Vitest 4 files / 29 tests 通过；依约未重跑。
5. **部分有执行者证据**：host-node build、boundaries、state 均通过；全仓 `tsc -b` 被 070 owner 的未提交测试类型错误阻塞，050 未越 owner 修复。该阻塞不来自本任务 owners，不据此保留 050 finding。
6. **通过**：扩展 owners 全部低于 300 行；最高 `createNodeHostInvoke.ts` 201 行，新增/大改核心最高 `jsonlStore.ts` 189 行。职责拆分清晰，无机械假拆。

---

# R2 复审

结论：**REVIEW_FAIL**

本轮读取了更新后的 050 任务、执行报告、原 review，以及 `080-review.md` 中依赖 050 的 source-corruption fence 与双 rollout service findings；只审查 050 R2 owners 及其保留的 090 source catalog/preflight 依赖。未修改产品代码、未 commit、未派子 agent。

## Findings

### Critical

无。

### Important

1. projector 的错误分类由下层可伪造的 error class 决定，而不是由 I/O / projection 边界决定，仍可把 SQLite/fault 错分 source，或把 source I/O 错分 projection。

   - `projector.ts:36-40` 的 `sourceOperation` 遇到任何既有 `RolloutProjectionError` 会原样抛出；因此 file `open/stat/read/close` 若因 adapter/mock/cause 链直接抛出该 class，最终会被 service 标成 `kind:'projection'`，尽管发生点明确是 source I/O。
   - 对称地，`projector.ts:43-47` 的 `projectionOperation` 遇到既有 `RolloutSourceError` 也会原样抛出。SQLite executor 的 schema/state/catalog/event/item/turn/offset 操作，或公开 fault seam `afterRecordUpsert`，只要抛出 `RolloutSourceError`，就会被 service 标成 fatal source。R2 门明确要求 SQLite 与 afterRecord fault 必须是 projection；错误实例来自可注入 executor/hook，不能当作可信分类权威。
   - 现有测试只让 `afterRecordUpsert` 抛普通 `Error`（`projector.test.ts:149-151`），因此走包装分支并显示为 projection，没有覆盖“相反品牌 error”穿透。分类 wrapper 应由当前 operation boundary 强制归类：source operation 只保留/生成 source，projection operation 只保留/生成 projection，并把原 error 放入 `cause`。

2. 每次 append 都在跨进程 target lock 内从 byte 0 完整扫描永久增长的 JSONL，使单 history 的累计 append 成本为 O(n²)，并把所有同 target writer 的锁等待放大为 O(total history bytes)。

   - `service.ts:115-128` 在 prepared append（已持有 target lock）中无条件调用 `preflightExistingSource`；后者对已存在文件调用 `preflightRolloutSources`（52-60 行）。
   - `sourcePreflight.ts:33-71` 每次从 `position=0/ordinal=0` 读到当时 EOF。source 按架构永久 append-only、没有 compact/总大小上限，因此第 N 次小 append 仍重读前 N-1 次全部历史；N 次写入累计读取量随历史长度二次增长。锁直到 source fsync 与 afterAppend 后才释放（`jsonlStore.ts:143-165`），CLI/server 对同 history 的并发写都会被这次全扫阻塞。
   - chunk buffer 是有界的，只解决内存，不解决总 I/O/锁时长。现有“大文件”测试只证明 store 的 `readLastRecord` 读 bounded tail（`jsonlStore.test.ts:129-146`），没有覆盖 service append 的全量 preflight 成本。
   - source corruption 必须在写前拒绝这一正确性门应保留，但需用可验证的增量完整性状态/validated offset+identity（并检测 truncation/replacement），或把全量审计移出每次 hot append；不能令永久历史的常规 append 越来越慢且长时间占跨进程锁。

### Minor

无。

## R2 重点核验

1. **warning.kind 公共合同与传输：通过。** `AgentRolloutWarning.kind` 是必填 `'source'|'projection'`（`rolloutMutation.ts:73-77`）；append/reconcile 结果沿 core contract、host command 与 server driver 原样传输，不需要解析 message。
2. **常规错误分类：部分通过。** codec、record/path identity、ordinal、offset 倒退、partial/oversize 和普通 fs errors 走 source；普通 schema/SQLite/apply/offset-write/afterRecord errors 走 projection。相反品牌 error 可穿透错误边界，见 Important finding 1。
3. **append source corruption fence：通过。** canonical existing source 在 prepared lock 内、任何 durable JSONL write 前做完整 codec/identity/ordinal/framing preflight；失败直接 reject。测试证明 corrupt 文件字节不增长（`service.test.ts:130-138`）。锁内无 compliant-writer TOCTOU，但全文件扫描有 Important finding 2 的无界成本。
4. **projection pre-fault：通过。** preflight source 正常后，projector/dedupe 的 projection error 返回 `kind:'projection'` warning 和原 mutations；store 仍分配 ordinal、fsync source，再尝试 post-project。测试覆盖连续 projection hook fault 下 durable append（`service.test.ts:104-114`）。
5. **090 catalog/preflight：通过。** service 继续复用 `discoverCanonicalRolloutSources` 与 `preflightRolloutSources`，没有退回任意 `.jsonl` discovery 或只验首行。
6. **injected driver / singleton disposer：通过。** `NodeHostInvokeOptions.agentRolloutDriver` 被 routes 直接复用；无注入时只创建一个默认 Node driver（`createNodeHostInvoke.ts:135-141`），每张 route table 只为该实例登记一次 flush disposer。测试证明 reconcile 命中 injected object 且 flush 只调用一次（`createNodeHostInvoke.test.ts:145-159`）。server 不传注入时仍走原默认创建路径。
7. **flush：通过。** R1 nonsticky tail/store failure ledger 逻辑未回归；source append failure 首次 flush 抛出并清账，连续第二次 flush resolve。

## 验证

- 定向 Vitest：**通过**，4 files / 27 tests。
- `pnpm exec tsc -b`：**通过**。
- `pnpm --filter @einfach-agent/host-node build`：**通过**。
- `pnpm check:boundaries`：**通过**，仅既有豁免观察项。
- `pnpm check:state`：**通过**。
- `git diff --check`：**通过**。
- 行数：15 个 R2 owners 全部 ≤300；最大 `projector.ts` 284 行，其次 `createNodeHostInvoke.ts` 200 行。未发现机械假拆或新增大杂烩。

## 修复门槛

- 让 `sourceOperation` / `projectionOperation` 按执行边界强制分类，即使 cause 已是相反的 rollout error class；增加 SQLite/fault 抛 `RolloutSourceError` 与 source I/O 抛 `RolloutProjectionError` 的回归测试。
- 消除每次 hot append 对完整历史的锁内全量扫描，同时保持 append 前可证明的 source corruption fence、截断/替换检测及跨进程竞态安全。

---

# R3 最终复审

结论：**REVIEW_FAIL**

本轮只审查更新后的 050 task/report、原 R2 review 与 R3 owners；复现 R2 两项 finding，推演 validation cache 全时序，并运行要求的验证。未修改产品代码、未 commit、未派子 agent。

## Findings

### Critical

1. fsync 后的 `afterAppend` source validation/I/O failure 被降级为成功 warning，durability fence 会放行；若 prepare 已有 projection warning，source warning 还会被遮蔽。

   - store 在 durable write + `sync` 后调用 `afterAppend`，随后始终 resolve append result（`jsonlStore.ts:159-162`）。warning 合并使用 `prepared.projectionWarning ?? finalizedWarning`，所以 pre-reconcile 已产生 projection warning 时，后置 `kind:'source'` warning 完全不可见。
   - service 的 `afterAppend` 确实先把 validator plain Error 包装成带 cause 的 `RolloutSourceError`（`service.ts:129-136`），分类本身正确；但外层 catch 将该 fatal source error 转成返回值（143 行），没有 reject。真实的 reopen/stat/read/close failure、刚写 tail 的 framing/identity/ordinal failure都会走此路径。
   - root coordinator 只 `await driver.append(...)`，不检查 append result/warning（`agentRolloutCoordinator.ts:19-24`）；只有 rejection 才会被 recovery writer 转成 `status:'error'` 并阻断执行（`recoveryWriter.ts:131-136`）。当前 Promise resolve 会更新 previous snapshot 并允许下一次模型请求，违反 R2/R3“source fatal、仅 projection 可 warning”的 durability fence。
   - source 已经 fsync 并不改变本次 fence 语义：此时应 reject 并保留已写证据；调用方重试可能形成等价 record，但不能把无法验证的 source 当作成功确认。需要让 afterAppend 的 source error 穿透为 rejection，只把 projection error转成 warning；同时不得让既有 projection warning遮蔽 source fatal。

### Important

无。R2 两项 Important 本身均已关闭。

### Minor

无。

## R2 findings 复现

1. **相反 branded error 强制重分类 + cause：关闭。** `sourceOperation` 只原样保留 `RolloutSourceError`，其他任何错误（包括 `RolloutProjectionError`）均包装为 source；`projectionOperation` 对称地只保留 projection（`projector.ts:38-50`）。测试故意让 executor/fault 抛 `RolloutSourceError`，断言得到 `RolloutProjectionError` 且 `cause` 是原对象；source seam 抛 `RolloutProjectionError`，断言得到 `RolloutSourceError` 且 cause 保留（`projector.test.ts:89-119`）。定向实跑通过。

2. **hot append 不重扫 prefix、另一 driver 只读 tail：关闭。** validation state 保存 dev/ino、byteOffset、nextOrdinal 与 offset 前 128-byte sentinel（`sourcePreflight.ts:14-22`）；previous state 下从 `byteOffset` 开始 chunk validation（94、100-138 行）。service byte observer 对连续 8 次 append、第二 driver append、第一 driver final append累计计数，精确等于最终 JSONL bytes（`service.test.ts:48-62`），证明 chunk validator 没有重复扫描旧 prefix且第一 driver只读取第二 driver新增 tail。定向实跑通过。

## Validation cache 时序审查

- **first/cache miss：通过。** 已存在 source 无 previous 时从 byte 0 全量 codec/identity/ordinal/framing validation并建 state；这是允许的一次 cache rebuild。
- **empty new source：通过。** 正常首次 append 时文件尚不存在，prepare 将 cache 清空并允许 projector ENOENT；durable append 后 `afterAppend` 从 byte 0 验证首批 records并建 cache。已存在的零字节 canonical file被视为 corruption而 fail-closed，不伪装成新 source。
- **dedupe no-write：通过。** prepare 已验证并刷新外部 tail；若 mutations 全被过滤，store 在写前返回，cache仍停在真实 EOF，不需要 afterAppend。
- **afterAppend projection failure：通过 cache 语义。** 新 tail先增量验证并写入 cache（`service.ts:129-138`），再投影；因此 projection fault不会使下次 append回退全扫。其 source failure 被错误降级为 warning，见 Critical finding。
- **cross-driver/process append：通过。** target lock覆盖 prepare、source append、afterAppend；另一合法 writer释放锁后，本 driver用相同 inode +旧 offset验证新增 tail及连续 ordinal。跨进程 dedupe/ordinal测试保持通过。
- **truncate / rename replacement：通过。** size 小于 offset直接拒绝；dev/ino变化拒绝 replacement（`sourcePreflight.ts:100-106`）。测试覆盖两者与 cache-miss 全量重建（`sourcePreflight.test.ts:84-95`）。
- **prefix sentinel：部分检测、按 R3 假设不阻断。** 每次增量验证重读旧 offset前最后128 bytes并比对（73-82行），可检测尾邻域原位改写；同 dev/ino、同 size、且发生在更早 prefix 的原位篡改不会被 hot append发现。显式 reconcile会从 byte 0 全量验证并刷新 cache（`service.ts:171-190`），但两次 reconcile之间存在窗口。这是 append-only、application-owned source 假设下的已知边界：所有合规 writer持同一 lock且只追加，不会做该篡改；按 R3 门不阻断。若威胁模型要求发现任意外部同 inode改写，则需持久 prefix hash/Merkle 状态或全扫，当前 sentinel不够。
- **corrupt partial/oversize tail：通过。** tail仍使用同一 codec、line byte limit、newline framing、canonical identity与next ordinal；partial/oversize在 cache更新及任何下一次 write前拒绝。全量与增量逻辑共用 `validateRolloutSource`，避免规则漂移。
- **explicit reconcile refresh：通过。** 每个 discovered canonical source无 previous做全量 validation并覆盖 cache，再调用 projector；source failure形成 `kind:'source'` history warning，projection failure保持 projection warning。

## 090 API / rebuild 回归

- `preflightRolloutSources` 对外仍返回严格 `{ files, bytes }`（`sourcePreflight.ts:145-156`）；内部 reusable validation state没有泄漏到 090 API。
- 090 定向实跑 `sourcePreflight.test.ts + scripts/agent-rollout-rebuild.test.js`：2 files / 18 tests通过；dry-run/rebuild/source corruption路径未回归。

## 验证

- R3 五文件定向 Vitest：**通过**，5 files / 36 tests。
- 090 定向 Vitest：**通过**，2 files / 18 tests。
- `pnpm exec tsc -b`：**通过**。
- `pnpm --filter @einfach-agent/host-node build`：**通过**。
- `pnpm check:boundaries`：**通过**，仅既有豁免观察项。
- `pnpm check:state`：**通过**。
- `git diff --check`：**通过**。
- 行数：17 个 R3 owners 均 ≤300；最大 `projector.ts` 287 行，service 201 行，sourcePreflight 157 行。职责仍按 store/service/projector/preflight/command/assembly 分离，无机械假拆。

## 修复门槛

- `afterAppend` 的 source validation/I/O error必须 reject append Promise，使 root/child durability fence失败；只有 projection error可以返回 warning。
- source failure不得被已有 `prepared.projectionWarning` 的 `??` 合并遮蔽。增加组合回归：pre-projection warning + durable append + afterAppend source failure，断言 append reject、source bytes已落盘、coordinator不确认 previous state，后续 flush仍按一次失败清账。

---

# R3 correction 复审

结论：**REVIEW_PASS**

本轮只静态核验并实跑 R3 correction；未修改产品代码、未 commit、未派子 agent。

## Findings

### Critical

无。R3 Critical 已关闭。

### Important

无。R2 分类与增量 validation cache 修复未回归。

### Minor

无。

## R3 Critical 回归

1. **普通 post-fsync source failure：关闭。** `afterAppend` 的增量 validator plain Error先包装成带 cause 的 `RolloutSourceError`，随后直接 throw（`service.ts:127-135`）；source identity mismatch及 projector 返回的 source warning也转成 `RolloutSourceError`（137-145行）。只有非-source projector error在 catch 中变成 `kind:'projection'` warning（146-149行）。因此 source failure穿透 store并 reject append Promise。
2. **prepared projection warning 不遮蔽 source fatal：关闭。** store 先 `await prepared.afterAppend`，成功后才执行 `prepared.projectionWarning ?? finalizedWarning`（`jsonlStore.ts:160-162`）。source throw使表达式永不进入 merge；既有 projection warning无法把 rejection改回 resolve。组合测试用 pre-reconcile SQLite select fault制造 prepared warning，再让第二次 validation chunk失败，append仍以 source error reject（`service.test.ts:176-200`）。
3. **JSONL evidence 保留：关闭。** source failure发生在 durable append + fsync之后；两个测试分别断言JSONL保留1条与2条完整 evidence（`service.test.ts:158-173,176-200`），没有 rollback/truncate source。
4. **flush ledger 一次报告：关闭。** rejected append进入 store failure ledger；普通 post-fsync用例断言首次 flush同错 reject、第二次 resolve（`service.test.ts:168-169`）。service tail继续保持 nonsticky，store在抛出前删除截止 failure。
5. **健康重试 reconcile/dedupe、不双写：关闭。** repaired driver首次无 cache做全量 source validation，projector先重放已落 evidence，再从 events dedupe相同 mutation；普通与复合用例均断言 retry records为0，JSONL仍分别只有1/2条（`service.test.ts:171-173,198-200`）。
6. **projection-only post failure：关闭。** 新 tail validation/cache更新后，projector的普通 SQLite/fault error仍由 `afterAppend` 返回 `kind:'projection'` warning；append resolve并保留records。既有测试断言 source success + projection warning，随后 reconcile追平（`service.test.ts:106-118`）。

## R3 / 090 回归

- operation boundary仍强制重分类相反 branded errors并保留cause；projector测试保持通过。
- hot append byte observer、跨driver tail、truncate/replacement/sentinel、partial/oversize与explicit reconcile cache刷新逻辑未改，相关测试保持通过。
- `preflightRolloutSources` 继续仅返回 `{files,bytes}`；090 rebuild与corruption测试保持通过。
- 同inode、同size且远离末128-byte sentinel的prefix原位篡改仍是append-only/application-owned source假设下的已知非阻断边界；本 correction未扩大该边界。

## 验证

- 指定6文件 Vitest：**通过**，6 files / 49 tests。
- `pnpm exec tsc -b`：**通过**。
- `pnpm --filter @einfach-agent/host-node build`：**通过**。
- `pnpm check:boundaries`：**通过**，仅既有豁免观察项。
- `pnpm check:state`：**通过**。
- `git diff --check`：**通过**。
- 17个owner均≤300行；最大`projector.ts` 287行，service 205行，service test 212行。单一职责与拆分未回归。
