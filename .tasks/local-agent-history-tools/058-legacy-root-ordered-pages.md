---
id: "058"
title: 接入 root recovery ordered pages
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
  - packages/host-node/src/history/legacyRootHistory.ts
  - packages/host-node/src/history/legacyRootHistory.test.ts
  - packages/host-node/src/history/historyRecoveryReader.ts
  - packages/host-node/src/history/historyRecoveryReader.test.ts
  - packages/host-node/src/history/legacyRootOrderedPage.ts
  - packages/host-node/src/history/legacyRootOrderedPage.test.ts
---

# 接入 root recovery ordered pages

## 目标

在同一persistence executor上增加history-only只读recovery keyset scan/load port；不hydrate/write store、
不建第二数据库。用056合同分段扫描root records，scan未完成不发局部values，完成并验证
generation/content snapshot后才释放全局top-K；list/search有界且可续。

保留现有SQLite RecoveryDriver的row/deleted/JSON/session/generation fail-loud语义。targeted record显式返回
sourceSnapshot供060 items cursor判stale。现有040 compatibility facade继续可用。

## 验收

多row第二批更“新”、三页不重漏、tombstone、坏row/JSON/session/generation、snapshot变化、SQL keyset硬limit、
只SELECT无写入均测试；既有040/recovery tests不回归；全门及owners <=300通过。
