---
id: '320'
title: read_form枚举真实页面自定义选择器与富文本控件
kind: leaf
parent: browser-agent
depends_on: []
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/tools/page/
---

最新用户：read form tool 没有把下拉框啥的，都加进来啊。请修复read_form真实遗漏。仅改page工具包与自己的报告，复用既有DomPageHost/controlledAdapters，不建framework或新包。先读CLAUDE、.project-lines相关工具线与one-file-one-thing，普通新/大改文件≤300行，保留所有既有未提交改动。前态reports/320-before文件后缀.before，base差异320-prechange.diff。

## 用户最新约束（优先于下文旧现场导向表述）

用户：“记住你是通用tool 应该做的抽象一点，通过传统表单form 还有一些不按照传统表单的。可以先通用，然后再通过dom或者其它更抽象的 来获取里面的一些控件”。

因此生产默认发现必须是通用结构：原生HTML表单/文档外控件 → ARIA/可编辑等语义 → 有约束的DOM字段结构与交互根候选；已有ControlledFieldAdapter承担站点特殊适配。不要将happy-input/DeepFOS/FormTree/tox等站点或库名作为默认识别必需条件，不依赖哈希。现场DOM只用作验收样本；另加去掉组件前缀、没有form标签的跨站点结构fixture，证明通用抽象有效。fallback证据不足可以kind=custom/unknown并supported=false，不能凭tabindex就把任意按钮/导航/容器当表单字段。识别与描述仍在当前工具包内职责拆分，不另建包/插件框架。

请把此顺序和adapter边界写入本包README作为已确认设计约定（这是产品设计文档，不创建用户全局记忆skill）。FieldOption.value保持原有必填string合同；没有稳定value的可见候选另加兼容可选metadata（如optionLabels）说明，不通过改变旧公共字段必填性破坏消费者。新增父节点文本/iframe正文读取要过滤隐藏及敏感技术控件，而非直接textContent扫全树。

## 原生Chrome现场证据（2026-09-20）
用户当前项目问题详情页，read_form仅7字段：问题标题、问题链接、3checkbox优先级、file相关附件、系统环境。AX可见但漏读：工单类型、相关产品组件、所属部门、相关项目（四个自定义树选择）、问题描述和解决方案（两个same-origin iframe richtext）。预期该页至少13个逻辑控件且标题对应正确，不把搜索内部input重复为字段。

只读DevTools DOM实际形状如下（不依赖哈希）：
- 外层 `<div class="deepUX-row deepfos-business-form-item ..." data-testid="issue_type_f_object_select_NKAf"><div class="deepUX-form-item-label ..."><label title="工单类型"><em class="label index-module_required__fy0op">工单类型</em></label></div><div class="deepUX-form-item-control ..."><div class="deepUX-form-item-control-input">...`
- 工单类型/所属部门/相关项目控制树：`div.edit-module_selectWarp__LKGG8 > div.edit-module_selectContentAll__7vuDa > div.happy-input.HappyInput-module_happyInput__-Foqq[tabindex="1"] > div.FormTree-module_placeholder__VW17e`（文本请选择，部门为请选择自己所在部门）；随后空div和svg图标。根无role/aria-haspopup，没有原生input。根另有sizeMiddle/hasSuffix CSS类。
- 相关产品组件同树，happy-input根另有 `FormTree-module_multipleContainer__tAsVs`。
- 系统环境：`div.happy-input.HappySelect-module_happySelect__ktrt-.edit-module_select__WAlX6[role="combobox"][tabindex="0"] > div.SelectLabel-module_present__42lLu.SelectLabel-module_placeholder__5QL3T`；请选择是placeholder，不是当前值。
- 问题描述/解决方案最近表单项里 `<iframe class="tox-edit-area__iframe" title="富文本区域" srcdoc="...">`；contentDocument.body.id=tinymce，body[contenteditable="true"]，aria-label=编辑区。按Alt+0键打开帮助。可同源访问。字段名应该来自外层就近表单项label，而非“富文本区域/编辑区”。两个iframe文档可用，但本次不要广泛遍历iframe站点页面，仅读嵌入编辑器正文作为单个root控件元数据。

## 验收合同
- D01 枚举native原已有input/textarea/select及新增逻辑控件：语义combobox/listbox、带listbox/tree popup触发器、当前现场happy-input自定义单选/多选树选择、contenteditable和same-origin富文本editor iframe。不要泛匹配每个div/tabindex/button；现场happy-input自定义识别需组件结构证据（form-item/selectWarp/FormTree等），不可硬编码业务字段中文或CSS哈希。原生input[list]可复用datalist选项。其他无证据组件不盲目声称全站支持。
- D02 每个逻辑控件只有一个稳定field id，nested输入/内部search不重复、controlledAdapters优先且向后兼容；replacement/stale、cross-realm语义保持。对hidden/password排除不退化，隐藏原生技术input不被以父容器text绕出值。自定义只读探测真实disabled/aria-disabled/readonly等，不再因为无法自动写入就readOnly:true。supported:false明确仍代表缺少写适配，写路径继续拒绝未知控件；不做模拟点击/选项写入。
- D03 描述title,label,kind,当前值或可见选择文本、多选数组/明确多选种类、required/readOnly、已暴露options。label复用dom-field-labels，让新增根纳入单控件表单项判定，邻近分组标题不串。能从required/aria-required/就近标题required类识别当前页面必填；不要把整个大form上别处required标记套全表。字段可编辑与工具可写是不同概念，在guide中明确。
- D04 只读options：native select/datalist和明确aria-controls/owns关联listbox/tree里的已渲染选项；不打开下拉框、不触发click/input/change、不请求接口、不读React私有状态。必须区分尚未暴露DOM选项和真的空列表，可加兼容可选metadata（例如optionsStatus）并文档说明；不要编造value ID/把placeholder当已选值/盲扫其他字段选项/承诺远程树全量选项。选项缺稳定value时可只报告显示文本并说明限制，不可把业务label当未经证实的ID。
- D05 回归覆盖现场形状（四树选择+系统combobox+2iframe）、原生select/multiple/datalist、语义自定义选项/disabled/required、复合控件去重、adapter优先、非控件排除、读操作零事件、hidden/password不泄漏、cross-origin iframe异常可恢复；就近测试不要把产品DOM测试和已知mock回调镜像化。维持全部page测试通过。

scope只读read_form能力与必要read_field_options兼容说明/metadata，不扩大select_option/fill_fields到未知自动点击。若新增metadata需导出类型，保留兼容可选字段。必要的only-read复合能力拆一个职责清晰文件，不要把dom-fields塞到超过300行。

执行验证：pnpm exec vitest run browser-agent/tools/page/src/；pnpm --filter @einfach-agent/tools-browser-page build；pnpm exec tsc -b；node scripts/check-docs.js。构建extension/embedded与原生浏览器QA由编排做。禁止浏览器/CDP、钥匙串/真实模型/凭据、pnpm install/lock更新、commit/push/远程issue、派子agent、改其他任务账本。

只写报告 /Volumes/work/ai/web-agent/.tasks/browser-agent/reports/320-report.md：实现和证据、精确测试计数、剩余限制。不要写根reports。

## R1 独立审查修复

330-review.md 提出3个Important，均在当前只读通用语义内，采纳修复。只改既定 page 包范围，原报告320-report.md补 R1 证据。

1. 通用值读取不能穿过任何层级 listbox/tree/option/treeitem 子树把候选集合当当前值；single 与 multiple 都覆盖。优先读取明确 selected/checked 元数据；如仅展示候选且无选中，返回空值。不要用一个新的站点 CSS 名单规避。
2. 区分字段容器的 data-placeholder 提示属性与后代占位节点；确保既有无 class fixture `<span data-placeholder>Choose</span>` 在未选择时 value 为空，及选择后数据正确；presence/true marker 和 aria-placeholder 不要误屏蔽实际已选值。
3. 已关联 popup 若自身或祖先 hidden/aria-hidden/display:none/visibility:hidden|collapse，应为 not-exposed，不能 exposed 空列表；可见真实空 popup 仍可 exposed + []。过滤候选与选中项也遵守可见性。

补回归，覆盖这3种具体结构及 single/multiple，运行page相关回归、page build、根tsc与diffcheck。不要运行浏览器或改其他包。新模块若需分拆仍遵守单一职责及≤300。最终发DONE并更新报告；编排随后重建extension/embedded并独立复审。

R1收尾追加同合同检查：selected/checked必须在读取stable value前过滤隐藏祖先；原生select/datalist的exposed候选不可被ARIA not-exposed覆盖。两项均修复并在既有回归中强化断言。最终page16files/52tests绿色，待330复审。

收口：330 R1独立PASSED，全部Important关闭。最终page52测试、桥接/预览13测试、page/extension/embedded构建、根tsc及治理门禁通过；320-verification.md与320-browser-check.md记录产物/实机边界。无commit/push/远程issue。
