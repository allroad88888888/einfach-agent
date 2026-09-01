# 056 独立 review

VERDICT: FAIL

## 结论

search key 与 canonical `searchCursor.ts` / `searchQuery.ts` 的
`rank ASC, updatedAt DESC, historyId ASC, itemOrdinal ASC, itemId ASC` 完全一致；list/items
comparator、跨 batch bounded top-K、optional target dedupe 取最佳值、after-exclusive、scanning 空
`values`、list/items 100 与 search 50 上限也实现正确。traversal 保持 source-owned opaque base64url，root/child
可复用同一外层合同，source id 的字符集不允许 filesystem path。

但当前 scan codec 会拒绝正常的 search/items frontier，会编码出 decoder 自己拒绝的合法状态，并且没有把
request limit 绑定进 continuation。ready envelope 的 `lastEmitted` 还允许 source 在全局 merge 真正消费前
前进。这些都是 057/058 接入前必须修复的接口问题。

严重度：Critical 0 / Important 5 / Minor 2。

## Findings

### Critical

无。

### Important

1. **kind-blind `targetKey` 唯一约束使正常 search/items frontier 不可表示，并且 codec 仍允许重复 total key。**

   `legacyHistoryQuery.ts:38-43` 要求每个 frontier reference 都有 `targetKey`，`:222-233` 对所有 kind
   无条件要求它唯一。search 正常会返回同一 history/target 的多个 item hit；items 本来就只有一个 target，
   所以第二个 item 必然被当成坏 cursor。相反，`:228` 只在 comparator `> 0` 时拒绝乱序，两个不同
   `targetKey` 却完全相同的 total key 会通过；以该 key 作为 after 后其中一个会被永久跳过。本人分别验证了
   same-target items 被拒和 duplicate list key 被接受。`legacyOrderedPage.ts:73-83` 的 optional dedupe 本身会
   保留最佳值，问题只在 codec 把该 hook 错误提升为全 kind 不变量。

   最小修复：只对确需 target fallback 去重的 list frontier 强制 target 唯一；search/items 允许重复 target，
   三种 kind 都必须拒绝 comparator 相等的重复 total key。补同一 target 多 search hit、多 items，以及 duplicate
   total key 反例。

2. **encoder 接受的状态不一定能被 decoder 接受，合法 public/legacy identity 也超过 512 字符上限。**

   `legacyHistoryQuery.ts:118-120,132-137,175-186,226-227` 把 target component、historyId、itemId、
   valueKey、targetKey 默认限制为 512，但 host command 明确接受每个 target component 1000 字符
   （`historyCommands.ts:30-36`），child 又在 `legacyChildHistory.ts:71,83` 拼接三个 component 生成
   historyId/itemId。057 因而无法为有效 legacy child 记录编码 frontier。

   另外 `legacyHistoryQuery.ts:242-251` 的 encoder 不检查总长度，而 decoder 拒绝超过 65,536 字符的 cursor。
   本人构造了一个逐字段均合法、limit=100 的 list state：encoder 产出 214,244 字符，随即被 decoder 以
   `AGENT_HISTORY_INVALID_CURSOR` 拒绝。该 cursor 也不可能放进 100,000 字符的 service envelope。

   最小修复：先统一 public target、legacy synthesized id 与 scan key/reference 的长度合同；让 reference 真正
   compact，并保证每个 `validateLegacyScanState()` 接受的状态都能 round-trip 且最坏 cursor 可放入最终输出
   envelope。必须以 limit 100/search 50 和最大合法 root/child identity 做测试，不能只提高 decoder 上限。

3. **scan binding 遗漏 request `limit`，且语义相同对象会因属性插入顺序被误判 mismatch。**

   `LegacyScanState` 在 `legacyHistoryQuery.ts:45-56` 持有 limit，但 `assertLegacyScanBinding()` 的 expected
   interface 和比较（`:259-265`）没有 limit。调用方以不同 limit 恢复 cursor 时无法表达或发现 mismatch，
   已有 frontier 甚至可能超过新请求 limit。该函数还用 `JSON.stringify` 比较 source/filter/after；本人将
   同一个已规范化 list filter 从 `{target,statuses}` 换成 `{statuses,target}`，得到
   `AGENT_HISTORY_INVALID_CURSOR`。

   最小修复：expected 增加并比较 safe bounded limit；用字段级比较或先按 kind 严格验证/规范化 expected，
   不把 JS property insertion order 当成 query binding。补 limit、等价 key order、真实 mismatch 分类测试。

4. **ready envelope 的 `lastEmitted` 可声明从未返回、更未被全局消费的 key。**

   `legacyHistoryQuery.ts:59-63,278-284` 让 source 在构造 ready page 时任意填 `lastEmitted`，却没有 keyOf、
   comparator 或与 `values` 的关系。本人验证 `values: []`、`exhausted:false`、任意 `lastEmitted` 被原样接受。
   更根本的是 source adapter 不知道 060 merge/budget 最后实际消费了其多少 values；若把 source page 尾 key
   写入该字段，global slice 会让未输出值永久越过。

   最小修复：从 source-produced ready page 移除 `lastEmitted`；由 060 在最终 merge/budget 后仅从实际输出尾值
   生成 consumer-owned after。若保留字段，必须改成不会表达“已外发”的候选/watermark 语义，且不能被 adapter
   用来前进。

5. **递归 prototype 合同没有覆盖 arrays。**

   `legacyHistoryQuery.ts:106-109` 严格检查 record prototype，但 `:142-149,221-224` 对 statuses/roles/frontier
   只做 `Array.isArray`。带自定义、继承 `Array.prototype` 的 prototype 数组会被 `validateLegacyScanState()`
   接受；不继承 Array.prototype 的数组还会在 `row.frontier.map` 泄漏 raw `TypeError`，而不是 typed invalid。

   最小修复：为所有数组要求 `Object.getPrototypeOf(value) === Array.prototype`，并在调用 array method 前完成
   检查；补 filters 与 frontier 两层 prototype 反例。

### Minor

1. **三页无重漏测试只覆盖 items。** `legacyOrderedPage.test.ts:48-58` 只跑 items；list/search 在
   `:60-70` 各验证一次 after filter，没有覆盖各自三页及完整 tie-break 边界。通用实现当前是正确的，但验收
   要求的回归门不足。

2. **ready helper 测试掩盖了 advancement 语义。** `legacyHistoryQuery.test.ts:43-46` 仅 `matchObject`
   检查 values/exhausted，主动传入 `lastEmitted` 却不证明它等于实际返回尾值或已被 consumer 消费。

## 已确认满足

- search key 字段与方向逐项匹配 canonical SQL/cursor；list/items key 也与 canonical keyset 一致。
- `accumulateLegacyFrontier()` 合并时内存最多是 bounded frontier + 最多 100 条 batch，后续 batch 的更优值会
  替换旧值；optional dedupe 会选全局排序最佳 target。
- `afterLegacyKey()` 是严格 exclusive；frontier codec 按 kind 检查顺序并要求所有 key 位于 after 之后。
- scanning 类型和 `legacyScanningPage()` 都固定 `values: []`，不会发出局部 batch。
- outer/traversal 使用 canonical unpadded base64url；object nested exact、finite rank、safe nonnegative integer、
  query Unicode code-point 1000、list/items 100/search 50 均已实施。
- kind/source/filter/after mismatch 返回 `AGENT_HISTORY_INVALID_CURSOR`，snapshot mismatch 返回
  `AGENT_HISTORY_CURSOR_STALE`；opaque traversal 留给 057/058 各自递归严格 decode，合同没有承载 path。
- 四个 owners 分别 294 / 157 / 92 / 84 行，均 `<=300`，两个产品模块职责单一。

## 验证

- 定向 vitest：2 files / 14 tests passed。
- `pnpm exec tsc -b --pretty false`：passed。
- 额外受控运行复现：same-target/duplicate-key codec 问题、214,244 字符 self-invalid cursor、limit 未绑定、
  property-order false mismatch、empty ready page 任意 `lastEmitted`、array prototype 接受。

---

## R2 独立复审

VERDICT: PASS

### 结论

R1 的 5 个 Important 与 2 个 Minor 已全部关闭，未发现新的 Critical / Important / Minor。当前合同可作为
057/058 的接入基础：search/items 能保存同 target 多 item，三种 key 均拒绝重复 total key；continuation
绑定 limit 且字段比较不依赖属性顺序；source ready page 不再表达 consumer advancement；数组 prototype、
canonical 压缩编码和 decoded size 都有硬门。

严重度：Critical 0 / Important 0 / Minor 0。

### R1 findings 逐项复证

1. **same-target 与 total-key uniqueness：已关闭。**

   `legacyScanCodec.ts:188-197` 仅在 `kind === 'list'` 时要求 `targetKey` 唯一，search/items 可重复 target；
   comparator `>= 0` 同时拒绝乱序和相等 total key。`legacyHistoryQuery.test.ts:138-159` 覆盖 same-target
   search/items，以及 list/search/items 三种 duplicate total key。optional target dedupe 仍由
   `legacyOrderedPage.ts:73-83` 选择排序最佳值。

2. **identity、self-roundtrip 与 cursor budget：已关闭。**

   `legacyScanCodec.ts:12-16` 统一定义 98,976 字符 encoded cap、4,000,000 bytes decoded cap、1000 code-point
   target、6144 code-point ordered id 和 128 字符 compact reference；`:70-72,78-89,120-150` 逐层实施。
   encoder 在 `:172-176,202,206-208` 只会返回 canonical Brotli + base64url 且已过输出预算；decoder 在
   `:209-223` 先验 encoded cap/base64url，再以 `maxOutputLength` 限制解压，最后重编码确认 canonical。

   额外高熵验证没有依赖重复字符压缩率：接近逐字段最大值、满 frontier 的 list/search/items 原始 JSON 分别
   约 666KB / 653KB / 654KB，三者都在 encode 前稳定返回 typed
   `AGENT_HISTORY_INVALID_CURSOR: Legacy scan cursor exceeds output budget`，没有生成 decoder 会拒绝的 cursor。
   将内部 frontier 缩至 10 / 5 / 10、同时保持请求 limit 100 / 50 / 100 后，三个高熵状态分别编码为约
   83.5KB / 88.8KB / 82.2KB，均低于 cap 且 self-roundtrip。`:186-187` 只要求 frontier `<= limit`，所以
   057/058 可在极端 identity 下缩小内部 frontier、返回较短可续页，不必制造 self-invalid cursor。

   canonical/decoded cap 也已受控验证：同一合法 JSON 用另一 Brotli quality 编码会在 `:218` 被 typed invalid；
   39 字符的高压缩输入解出超过 4.1MB 时会由 `:216` 的 cap 拒绝并在 `:220-223` 归类 typed invalid。合法
   worst-shape 即使使用四字节 Unicode，list/items 的 100 个 ordered id 或 search 的 50 对 ordered id 加上
   其余字段仍低于 4MB，decoded cap 不会反向拒绝合法 canonical encoder 产物。

3. **limit 与 order-independent binding：已关闭。**

   `legacyScanCodec.ts:242-258` 把 bounded limit 纳入 expected 和 mismatch 比较；source/filter/after/snapshot
   使用字段/typed comparator，filters 先严格规范化，不再比较对象 JSON 属性顺序。`:248-253` 将
   kind/source/filter/limit/after mismatch 分类为 `AGENT_HISTORY_INVALID_CURSOR`，`:254-257` 保持 snapshot
   mismatch 为 `AGENT_HISTORY_CURSOR_STALE`。测试见 `legacyHistoryQuery.test.ts:50-71`。

4. **ready advancement：已关闭。**

   `legacyHistoryQuery.ts:15-19,53-58` 的 ready 分支和 constructor 已完全移除 `lastEmitted`，只表达 source
   values/snapshot/exhausted/warnings；consumer after 无法再被 source page 提前推进。测试在
   `legacyHistoryQuery.test.ts:35-47` 对完整 envelope 做 exact equality。

5. **array prototype：已关闭。**

   `legacyScanCodec.ts:61-64` 统一要求精确 `Array.prototype`，statuses/roles 在 `:92-99`、frontier 在
   `:186-189` 均先过该门再调用数组方法。自定义 prototype 与 null prototype 都稳定返回 typed invalid；测试见
   `legacyHistoryQuery.test.ts:74-95`。

6. **三 kind 三页回归：已关闭。**

   `legacyOrderedPage.test.ts:48-67` 对 list/search/items 分别跨三页验证 after-exclusive 无重复遗漏，并让
   timestamp/rank/ordinal ties 穿过页边界；`:31-46,69-80` 继续逐项覆盖 search/items tie-break 与 list/search
   exclusive 边界。

7. **ready helper 回归门：已关闭。**

   `legacyHistoryQuery.test.ts:43-47` 不再传入误导性的 advancement 字段，并 exact 检查 ready envelope。

### 其余确认

- search comparator `legacyOrderedPage.ts:39-44` 仍逐字段、逐方向匹配 canonical
  `searchCursor.ts:8-14,83-89` 与 `searchQuery.ts:112-135`。
- scanning 在 `legacyHistoryQuery.ts:15-17,46-50` 的类型和 constructor 中都固定 `values: []`；不会发局部
  traversal batch。
- traversal 仍是 source-owned canonical opaque cursor（`legacyScanCodec.ts:43-45,139-145`），root/child
  后续可各自严格 decode；source id 使用 compact path-free 字符集（`:146-166`）。
- owners 行数为 74 / 217 / 92 / 93 / 258，全部 `<=300`。`legacyScanCodec.ts` 聚合的是同一个 scan codec
  抽象；其余模块分别负责 source envelope 与 ordered-page 纯算法，符合单一职责。

### R2 验证

- 定向 vitest：2 files / 16 tests passed。
- `pnpm exec tsc -b --pretty false`：passed。
- 额外受控验证：三 kind 满 frontier 高熵 typed reject；缩小 frontier 后 canonical self-roundtrip 且低于预算；
  alternate Brotli encoding 被拒；decoded-size bomb 被 4MB cap typed 拒绝。
