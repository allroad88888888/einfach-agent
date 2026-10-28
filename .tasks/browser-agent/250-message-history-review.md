---
id: '250'
title: 消息级撤销重做的语义与UI独立验收
kind: leaf
depends_on: ['240']
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files: []
---

只读审查240-message-history-actions.md、reports/240-report.md、240-scope.diff、240-prechange.diff、240-browser-check.md。只写reports/250-review.md。不重跑已绿测试/不改产品或账本/不浏览器或CDP/不install/不真实Key/不再委派。
逐条H01–H05：不是挪全局按钮冒充精确目标；retract/restore显式session不串实例；撤中间轮和重做准确边界；history唯一真相且placeholder不进activeitems/model；redo不发模型或工具；branch废弃/旧目标/屏障不会partial rollback；重挂/恢复从日志投影；消息下视觉与disabled说明/键盘窄屏。保留旧API合同/持久化/异步停run保护/消息大区域/配置隔离。源码回归和编排真实CUA都齐才PASS，具体重要发现REJECTED。应用Apple HIG技能但用户消息下操作位置优先原生菜单建议。

## R1 复审范围裁决

真实CUA已完成360px三轮消息各自按钮和撤中间轮的第一轮保留/后两轮原位占位截图。当前用户并行使用Chrome，编排停止争抢前台焦点；原生redo/本轮宽屏/最终对比CSS图证保留明确限制，改由真实core/sendMessage+UI键盘回归以及220既有容器验收补证。不为完成QA打断真实客户会话或擅自重载正在使用的扩展。请独立判断代码/R1是否足以通过，并在报告保留浏览器覆盖限制，不要求未执行的动作凭空有证据。
