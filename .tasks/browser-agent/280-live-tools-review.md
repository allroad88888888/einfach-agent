---
id: '280'
title: 表单标题与插件自动采集的独立验收
kind: leaf
parent: browser-agent
depends_on: ['260', '270']
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files: []
---

独立只读审查260/270合同、执行报告、范围diff、编排真实浏览器证据；只写reports/280-review.md。逐条F01–F03/N07–N10给证据与结论。核心是用户当前真实页面字段title被识别、插件加载即有真实监听而非Agent工具才启动、列表无需start、初始化缓存不会5分钟悄悄消失；不绕授权/不引入共享会话泄漏/不篡改网页fetch/XHR原行为。与前态diff区分既有修改，普通文件职责/行数规则。禁止浏览器/重跑已绿测试/修改产品/再委派。

可先独立审260已交付面：reports/260-report.md与260-scope.diff，相对reports/260-270-prechange.diff排除前态。270仍实现中，270-scope.diff/270-report.md完成后编排通知继续。真实浏览器现象见reports/260-270-browser-check.md，最终构建后编排追加实际后验；不因另一叶尚未交付而编造发现或宣布全通过。
