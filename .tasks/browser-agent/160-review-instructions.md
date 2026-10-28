# 160 独立验收与覆盖审计

任务：`.tasks/browser-agent/160-model-setup.md`
执行报告：`.tasks/browser-agent/reports/160-report.md`
范围 diff：`.tasks/browser-agent/reports/160-scope.diff`
旧增量前态：`.tasks/browser-agent/reports/160-prechange.diff`（网络接线早已验收，不误算本轮新增）。
编排浏览器与验证证据：`.tasks/browser-agent/reports/160-browser-check.md`、`160-root-verification.md`（若尚未生成，明确等待编排补证即可，不重跑浏览器）。

以 160 行为验收为准逐条✅/❌，独立审查实际生产视图和公开client调用，检查空态→配置→保存→Agent选第二模型→会话、错误状态、缺失引用保护、明文Key不回填、切换上下文不窜配置，以及360px可用性。审查兼任M01–M04覆盖审计，不能仅信报告。此次没有新增跨域架构，不扩大到无关旧实现。

不得重跑执行者已报通过的测试；可以静态检查具体测试证据和实现；如发现未覆盖的新缺陷，可做最小定向复现。禁止访问系统钥匙串，禁止启动任何浏览器/CDP/Chrome for Testing；浏览器由编排CUA独占。
不修改产品，不修改 index/任务书，仅写 `.tasks/browser-agent/reports/160-review.md`。结论 PASSED 或 REJECTED，发现分 Critical/Important/Minor。无须给风格建议刷存在；只报可行动的真实问题。
不得委派子agent，不install、不commit/push、不创建远程issue。
