# 056 执行报告

## 结果

已完成 legacy ordered source scan 的纯类型/纯函数合同，未接触 filesystem、SQLite、adapter、service、
recovery、commands 或 public query 合同。

- `legacyOrderedPage.ts` 定义并实现三类稳定 key：
  - list：`updatedAt DESC, historyId ASC`
  - search：`rank ASC, updatedAt DESC, historyId ASC, itemOrdinal ASC, itemId ASC`
  - items：`itemOrdinal ASC, itemId ASC`
- bounded top-K 累积会在后续批次出现更优 key 时替换旧 frontier；支持调用方提供 target dedupe key；
  `afterLegacyKey()` 统一执行 exclusive filter。
- `LegacyOrderedSourcePage` 以 `status: scanning | ready` 判别；scanning 分支的 `values` 类型和值固定为空，
  只携带有界 compact frontier reference。
- scan state 绑定 `version/phase/kind/source/filters/snapshot/traversal/after/limit/frontier`；source id 只接受
  有界 opaque digest/logical id，禁止路径字符。
- traversal 是 source-owned、长度受限的 canonical base64url opaque cursor。056 不假定 child traversal 结构；
  057/058 分别负责其内部 cursor 的递归严格解码，从而 root 不需要反改本合同。
- decoder 对自有层级递归 exact：拒绝 unknown keys、异常 prototype、非规范 filter、wrong kind/key、unsafe
  integer、非 finite rank、过长字符串、非 canonical base64url；snapshot mismatch 返回 typed stale。
- frontier 强制 `<= request limit`、按 kind comparator 已排序、target key 唯一且严格位于 `after` 之后。
  list/items limit 上限 100，search 上限 50；query 上限 1000 Unicode code points。

## 测试覆盖

- 第二批出现更优 list key，top-K 仍全局正确。
- list/search/items 全 tie-break；list/search/items after-exclusive；items 三页无重复遗漏。
- target dedupe、空 batch、limit 1、limit max/max+1、frontier 超界/乱序/重复 target。
- kind/filter/source/after mismatch、snapshot stale。
- unknown nested key、prototype pollution、unsafe/negative integer、NaN、Infinity、坏 JSON、坏/带 padding
  base64url、错误 version/phase、非规范 statuses/roles/query、错误 kind-specific key、路径型 source id。

## 验证

- `pnpm exec vitest run packages/host-node/src/history/legacyHistoryQuery.test.ts packages/host-node/src/history/legacyOrderedPage.test.ts`
  — 2 files / 14 tests passed。
- `pnpm exec tsc -b --pretty false` — passed。
- `pnpm --filter @einfach-agent/host-node build` — passed。
- `pnpm check:boundaries` — passed（仅既有观察项）。
- `pnpm check:state` — passed。
- `git diff --check` — passed。
- owner `wc -l`：294 / 157 / 92 / 84，全部 `<=300`。

## R2：关闭 R1 review

R1 的 5 个 Important 与 2 个 Minor 已全部关闭：

- frontier 不变量按 kind 区分：list 强制 target key 唯一；search/items 允许同 target 多 item；三种 kind
  均拒绝 comparator 相等的重复 total key。
- frontier 的 `valueKey/targetKey` 收紧为最多 128 字符的 compact logical key/digest；public target component
  支持 1000 Unicode code points，ordered history/item id 支持 child 合成长度。scan codec 使用 deterministic
  Brotli + canonical base64url，并在 validate/encode/decode 三处共同约束 cursor 不超过最终 envelope 预算预留值；
  limit 100 list 与 limit 50 search 的最大 target/child id fixture 均可自 round-trip。
- binding 新增 bounded `limit`，source/filter/after/snapshot 改为字段级、规范化语义比较，不再依赖对象属性插入
  顺序；limit mismatch 稳定返回 invalid，snapshot mismatch 仍返回 stale。
- source-produced ready page 已移除 `lastEmitted`；consumer after 只由后续 060 global merge/budget 层推进。
- statuses、roles、frontier 均要求精确 `Array.prototype`；自定义或 null prototype 在调用数组方法前返回 typed
  invalid，不泄漏 raw `TypeError`。
- list/search/items 都新增跨三页 after-exclusive 回归，并覆盖各自 tie-break 边界。

为遵守单一职责与 300 行硬上限，scan state 类型、递归 validation、canonical codec 与 binding 被迁移到新增的
`legacyScanCodec.ts`；`legacyHistoryQuery.ts` 只保留 source page envelope、既有 continuation 兼容合同与 codec
re-export。新增文件已先登记到 056 frontmatter。

### R2 验证

- 定向 vitest：2 files / 16 tests passed。
- `pnpm exec tsc -b --pretty false`：passed。
- `pnpm --filter @einfach-agent/host-node build`：passed。
- `pnpm check:boundaries`：passed（仅既有观察项）。
- `pnpm check:state`：passed。
- `git diff --check` 与 owner trailing-whitespace check：passed。
- owner `wc -l`：74 / 217 / 92 / 93 / 258，全部 `<=300`。
