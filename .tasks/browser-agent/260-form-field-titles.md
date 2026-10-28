---
id: '260'
title: 表单读取返回实际字段标题而非输入占位
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: '080'
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/tools/page/**
---

用户实测反馈read_form没有获取title。编排已在用户真实Chrome的“项目问题详情”只读核对：结果fields前两个input的label都是“请输入”；页面实际显示“问题标题”和“问题链接”，还有系统环境combobox。输入本身title/name为空，标题在外层表单项，不可只加input.title就算完成。

真实DOM（原生DevTools只读观察）：input → div.happy-input → div.deepUX-form-item-control-input → div.deepUX-form-item-control.deepUX-form-item-control-col-24 → div.deepUX-row.deepfos-business-form-item（附CSS-module class）。该最小form-item中另有label或form-item-label/title。系统环境role=combobox也在deepUX-form-item-control-input下，外层deepfos-business-form-item。完整祖先标题编排继续获取后传回；实现无需等待，不要硬编码业务字段文案。

阅读CLAUDE.md、.project-lines/SKILL.md和工具家族线，以及one-file-one-thing skill。保留当前所有未提交改动，不install/改lock/commit/push，不操作浏览器/钥匙串、不再派agent；仅本任务范围产品与reports/260-report.md。

## 结果合同 F01–F03

- F01 fieldLabel在原有明确aria/label关系基础上支持控件title和就近单一表单项的可见标题（含邻近label/span的title）。优先有意义字段标题，placeholder是最终fallback；同一行有多个控制/嵌套form/多个label时不要串到其他字段或泛读整个form文字。规范aria-labelledby顺序、多个关联label、多余必填星号/冒号可按稳健规则处理，避免破坏checkbox本身选项标签。
- F02 DOM采样必须保持只读，元素身份id、禁止password/hidden、只读/unsupported、跨realm iframe现有规则不变。外层form标题和页面document.title可以在FormSnapshot添加兼容可选title/url作为上下文，但核心用户问题是字段语义标题，不能用页面标题替代。
- F03 真实形状fixture回归：两个相同“请输入”placeholder在独立嵌套div表单项下，分别读“问题标题/问题链接”；span title无for；title属性；aria明确优先；重复标题不串；不把说明/错误/选项混进字段名；role=combobox也有label。若本包已有文本可见性辅助可复用，别造框架。必要新增dom-field-labels.ts单职责，普通文件<=300。

运行page包相关测试、包build，报告结果与改动路径。260不写extension/network/UI，最终整合构建由编排做。工具说明和本包README就近更新。
