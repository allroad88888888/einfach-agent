---
id: '300'
title: 撤销回填与重做独立验收
kind: leaf
parent: browser-agent
depends_on: ['290']
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files: []
---

只读独立审查290任务验收U01–U04，只可写 /Volumes/work/ai/web-agent/.tasks/browser-agent/reports/300-review.md。读290任务、290-report.md、290-scope.diff（相对HEAD全范围，含已有未提交增量），并结合290-before/及290-delta.diff分清本次增量；290-browser-check.md为编排原生浏览器证据。禁止修改产品、浏览器、再委派、重复已绿测试、commit/push。

检验成功撤销精确回填并在busy停止后聚焦、同文本连续撤销不漏focus、失败不改草稿；消息原位重做多入口和全撤入口；重做已有结果不重跑模型，来源轮恢复才清未编辑回填，编辑草稿不误清；现有session/client隔离设置返回。避免复制core历史；新增临时草稿来源不是历史副本。重点审源码与真实client测试；外部业务副作用既有解释须保留。每条验收✅/❌证据，发现Critical/Important/Minor；不把未测当实测，也不因测试场景少就臆造缺陷。
