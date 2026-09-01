# 040 执行报告

## 实现

- `legacyRootHistory.ts`：通过注入的 `SqlExecutor` 仅 SELECT `recovery_snapshots`，复用 core `validateRecoverySnapshot`，原样投影 snapshot 的 conversation items；支持 canonical target 去重与 list/items/read/search 内部读面；固定 legacy/partial 语义。
- `legacyChildPath.ts`：按固定 archive layout 解析逻辑 child target；要求绝对 workspace locator，拒绝 `..`、分隔符、绝对 agentPath，并通过最近既存祖先 realpath 校验阻断 symlink escape。
- `legacyChildHistory.ts`：从 bounded `runs.jsonl` 发现本 locator 的旧 run，再有界读取 trace；仅接收 assistant/tool，逐行隔离 malformed/非法 role，保留后续合法行；固定 legacy/partial 语义。trace 单文件 2 MiB，发现总读取 8 MiB、最多 100 history，触限附 `OUTPUT_TRUNCATED` warning。
- 未创建/hydrate store，未写 SQLite、rollout 或 archive；缺 workspace locator 返回空发现。

## 验证

- `pnpm exec vitest run packages/host-node/src/history/legacyRootHistory.test.ts packages/host-node/src/history/legacyChildPath.test.ts packages/host-node/src/history/legacyChildHistory.test.ts`：PASS（3 files，11 tests）。
- `pnpm exec tsc -b`：PASS。
- `pnpm check:boundaries`：PASS。
- `pnpm check:state`：PASS。
- `git diff --check -- packages/host-node/src/history .tasks/local-agent-history-tools/reports/040-report.md`：PASS。
- owner 行数：137 / 56 / 68 / 47 / 175 / 61，全部 `<=300`。

## 边界覆盖

- recovery-only root、canonical target 去重、items/read/search、partial warning、零 SQL write。
- assistant/tool 顺序、坏 JSON 与 user 行隔离、坏行后续合法行保留、无 locator 空发现、2 MiB 拒绝。
- `../`、绝对/含分隔符 agentPath、symlink 逃逸拒绝；macOS `/var` realpath alias 纳入测试。

## R1 修复

- child index 现在保留 `archiveBasePath` 作为权威物理 locator，并按真实 writer 的 trim/字符替换/96 字符截断规则校验 conversation/run segment 与逻辑 ID 绑定；targeted load 同样必须先命中 index，不再从 raw ID 猜目录。
- 新增 `legacyBoundedFile.ts`：单一打开句柄执行 cap+1 读取，核验 regular file 与同句柄 identity，按实际 `bytesRead` 记账；不再使用 stat→readFile。
- 新增 `legacyChildIndex.ts`：独立解析 bounded runs index，保留 index snapshot、稳定 run key、malformed warnings；oversized index 即使零 records 也返回 warning/truncated/continuation。
- child discovery 改为独立 `{records,warnings,truncated,continuation}` envelope；`opendir` 最多检查 256 个目录项，最多接受 100 histories，总读取最多 8 MiB（为 cap+1 probe 预留预算），任一触限立即停止。continuation 绑定 index snapshot 与稳定 run/agent key。
- root 改注入 `Pick<RecoveryDriver, 'listLatest'>`，沿用 driver codec 与 fail-loud corruption；targeted search 单次读取。
- 合法 user/system trace 归类为 ignored role，仅真正坏记录产生 `MALFORMED_LEGACY_RECORD`。
- 对齐 020 R2：legacy summary 返回非删除 `itemCount`，legacy items 固定 `materialized:true`。

## R1 验证

- 定向 Vitest（root/path/bounded-file/child-index/child-history）：PASS（5 files，13 tests）。
- `pnpm check:boundaries`：PASS。
- `pnpm check:state`：PASS。
- owner `git diff --check`：PASS。
- owner 行数：115 / 42 / 71 / 41 / 39 / 26 / 91 / 54 / 184 / 80，全部 `<=300`。
- `pnpm exec tsc -b`：040 owners 无错误；当前唯一剩余错误均位于正在执行 R1 的 030 owner `packages/host-node/src/rollout/queryRepository.ts`（缺 `itemCount`、`materialized` 及 nullable tombstone narrowing）。按编排者要求不等待 030，最终汇合时全仓复跑。

## R2 修复

- 新增专责 `legacyHistoryQuery.ts`，统一定义 legacy discovery/search envelope、snapshot-bound continuation，以及稳定的 `AGENT_HISTORY_CURSOR_STALE` 判定。
- child `listHistories(continuation?)` 现在校验 runs index snapshot；continuation key 明确定义为最后已消费的 `[conversationId,runId,agentPath]`，恢复 exclusive。同一 run 只跳过已消费 agent，较早 run 不再打开/读取。
- 永久 oversized trace 作为已消费项返回 `OUTPUT_TRUNCATED` 与 continuation；下一页越过它继续读取后续 trace。100+1 history 两页测试证明无重复或遗漏；index 改动后旧 continuation 稳定 stale。
- root/child `search` 改为内部 envelope，保留 partial、malformed、truncated 与 continuation。untargeted child search 接受 continuation 并可从 zero-hit truncated 第一页恢复到后续命中；targeted malformed 与 root partial 均有断言。
- child index 改为每行先完成固定 locator、normalization binding、realpath containment 校验，成功后才参与 latest-wins；同 key 后置坏 locator 不再吞掉前置合法记录，warning 仍保留。
- 正常 index snapshot 加入 bounded 内容 SHA-256，避免仅凭 inode/size/mtime 漏判同尺寸快速改写。

## R2 验证

- 定向 Vitest（root/path/bounded-file/child-index/child-history）：PASS（5 files，18 tests）。
- `pnpm exec tsc -b`：PASS。
- `pnpm check:boundaries`：PASS。
- `pnpm check:state`：PASS。
- owner `git diff --check`：PASS。
- owner 行数：116 / 44 / 71 / 41 / 39 / 26 / 100 / 65 / 34 / 206 / 135，全部 `<=300`。

## R3 修复

- continuation 新增可选 directory 状态：稳定 run key、最后已检查的 exclusive directory offset、目录 snapshot。
- child discovery 改为流式处理 `opendir` 条目；恢复页先跳过已消费 offset，跳过部分不计入本页 256 项配额，因此不会再次卡在第 257 项。
- 每个目录项在完成分类/trace 处理后才推进 offset；record cap 在消费下一项前截断，oversized trace 则在标记当前项已消费后截断，二者与目录批次组合时均保持 last-consumed 语义。
- directory continuation 绑定同一 trace 目录的 dev/inode/size/mtime snapshot；恢复前变化稳定返回 `AGENT_HISTORY_CURSOR_STALE`。
- 新测试用 301 个目录项（含大量非 trace 与 5 个合法 trace）跨两页恢复，证明最终结束且无重复/遗漏；另测分页后新增目录项触发 stale。原 18 项全部保留通过。

## R3 验证

- 定向 Vitest（root/path/bounded-file/child-index/child-history）：PASS（5 files，19 tests）。
- `pnpm exec tsc -b`：PASS。
- `pnpm check:boundaries`：PASS。
- `pnpm check:state`：PASS。
- owner `git diff --check`：PASS。
- owner 行数：116 / 44 / 71 / 41 / 39 / 26 / 100 / 65 / 45 / 238 / 156，全部 `<=300`。
