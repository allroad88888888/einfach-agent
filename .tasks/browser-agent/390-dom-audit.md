---
id: 390
title: 独立确认DOM选择在两类宿主完整可用
kind: leaf
parent: null
depends_on: ["370", "380"]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-21
done: 2026-09-21
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
---

# 独立确认DOM选择在两类宿主完整可用


## 目标
独立终审/覆盖审计D01–D06。等370和380独立review通过且编排集成测试与浏览器证据到齐后启动。只读产品，报告 `.tasks/browser-agent/reports/390-review.md`。
## 输入
370/380任务、reports/370-report.md与380-report.md、对应scope和delta diff、两个review、编排390-verification.md。现有未提交改动必须区分前态，不把HEAD以来所有代码当成此任务新增。
## 验收
逐条覆盖矩阵有确实证据；registry/schema/可选能力/扩展document路由/模拟模型运行闭环/纯Webconsumer/bundle/new包公开面均核实；旧用户toolNames不暗改、无站点专属代码；回读真选中而非click已派发；检查true limitations未伪称浏览器实测。已跑测试不重跑，只对新发现做必要验证。APPROVED或REJECTED，Important需准确路径与触发案例，Minor记账。

## 执行记录
- 独立覆盖审计APPROVED，D01–D06全PASS，Critical/Important/Minor全部0。保留真实客户MV3新DOM选择未实测限制。
