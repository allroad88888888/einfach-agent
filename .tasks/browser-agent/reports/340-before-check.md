# 340 根因与前态

2026-09-20，HEAD756cd97，已有工作树增量已保存340-prechange.diff及340-before。

- 直接执行已安装@einfach/core的createHistory公开API：125条独立transaction，最终只留100，最早before=25，cursor=100。createSessionHistory未传cap，正好触发默认淘汰。
- @einfach/core cap归一化只认正safe integer，Infinity/0会回退100；commit/hydrate均使用cap。
- browserUI提示源ConversationTimeline.tsx，核心原因sessionTurnHistory对找不到items:append的用户消息标history_unavailable。
- browser client同时装配IDB recovery/historyLog/historyFor，没有agentRollout JSONL。旧淘汰记录不可凭空补全。
- persistenceBridge在writer异步save后读取live history，且外置log未await，存在时点错配及中间崩溃丢账窗口。
- 原生Chrome本轮getApp仍返回cgWindowNotFound；未操作用户业务历史，不能声称浏览器实测。
