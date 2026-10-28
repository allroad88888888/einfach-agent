---
id: '230'
title: 对话优先布局与配置入口独立覆盖验收
kind: leaf
depends_on: ['220']
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files: []
---

独立只读审查220-chat-first-layout.md C01–C05。输入 reports/220-report.md、220-scope.diff、220-prechange.diff、220-browser-check.md。报告只写 reports/230-review.md，不改产品/账本，不重复跑已绿测试，不浏览器/CDP/install/钥匙串/真实APIKey/commit/push/再派发。
读 Apple HIG /Users/dol/.codex/skills/apple-hig-design/SKILL.md 及相关参考；用户明确 Web 右上角齿轮优先于 macOS 原生菜单建议。核默认内容明显减量、消息区真占主要高度、composer固定在组件底部、设置导航完全可达、图标a11y/焦点返回、hidden聊天不能残留可聚焦元素、draft/session保留与client隔离。保留真实CRUD/模型预填key空/等待确认/停止/恢复/撤销语义；权限和业务层无回退。
图证由编排原生 CUA 提供，不能用测试绿冒称视觉通过；缺图证可先源审查并报告待补，不虚构。Critical/Important实际发现退回，Minor记账；最终报告 PASSED/REJECTED 并逐条覆盖C01–C05。
