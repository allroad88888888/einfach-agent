# 060 review

## Simplified R2 独立复审

VERDICT: FAIL

严重度：Critical 0 / Important 2 / Minor 1。

本轮只按最新 scope cut 审查。旧 R1 关于 global legacy ordered merge、跨 filesystem 全局分页与
legacy source snapshot 的 findings 已因 055–058 取消而不再适用，也未用于本轮 FAIL 判定。

### Critical

无。

### Important

1. **targeted legacy 分支绕过 public capability 的输入边界。**

   `historyQueryService.ts:52-54` 用固定 `{target,limit:1}` 做 canonical presence；canonical 不存在后，
   list/items/read/search 在 `:63-114` 不再经过 030/050 对原始 input 的 runtime validation。本人用 build
   后的真实 provider + recovery fixture 验证，下列 public calls 全被错误接受：
   `listHistories(limit:101)`、`listItems(limit:0|101)`、`readItem(limit:20001)`、
   `search(query:'   ')`、`search(limit:51)`。host routes 会拒绝这些值，但 070 的 direct capability 不经过
   host handler；同一 public contract 不能因 canonical/legacy source 不同而改变。

   最小修复：四个 public method 在 reconcile 后、`canonicalExists()`及任何 query I/O前统一规范化/验证：
   list/items limit 1..100、read offset及limit 1..20000、search trim后1..1000 Unicode code points及
   limit 1..50，并严格验证statuses/roles。补 direct provider 的上下界与invalid filter测试。

2. **canonical page 追加 projection warning 后没有按最终 envelope 重新裁剪。**

   `withWarnings()`（`historyQueryService.ts:34-38`）追加 `PROJECTION_LAG` 后只调用
   `assertHistoryEnvelope()`；超限即抛。`fitHistoryPage()` 只用于 targeted legacy items/search。
   本人受控验证：两个合法 canonical summaries 各含49,791字符 title时，030返回2项、完整result为
   99,913字符且无cursor；加入projection warning后service直接抛RangeError。此时返回1项、
   `PROJECTION_LAG` + `OUTPUT_TRUNCATED`及cursor完全可表示，当前却既未保留warning也不可续页。

   最小修复：让030/050 page builder接收service base warnings，或在060用既有严格filter/snapshot/key codec
   对canonical候选重做最终budget。补list/items/search“原页可容纳、追加warning后需少一项”的测试，断言
   `JSON.stringify(result).length <= 100000`、warning完整且第二页无重漏。

### Minor

1. **46条命令的测试注释仍陈旧。** 产品表与断言已正确为46，但
   `commandNames.test.ts:28-32`仍称“后14条没有Rust对应物”，且说明只到rollout、没有计入四条history。
   运行时无误；按“总数与注释同步”修正文案即可。

### 10项核对

1. ✅ global list/search 无target时分别只走canonical repository/FTS
   （`historyQueryService.ts:61,101`），零legacy I/O；statuses空数组原样透传030。
2. ✅ targeted四方法先做无status/query/role过滤的catalog presence（`:52-54,62,73,90,101`）；存在即不
   fallback，测试覆盖status过滤collision，search/items/read使用同一路径。
3. ✅ `publicItem()`（`:23-26`）在legacy items/read/search输出前剥离`modelItem`；read仅内部生成text。
4. ✅ reconcile reject/source warning统一为`AGENT_HISTORY_SOURCE_CORRUPT`且先于query I/O；正常小页保留
   `PROJECTION_LAG`。大页warning保留缺口见Important 2。
5. ✅ simplified legacy cursor有长度上限、canonical base64url、exact envelope、kind、normalized filters与
   safe offset校验；items测试实际消费第二页。本scope不要求source snapshot。
6. ❌ targeted legacy预算通过；canonical追加service warning后的最终budget不闭环，见Important 2。
7. ✅ host四route在`provider.forContext`前完成validation；query trim后按code points校验，query/offset单次读取。
8. ✅ default host只创建一个executor facade并同时注入rollout/recovery/history；borrowed identity/lifecycle不变。
9. ✅ `historyCommandArgs.ts`独立augmentation恢复双向command args穷举，命令运行时总数/断言为46；仅测试
   注释有Minor。
10. ✅ 19个owners均`<=300`；最大`commandArgs.ts` 290、`createNodeHostInvoke.ts` 211，职责拆分合理。

### 验证

- 定向与依赖回归：11 files / 57 tests passed。
- `pnpm --filter @einfach-agent/host-node build`：passed。
- `pnpm exec tsc -b --pretty false`：passed。
- `pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：passed。
- 额外受控运行复现六种targeted legacy非法public input被接受，以及99,913字符canonical页追加projection
  warning后错误抛出。

## Simplified R3 独立复审

VERDICT: PASS

严重度：Critical 0 / Important 0 / Minor 0。

本轮只复查 simplified R2 的 2 Important + 1 Minor，并抽查相关路径无回归；已取消的 global legacy
ordered merge、跨 filesystem 全局分页与 legacy source snapshot 不在审查范围。

### R2 findings 关闭情况

- ✅ **direct capability 输入边界已关闭。** `historyInput.ts:46-75` 为四方法统一校验 target/cursor、
  statuses/roles/includeDeleted、list/items 1..100、read safe offset与1..20000、search trim后1..1000
  Unicode code points与1..50。service在每个方法中先`await reconcile()`，随后立即normalize，再执行
  `canonicalExists()`或任何canonical/legacy I/O（`historyQueryService.ts:61-76,82-95,104-112,116-129`）。
  本人用真实build产物对明确legacy target验证R2六个反例，并追加invalid statuses/roles/includeDeleted：
  9项全部reject，计数为`reconciles=9 / executor.select=0 / recovery.listLatest=0`，证明拒绝发生在
  reconcile之后、catalog/query/recovery之前。
- ✅ **canonical service-warning最终预算已关闭。** `historyCanonicalBudget.ts:9-23` 在追加base warnings后
  对完整envelope计量；超限时以逐步缩小的同源limit重查，因此030/050生成与实际最后返回项一致的原生
  source cursor，并追加`OUTPUT_TRUNCATED`。真实canonical list测试
  `historyQueryService.test.ts:105-123`覆盖projection warning触发重预算：第一页仅`a`、含
  `PROJECTION_LAG`与`OUTPUT_TRUNCATED`、序列化`<=100000`且有cursor，第二页仅`b`，无重复遗漏。
  `historyCanonicalBudget.test.ts:18-27`另对items/search机制验证重查结果的精确source cursor被保留。
- ✅ **46命令注释已关闭。** `commandNames.test.ts:28-34`已改为46条、16条无Rust对应物，并明确列出
  rollout两条与history四条；运行时总数和唯一性断言保持46。

### 无回归抽查

- global list/search仍只走canonical repository/FTS；targeted presence、legacy `modelItem`剥离、source
  fail-closed、projection/search/legacy warning分类、strict legacy cursor、host validation、单executor与
  command args双向穷举路径未被R3改动破坏。
- focused Vitest：9 files / 55 tests passed。
- `pnpm --filter @einfach-agent/host-node build`、`pnpm exec tsc -b --pretty false`、
  `pnpm check:boundaries`、`pnpm check:state`、`git diff --check`全部passed。
- R3后的23个owners均`<=300`；最大`commandArgs.ts` 290、`createNodeHostInvoke.ts` 211，新增
  `historyInput`与`historyCanonicalBudget`各自职责单一。
