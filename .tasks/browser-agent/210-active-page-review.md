---
id: '210'
title: 活动页面授权与绑定修复独立通过验收
kind: leaf
depends_on: ['200']
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files: []
---

R1 追加：先前 PASSED 保留为仅模块审查历史；编排实际 Chrome 复现未通过，200 已重新开启。此轮读 200 R1 任务与 reports/200-report-r1.md、reports/200-r1-scope.diff，独立审查 service-worker 手动 action click 开侧栏是否恢复 activeTab 正常授予、同步用户手势/准确 windowId/Promise 拒绝/迁移旧 setPanelBehavior 是否正确，网络路由不回退。报告写 reports/210-review-r1.md；不重复已经绿色的测试，不操作 Chrome。编排的真实验证单独记录，不能用 test 代替。原合同保留：

独立只读审查200-active-page-binding.md任务。只写自己的绝对路径 /Volumes/work/ai/web-agent/.tasks/browser-agent/reports/210-review.md。输入200-report.md、200-scope.diff、200-prechange.diff及根index。不要编辑产品、不跑已绿测试、不启动浏览器、CDP、install、钥匙串、真实网站/Key，不再委派。

核对无tab与无URL权限区别、Chrome addHostAccessRequest按唯一tab请求（Promise<void>不等于已授权）、兼容回退、用户重试授权后进入握手、受限页面/拒绝授权/坏响应、跨window不误绑、原隔离/恢复/取消未退化。bindActiveTab()返回的目标tabId/frameId必须匹配请求，不能未绑定就创建会话。不得新增tabs/全站required权限。官方文档与边界在200任务内，不必重新研究全部项目。

仅对实际重要发现报告REJECTED，无发现则PASSED并注明真实MV3权限确认未实测（浏览器对网站授权由用户操作，不能用模拟test冒称真实）。Minor记账不循环。转录UI默认DeepSeek与以前全部增量不是本次审查范围，不回滚。
