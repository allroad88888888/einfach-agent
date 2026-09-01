---
id: "056"
title: 定义 legacy ordered scan 状态合同
kind: leaf
parent: "055"
depends_on: ["040"]
discovered_from: "060"
model: gpt-5.6-sol
status: cancelled
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/history/legacyHistoryQuery.ts
  - packages/host-node/src/history/legacyHistoryQuery.test.ts
  - packages/host-node/src/history/legacyOrderedPage.ts
  - packages/host-node/src/history/legacyOrderedPage.test.ts
  - packages/host-node/src/history/legacyScanCodec.ts
---

# 定义 legacy ordered scan 状态合同

## 目标

定义 root/child 共用的 service-facing ordered source scan 类型与纯函数，不接触 filesystem/SQLite：

- 明确 `scanning` 与 `ready` 判别态；扫描中只能携带 bounded frontier，不能发出局部有序 values。
- list key：`updatedAt DESC, historyId ASC`；search key：`rank ASC, updatedAt DESC, historyId ASC,
  itemOrdinal ASC, itemId ASC`；items key：`itemOrdinal ASC, itemId ASC`。
- top-K 累积、target dedupe hook/target key、`after` exclusive filter、stable tie-break均为纯函数。
- scan state绑定 version/kind/source/normalized filters/source snapshot/traversal state；递归 exact验证
  safe integers、finite numbers与string，拒绝unknown keys/prototype污染/非canonical base64url（若负责编码）。
- frontier 数量必须由请求 limit 上限约束；本层不能形成无界数组或把完整 model item放进cursor state。

## 验收

第二批出现更大key时 frontier输出仍全局正确；三页 after-exclusive不重漏；同key tie-break、重复target、
空批、limit 1/max、换kind/filter/source、unknown nested key、unsafe integer、NaN/Infinity、坏base64url逐项测试。
定向 tests、tsc、host-node build、boundaries/state/diff-check与owners <=300通过。

## 禁止项

不修改 adapters/service/commands；不执行I/O；不把legacy path放进public query合同。

## R1 修复门

按 `reports/056-review.md` 关闭全部 Important/Minor：

- list才做target dedupe；search/items允许同target多item；所有kind拒绝重复total key。
- compact reference与identity长度合同必须支持060的1000字符target及child合成id；encoder产物必须总能被decoder
  接受且cursor <=最终envelope预算，补limit100/50最坏round-trip测试。
- binding加入limit并做字段级/规范化比较，不依赖对象属性插入顺序。
- source ready page移除`lastEmitted`；consumer after只归060最终merge/budget所有。
- statuses/roles/frontier等arrays严格验证`Array.prototype`；坏prototype稳定typed invalid。
- list/search/items均补三页/tie回归。
