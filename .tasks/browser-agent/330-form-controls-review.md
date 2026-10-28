---
id: '330'
title: read_form控件补全独立验收
kind: leaf
parent: browser-agent
depends_on: ['320']
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files: []
---

只读独立审查320-read-all-form-controls.md D01–D05、reports/320-report.md、320-scope.diff，并结合320-delta.diff/320-before前态排除旧增量。证据320-browser-check.md修复前已核实，后验由编排补；不能把尚未完成后验编造为缺陷或已通过。只写绝对路径 /Volumes/work/ai/web-agent/.tasks/browser-agent/reports/330-review.md，不改其他文件、不浏览器/再委派/重跑已通过测试。

看实际候选发现与去重，原生/adapter兼容；当前四happy树+combobox+两richtext，label不能被generic iframe.title抢走；disabled/readonly与supported区别、required只关联当前项；options仅明确关联可见/已渲染DOM、无值ID不伪造，不把placeholder当值；hidden/password不绕父元素文本泄漏；只读无自动点击请求、跨origin iframe异常不中断全表。保证不是硬编码业务字段/哈希，以及副作用能力范围不扩展。逐条✅/❌证据，缺陷Critical/Important/Minor，不靠假设扩大范围。普通文件≤300。

用户随后明确“通用tool”优先：重点检查320任务“用户最新约束”，默认发现不能依赖happy-input/FormTree/DeepFOS/tox等组件名字，必须有非传统form和去前缀结构测试。站点特殊适配仅现有adapter，当前现场只是验收样本。FieldOption.value必填合同不变，新显示候选信息兼容可选。

R1: 首轮CHANGES REQUESTED，3个Important采纳并下发320；完整首轮证据保留330-review-r0.md。复审仅看这3项及相邻回归，不重跑绿色测试。

收口：330 R1独立PASSED，全部Important关闭。最终page52测试、桥接/预览13测试、page/extension/embedded构建、根tsc及治理门禁通过；320-verification.md与320-browser-check.md记录产物/实机边界。无commit/push/远程issue。
