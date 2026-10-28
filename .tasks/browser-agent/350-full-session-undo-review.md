---
id: '350'
title: 全历史撤销与恢复独立验收
kind: leaf
parent: browser-agent
depends_on: ['340']
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files: []
---

独立只读审查340-full-session-undo.md U10–U14、reports/340-report.md、340-scope.diff、340-delta.diff和340-verification.md。只写绝对路径 /Volumes/work/ai/web-agent/.tasks/browser-agent/reports/350-review.md。不改产品或其他文件，不操作浏览器、不再委派、不重跑报告已绿色测试。

当前树有早前用户改动，delta对照340-before排除既有代码。检查scope diff但报告仅本轮新增缺陷。逐条✅/❌，Critical/Important/Minor要可发生条件/代码证据；不要按假设无限扩大需求。

重点：

- 无100条事务/消息年龄裁剪，commit和hydrate都保留，Number.MAX_SAFE_INTEGER必须有API依据（Infinity不合法），不是另一个任意窗口；仍复用SessionHistory/SESSION_SLOTS逆操作而不只是slice消息。
- 任意早/中/末消息撤回，contextCheckpoint/plan/run/graph/queue状态随日志回退；运行迟到写回/非active session隔离，旧真实barrier不绕过。
- 采用root批准的兼容原子配对：RecoverySnapshotV1可选history与状态同刻捕获/同记录saveLatest；优先嵌入，无字段才legacy外置读取。不能仅先save快照再await日志，否则reload窗口仍整本失账。检查CAS重试、reset/delete、错误序列化、损坏history/cursor/ops和旧格式、所有生产宿主historyFor装配；不接受在错配generation上静默undo。
- 旧版已经丢的逆操作不能从最后状态凭空造回；不把普通操作限制改名掩盖。旧缺账应准确说明，用户不会看到“按条数过期”变成新产品规则。
- 普通stop保留被history before/after引用的上传，涵盖items整值+增量、queued整值；会话删除最终释放，其他session引用保护，历史分支丢弃不永久资源泄漏。既有IDB decoder不能丢legacy barrier。
- 52page等前任务不在本轮范围。UI仍消息下undo/成功回填聚焦/失败保草稿，无redo入口或撤销占位回归。
- 普通新文件≤300，复用现有driver/slots，新增兼容字段有codec/类型/文档闭环；不重写history引擎或引入新包。

基于报告运行证据判断，不把本机无Chrome可用窗口本身列为缺陷；本地DOM与真实core/IDB模拟模型可构成可靠功能验证。输出精炼PASS或CHANGES REQUESTED与具体可执行问题。

首轮CHANGES REQUESTED已存reports/350-review-r0.md；R1仅复核barrier引用有效性及相邻legacy兼容，不重复其他绿色验证。

最终收口：340 R1由350独立PASS，360独立PASS；261files/2078tests完整回归通过，无unhandled errors。根build、core/IDB/browser runtime/UI/extension/embedded构建及治理门禁通过。产物与真实浏览器边界见reports/340-verification.md。无commit/push/远程issue。
