---
id: "057"
title: 接入 child legacy ordered pages
kind: leaf
parent: "055"
depends_on: ["056"]
discovered_from: "060"
model: gpt-5.6-sol
status: cancelled
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/history/legacyChildHistory.ts
  - packages/host-node/src/history/legacyChildHistory.test.ts
  - packages/host-node/src/history/legacyChildOrderedPage.ts
  - packages/host-node/src/history/legacyChildOrderedPage.test.ts
---

# 接入 child legacy ordered pages

## 目标

用056 scan合同包装现有run-index/directory traversal：单次调用继续遵守文件字节、目录entry、history数硬上限；
scan未完成时返回空values；完整扫描并验证index/directory/content snapshot后才释放全局top-K。下一public页
使用emitted key exclusive重扫，确保后续traversal批更“新”也不会造成错序。

list/search支持normalized target/roles；search不得积累无界hits。targeted record显式返回trace
sourceSnapshot，供060 items cursor判stale。保留040 compatibility facade和malformed/partial warnings。

## 验收

至少两traversal批且第二批更新、同timestamp tie、三页不重漏、扫描空页、roles/target、invalid/stale、
trace内容变化、硬I/O cap全部测试；既有040 tests不回归；全门及owners <=300通过。
