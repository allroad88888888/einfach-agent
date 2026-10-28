# 320 `read_form` 通用控件补全 R1 独立复审

## 结论

**PASSED**。首轮 `330-review-r0.md` 的 3 个 Important 均已修复，指定相邻边界也已闭合；未发现新的 Critical、Important 或 Minor 问题。D01–D05 全部通过。

本轮只读复核刷新后的 `320-report.md`、`320-scope.diff`、`320-delta.diff`、相关源码与回归；未操作浏览器、未重跑报告中已通过的测试，也未修改产品代码。R0 的原生 Chrome 13 字段证据继续作为修复前现场主路径证据；R1 无可用 Chrome 窗口，因此不把 DOM 回归冒充安装实例后验。

## 首轮 Findings 关闭

- ✅ **嵌套 popup 不再成为当前值。** `currentText` 沿文本节点到控件根的完整祖先链排除 `role=listbox/tree/option/treeitem`，不再只检查直接子元素。单选与多选嵌套 popup 回归分别断言空字符串和空数组；隐藏且带稳定 `data-value` 的 selected/checked 项也先经 `hiddenInTree` 过滤，不会绕过可见性成为当前值。
- ✅ **presence `data-placeholder` 与值读取语义统一。** `placeholderNode` 对非根后代使用 `hasAttribute('data-placeholder')`，与发现器一致；根上的 placeholder 提示仅在最终文本与提示相同时清空，不会吞掉并列的真实选择文本。无 class、无 form fixture 现同时断言未选择值为空，以及 presence placeholder 与真实值共存时返回 `React`。
- ✅ **隐藏祖先下的关联 popup 返回未暴露。** `linkedPopup` 改用沿完整祖先链检查 `hidden`、`aria-hidden`、`display:none`、`visibility:hidden/collapse` 的 `hiddenInTree`。`read_field_options` 回归证明隐藏容器内 popup 得到 `optionsStatus:not-exposed` 并受控失败，同时可见的真实空 listbox 仍得到 `exposed` 和空 options。

## 相邻边界复核

- ✅ selected/checked 在读取稳定 `data-value` 前先过滤完整隐藏祖先；单选和多选嵌套回归分别包含 `hidden` 与 `aria-hidden` 下的稳定值，未泄漏为当前值。
- ✅ 原生 `input[list]` 先生成 datalist 的稳定 options 与 `exposed` 状态；随后 ARIA 描述只有在语义候选实际 `exposed`，或原结果尚无状态时才覆盖。因此 `role=combobox` 加缺失 `aria-controls` 不会把已有 datalist 降级成 `not-exposed`。回归直接断言该组合仍返回 `X-ray/x` 和 `exposed`，与 `read_field_options` 合同兼容。
- ✅ R1 只收紧只读文本/可见性判断及候选元数据合并优先级，没有新增点击、事件、请求、远程候选、未知控件写入或站点专用识别。

## D01–D05 验收

- ✅ **D01**：默认发现按 native、ARIA/contenteditable、受约束 DOM fallback 工作；支持非传统 form、去组件前缀结构、同源 editable iframe、combobox/listbox/tree popup。生产发现不依赖 DeepFOS、happy-input、FormTree、tox、业务中文或 CSS hash。
- ✅ **D02**：adapter 优先、复合根与内部 search/native 去重，portal 不重复枚举；hidden/password 不直接暴露，也不经父文本泄漏。`readOnly` 与 `supported` 分离，未知控件仍不可写。
- ✅ **D03**：外层 label 优先于通用 iframe title，required 限定最近单控件项；当前值、多选数组、placeholder、disabled/readonly 和 supported 语义均有实现与回归。R1 已关闭两类当前值误报。
- ✅ **D04**：只读取原生 select/datalist 和明确关联且可见、已渲染的 ARIA 候选；`exposed` 与 `not-exposed` 可区分。`FieldOption.value` 继续必填，缺稳定 ID 的候选走可选 `optionLabels`，不伪造值；读取不触发交互。
- ✅ **D05**：报告记录 R1 定向 2 文件 10 项及 page 全量 16 文件 52 项通过，随后 page build、根 `tsc -b`、docs 与 diff check 通过。新增断言精确覆盖首轮三个问题、隐藏 selected 稳定值及 native datalist+ARIA 兼容；既有现场等价 13 字段、adapter、零事件、跨源 iframe 恢复等覆盖保持在位。

## 结构与证据边界

- 新增职责文件 R1 后分别为 55、103、90 行，均低于 300 行；逻辑仍在 page 工具包内，站点特殊行为仍由既有 `ControlledFieldAdapter` 承担。
- R0 原生 Chrome 完整桥曾返回预期 13 个逻辑字段，且没有填写、提交、打开下拉或模型调用。R1 修改集中于首轮边界；编排记录本轮 CUA `cgWindowNotFound`，故最终结论以静态实现、针对性 DOM 回归和构建证据关闭这些边界，不声称完成第二次安装实例复验。

## Findings

无。
