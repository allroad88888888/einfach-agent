# 320 `read_form` 通用控件补全独立审查

## 结论

**CHANGES REQUESTED**。发现 3 个 Important 缺陷；无 Critical。D01、D02 通过，D03–D05 未完全通过。问题集中在通用逻辑控件的当前值与候选暴露判定，不涉及写路径或副作用能力扩张。

本审查只读核对 `320-read-all-form-controls.md`、`320-report.md`、`320-scope.diff`、`320-delta.diff` 与当前源码；按任务要求未操作浏览器、未重跑已通过测试。320 报告中的原生 Chrome 后验证据按既有事实采信，不把未另行复验写成失败。

## Findings

### Important 1：嵌套 popup 的全部候选文本会被误报为当前值

`dom-logical-controls.ts` 的 `selectedValues` 仅在遍历控件**直接子元素**时排除 `role=listbox/tree`。常见结构 `combobox > 普通 wrapper > listbox > option` 中，wrapper 不具 popup role，于是 `safeText(wrapper)` 会收集其下所有 option 文本；单选返回拼接后的所有候选，多选则把整段候选文本作为数组项。即使 popup 通过 `aria-controls` 明确关联，当前实现仍会在没有 `aria-selected/aria-checked` 时继续读取触发器子树，无法避免这个结果。

这违反 D03/D04 的“当前值或可见选择文本”与“不要把全部 options 当值”。现有测试只覆盖 portal popup（popup 不在触发器子树），没有覆盖嵌套一层 wrapper 的现实结构，因此不会捕获该回归。

建议在当前值文本遍历中排除任何位于 listbox/tree 子树内的节点，而不只检查直接子元素；单选和多选均增加嵌套 popup 回归。

### Important 2：presence 形式的 `data-placeholder` 被发现器认作 placeholder，却被值读取认作真实值

`dom-control-roots.ts` 以 `[data-placeholder]` / `hasAttribute('data-placeholder')` 接纳通用 fallback；但 `dom-logical-controls.ts` 的 `isPlaceholder` 只接受 `data-placeholder === "true"`。因此新增“无 class、无 form”的跨站 fixture 中 `<span data-placeholder>Choose</span>` 会被识别为控件证据，却会把 `Choose` 返回为当前值。

这直接违反 D03/D04 的“placeholder 不当值”。现有用例只断言该字段的 label/kind，没有断言 value，报告却将“placeholder 非当前值”概括为已覆盖，证据范围过宽。

建议统一 placeholder 判定语义（至少 presence marker 在发现和值读取两处一致），并对该去前缀 fixture 明确断言空值。

### Important 3：隐藏祖先下的关联 popup 会被误报为 `optionsStatus: exposed`

`linkedPopup` 调用的本地 `hidden` 只检查 popup 元素自身。若 popup 挂在 `display:none`、`visibility:hidden`、`hidden` 或 `aria-hidden=true` 的祖先下，而 popup 自身无这些属性，`linkedPopup` 会接受它。随后 `safeText` 会因祖先隐藏而过滤 option label，最终返回 `optionsStatus:"exposed"` 和空候选，而不是 `not-exposed`。

这会混淆“已渲染且确实为空”和“当前不可见/尚未暴露”，违反 D04 对仅报告明确关联、可见候选及两种状态的区分。现有测试覆盖 popup 自身可见的 portal，没有覆盖隐藏祖先。

建议让 popup 可见性检查沿祖先链执行，并增加隐藏容器下关联 popup 的回归，断言 `not-exposed`。

## D01–D05 验收

- ✅ **D01**：候选顺序覆盖原生控件、ARIA/contenteditable 语义与受约束 DOM fallback；同源 editable iframe、ARIA popup trigger、listbox 和通用 focus root 均在当前包内实现。fallback 不依赖 DeepFOS、happy-input、FormTree、tox、业务中文或哈希；按钮、链接、nav 与包裹可见 native control 的根被排除。
- ✅ **D02**：adapter 优先并对嵌套匹配取外层根；逻辑根、内部 native input 和受控 portal 去重。hidden/password 不直接枚举，安全文本不读取 input/textarea/select/option；未知控件保持 `supported:false` 且 `readOnly` 只取真实只读/禁用属性，写路径没有新增自动点击能力。
- ❌ **D03**：label、required、richtext 外层标题、disabled/readonly 与 supported 分离总体符合合同，但 Important 1、2 会把候选列表或 placeholder 错报为当前值。
- ❌ **D04**：原生 select/datalist 和显式 ARIA 关联候选保持 `FieldOption.value` 必填，缺稳定值使用 `optionLabels`，读取本身不交互；但 Important 1 会混淆候选与当前值，Important 3 会把隐藏 popup 误判为 exposed。
- ❌ **D05**：报告记录 page 16 files / 50 tests、包 build、根 `tsc -b` 与 docs 均通过，且现场 13 字段后验支持目标页面主路径。测试也覆盖 adapter、零事件、跨源 iframe、原生候选与去组件前缀结构；但上述三个通用边界缺少有效断言，其中 presence placeholder 已出现在 fixture 中却未检查 value，因此回归覆盖尚未闭合。

## 结构与范围

- `dom-control-roots.ts`、`dom-logical-controls.ts`、`dom-host.logical-controls.test.ts` 分别为 55、83、78 行，职责集中且低于 300 行。
- 本轮生产逻辑仍位于 page 工具包，站点特殊行为继续由既有 `ControlledFieldAdapter` 承担；没有新增插件框架、业务字段硬编码、哈希依赖、自动打开候选、请求远端选项或未知控件写入。
- `FieldOption.value: string` 合同未改为可选；新增 `optionLabels` / `optionsStatus` 为可选兼容元数据。
