# 030 独立审查

结论：**REVIEW_FAIL**

审查范围仅限 030 frontmatter 的 6 个文件；未重跑执行者已经报告的测试，以下证据来自静态审查。

## Findings

### Critical

1. stale lock 的判定与替换不是 owner-safe，活跃 writer 可被抢锁，进而产生并发 append、重复 ordinal 或批次交错。

   - `rolloutLock.ts:48-53` 先分别读取 `stat` 与内容，再以 `mtime >= staleMs || ownerIsDead(...)` 判 stale；`rolloutLock.ts:98-103` 随后直接 rename 当前路径，没有验证被 rename 的仍是刚才观察到的 inode/token，也没有在替换前复核 owner。
   - heartbeat 在 `rolloutLock.ts:70` 是未等待的 timer 回调。事件循环阻塞、文件系统延迟，或临界区超过 30 秒时，仍在工作的 owner 会仅因旧 mtime 被视为 stale。030 的临界区又包含无限历史的整文件读取、最多 16 MiB 编码/写入和 fsync（`jsonlStore.ts:105-115`），不能保证 heartbeat 在 stale 窗口内成功。
   - contender rename 后可创建新锁并进入同一 history；旧 owner 仍继续 append。两者都在各自认为持锁的情况下从相同尾记录分配 ordinal，破坏验收 1/2 的互斥与连续性。
   - release 也有 check/use 窗口：`rolloutLock.ts:78-81` 先按路径读取 token，再 unlink 路径。两步之间若 lock 被 stale recovery 替换，旧 owner 可删除 replacement lock。现有“非 owner”测试只覆盖静态替换发生在 release 读取之前（`rolloutLock.test.ts:29-35`），没有覆盖该竞态。

### Important

1. `flush()` 永远吞掉 queued append 的错误，不能作为可靠的进程退出持久化边界。

   - `jsonlStore.ts:128` 使用 `Promise.allSettled` 且不检查 rejected results，因此 append、编码、sync 或 lock timeout 失败时 `flush()` 仍 resolve。
   - settled queue 会在 `jsonlStore.ts:89` 立即从 map 删除；调用方若稍后才 flush，失败甚至不再可观察。这个语义与“失败向执行路径抛出”和“进程退出前 flush 已排空”的强边界不相容：忽略/延后收集 append promise 的调用者会被 flush 错误地告知成功。
   - `jsonlStore.test.ts:99-105` 名为“including failed appends”，实际只提交成功 append，未断言 flush 传播失败。

2. append 成本随完整历史无界增长，并把该成本放在跨进程锁内，放大 stale 抢锁风险和 lock wait timeout。

   - `jsonlStore.ts:105` 每个 batch 都用 UTF-8 `readFile` 读取整个 append-only JSONL；`lastRecord` 又在 `jsonlStore.ts:40` 对完整内容 `slice(...).split('\n')`，产生额外的全历史字符串/数组分配，只为取得最后一条。
   - batch 有 1000 records / 16 MiB 上限，lock wait 有 10 秒上限，但已有 history 的读取与分配没有上限。随着历史增长，单次 append 是 O(total history) 时间和内存，且持锁时间无界；这不满足任务要求的显式有界操作，也会让正常 contender 超时。

### Minor

无。

## 验收逐条核对

1. **不通过**：实现意图上在锁内读取尾部并连续分配 ordinal（`jsonlStore.ts:103-115`），测试也覆盖两个进程的常规竞争（`jsonlStore.test.ts:55-69`）；但 stale/owner 竞态允许两个 writer 同时进入，无法保证无重号、覆盖或交错。
2. **部分通过**：路径哈希令不同 target 使用不同 lock，批次编码后一次调用 `durableAppend`；但同 target 互斥受上述 Critical finding 破坏。
3. **不通过**：覆盖了普通 active wait、静态 stale malformed lock、静态 token mismatch；没有 owner-safe stale takeover，也没有覆盖 release 的 check/use race。
4. **部分通过**：半行在 `jsonlStore.ts:39` 明确报 corruption 且测试证明不改写原尾；编码/append/sync 会 reject。不过 `flush()` 会吞掉这些失败，且 append/writeFile 在底层部分写后失败时会留下 corrupt tail，这是 append-only 设计可检测但不可自动恢复的状态，应由调用方明确处理。
5. **有执行者证据**：执行报告称定向 Vitest 3 files / 13 tests 通过；本审查依约未重跑。现有测试缺少上述竞态、flush rejection 和大历史成本覆盖。
6. **通过**：三个实现文件分别 40、111、131 行，职责分离且低于 300 行。

## 修复门槛

- stale recovery 必须对被观察 owner 做原子或等价的身份保护，并保证旧 owner 一旦失锁不能继续写；release 不能通过路径上的分离 read/unlink 删除后来者的锁。
- `flush()` 必须等待并传播其覆盖范围内的 append 失败，且明确处理 flush 调用前已 settled 的失败。
- 取得尾记录应使用有界尾读/索引策略，避免锁内整文件读取与 split；同时保留半行和非法尾记录的明确 corruption 检查。

---

# R1 复审

结论：**REVIEW_FAIL**

本轮仅静态复审更新后的任务、index、执行报告、原 review 与 030 frontmatter owners；未重跑执行者测试。

## Findings

### Critical

无新增 Critical。原 Critical 中“live parseable owner 因 mtime 被抢”与 release 的普通 later-owner 删除竞态已关闭：

- `rolloutLock.ts:57-59` 对可解析且 PID 存活的 owner 不再参考 mtime；测试 `rolloutLock.test.ts:44-52` 覆盖 stale mtime + live PID。
- recovery/release 都先 rename 到唯一 claim，再比较内容；不匹配时 `restoreWithoutOverwrite` 用 hard link 的 `EEXIST` 保留路径上后来者（`rolloutLock.ts:62-77,106-109`）。
- store 在真正 append 前调用 `assertOwned()`（`jsonlStore.ts:138-145`）；所有 cooperative contender 都不会回收 live parseable owner，因此该检查到 write 之间不再存在正常 stale takeover 路径。

### Important

1. malformed stale recovery 仍没有可靠的文件代次身份，可能抢走一个正在初始化的新 lock。

   - `recoveryCandidate` 用 `Promise.all` 独立取得 `stat` 和文件内容（`rolloutLock.ts:51-55`），随后把“旧 mtime”与“当前内容”组合判定；candidate 只保存内容字符串（`rolloutLock.ts:49,57-60`）。
   - `claimIfUnchanged` 在 rename 后也只比较内容相等（`rolloutLock.ts:69-76`），没有比较 inode/file identity 或该代文件自己的 metadata。
   - 新 lock 在 `open(path, 'wx')` 与 `writeFile(owner)` 之间必然短暂为空（`rolloutLock.ts:80-84`）。空内容也是崩溃最常留下、可按 stale age 回收的 malformed 内容。竞态为：reclaimer 先 stat 一个 stale 空锁；另一 contender 回收旧锁并 `open('wx')` 创建新的空锁；reclaimer 随后读到相同空内容，携带旧 mtime 判 stale，再 rename/delete 这个新锁。内容比较无法识别它已换代。
   - 写前 `assertOwned()` 能阻止被抢 writer 继续写 history，因此当前未恢复为原 Critical 的重复 ordinal；但合法 acquisition 会被破坏，且另一 writer 可在其间取得路径，造成无故 append 失败。这不满足 R1 明确要求的 malformed recover 身份安全。

### Minor

无。

## 原 findings 回归

1. **live parseable owner / stale owner race：部分关闭。** live PID 不因 mtime 被抢、dead owner 的 UUID owner 内容可安全复核、release 不覆盖普通 later owner、写前 ownership 均有实现证据；malformed 的同内容跨代竞态仍未关闭。
2. **flush 失败语义：关闭。** `operationId` cutoff 建立调用时 barrier，`pending` 等待未完成任务，`failures` 保留调用前已 settled 的错误并在一次 flush 后消费（`jsonlStore.ts:107-123,157-165`）；测试 `jsonlStore.test.ts:107-114` 覆盖 settled-before-flush。
3. **unbounded history append：关闭。** `readLastRecord` 通过 `stat/read` 最多读取 `AGENT_ROLLOUT_MAX_LINE_BYTES + 2` 字节（`jsonlStore.ts:38-71`），不再整文件读取/split；测试 `jsonlStore.test.ts:116-133` 构造 32 MiB sparse history。

## R1 验收结论

- batch ordinal、半行/超长尾、bounded tail、flush failure propagation 与 live parseable owner 的静态证据均满足修复目标。
- malformed recovery 的 generation identity 仍不满足，故不能确认“无新增或残留 Critical/Important”，本轮保持 `REVIEW_FAIL`。
- 修复门槛：对同一路径代次使用来自同一打开 handle 的身份/metadata，并在 claim 后验证 claimed 文件就是观察到的那一代；不能仅以可能重复的 malformed 内容作为身份。

---

# R2 复审

结论：**REVIEW_PASS**

本轮仅静态核验 R1 残留的 malformed cross-generation identity race；未重跑执行者测试，未复审无关文件。

## 核验证据

- **候选 stat/content 同代：通过。** `recoveryCandidate` 先打开 pathname，随后通过同一个 `FileHandle` 读取内容与 `stat`，并把 handle、contents、identity 一起保留到 claim 阶段（`rolloutLock.ts:52-71`）。不再组合 pathname 上不同代次的 stat/content。
- **claim 后验证同一 file identity：通过。** `claimObservedFile` 在 rename 后同时取得候选 handle 当前 stat 与 claimed pathname stat，并要求二者都与观察 identity 相同，同时复核内容（`rolloutLock.ts:88-103`）。有 inode 的平台比较 `dev/ino`；无 inode 时使用 birth/ctime/size/mode fallback（`rolloutLock.ts:73-79`）。
- **新初始化空 lock 不被旧 candidate 删除：通过。** 若旧 stale 空锁在观察后被新空锁替换，候选 handle 仍指向旧 inode，而 claimed pathname 指向新 inode；identity 比较失败后 `restoreWithoutOverwrite` 将 claimed 新代恢复到空出的 lock path，再删除私有 claim（`rolloutLock.ts:81-85,101-103`）。因此相同空内容不会绕过代次检查。
- **针对性测试证据存在。** `rolloutLock.test.ts:63-85` 在 candidate-observed seam 中删除旧空锁并创建新空 generation，断言 reclaimer 超时且新 handle 与最终 pathname 仍为同一 `dev/ino`。按任务要求本审查未重跑测试；执行报告称定向 18 tests 通过。
- **release 同样保留代次安全：通过。** release 传入 owner handle 及其 stat，并同时要求 PID/token 内容匹配（`rolloutLock.ts:127-146`），不会仅凭 pathname 内容删除后来者。

## Findings

### Critical

无。

### Important

无。R1 唯一残留 finding 已关闭，未发现此修复引入新的 Critical/Important。

### Minor

无。
