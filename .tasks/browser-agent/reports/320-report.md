# 320 read_form 通用控件补全报告

## 实现

- `read_form` 的默认发现顺序固定为原生 HTML 控件、ARIA/contenteditable 语义控件、受约束 DOM fallback。fallback 只接纳有外部标签或 ARIA 标签、单一可聚焦根、非按钮/链接/导航且不包裹可见原生控件的字段；不依赖业务中文、DeepFOS、happy-input、FormTree、tox 或 CSS hash。
- 同源且正文 `contenteditable=true` 的 iframe 作为一个外层逻辑字段读取，标题取最近单控件分组的外层标签；不遍历普通 iframe。跨源/不可访问 iframe 会被忽略，不中断其他字段。
- 未知 ARIA/DOM 控件保持 `supported:false`，写路径继续由原生支持或 `ControlledFieldAdapter` 决定；`readOnly` 只反映 disabled/readonly/ARIA 状态。读取不点击、不派发事件、不请求候选。
- 原生 select/datalist 与通过 `aria-controls`/`aria-owns` 显式关联且当前可见的 listbox/tree 读取候选。`optionsStatus` 区分 `exposed` 与 `not-exposed`；保留既有 `FieldOption.value: string`，缺稳定值的候选放入兼容可选 `optionLabels`，不伪造 ID。
- portal listbox/tree 与其触发器合并为一个逻辑字段；独立 listbox 仍可单独枚举。复合控件内的搜索输入、adapter 嵌套匹配和 iframe 内编辑正文都不会重复生成字段。
- 新增父节点/编辑器正文读取使用可见安全文本，排除 hidden、aria-hidden、不可见样式、script/style、input/textarea/select/option，避免隐藏技术值进入结果。

新增模块职责：

- `dom-control-roots.ts`：判定通用逻辑控件根。
- `dom-logical-controls.ts`：只读描述逻辑控件和值/候选元数据。
- `dom-host.logical-controls.test.ts`：覆盖跨站结构与真实页面等价形状。

三个新增文件在 R1 后分别为 55、103、90 行，均低于 300 行。

## 验证证据

- `pnpm exec vitest run browser-agent/tools/page/src/`：16 个测试文件、52 项测试全部通过。
- `pnpm --filter @einfach-agent/tools-browser-page build`：tsup、声明构建与声明说明符修复全部通过。
- `pnpm exec tsc -b`：通过。
- `node scripts/check-docs.js`：671 个 Markdown 文件检查通过（含本报告及独立审查记录）。
- `git diff --check -- browser-agent/tools/page`：通过。
- R0 编排原生 Chrome/MV3 完整桥复验：重载扩展后在独立新 document 执行 handshake → `page-call/readForm`，返回 `ok:true`、13 个逻辑字段。结果含 4 个 custom 选择器、系统环境 combobox、2 个 richtext、2 个文本字段、3 个 checkbox 与附件；外层标题、必填、`readOnly:false`/`supported:false` 和富文本正文均正确。5 个选择控件均为 `optionsStatus:"not-exposed"`，空 placeholder 未当作当前值。复验未调用模型、未填写/提交、未打开下拉。

回归覆盖包括：13 字段等价页面（4 个无 role 自定义选择、1 个语义 combobox、2 个同源富文本 iframe）、无 form/无组件前缀分组、原生 select/multiple/datalist、ARIA portal 与独立 listbox、稳定值与仅显示标签、disabled/required、placeholder 非当前值、adapter 优先、复合控件去重、读操作零事件、隐藏技术内容过滤、跨源 iframe 恢复，以及既有 identity/stale/cross-realm/write/validation 行为。

## R1 独立审查修复

330-review-r0 的 3 个 Important 已全部修复：

- 当前值的文本遍历会跳过任意嵌套深度的 `listbox`、`tree`、`option`、`treeitem` 子树。新增单选与多选嵌套 popup 回归，在没有明确 selected/checked 元数据时分别返回空字符串和空数组，不再把候选集合当值。
- DOM fallback 的后代 `data-placeholder` presence marker 与 class/ARIA placeholder 统一作为占位节点；根上的 placeholder 提示属性只用于发现和同文本判定，不会屏蔽另一个真实已选子节点。无 class/无 form fixture 现同时断言未选择为空与选择后为 `React`。
- 关联 popup 的暴露判定沿完整祖先链检查 `hidden`、`aria-hidden`、`display:none`、`visibility:hidden|collapse`。隐藏祖先下的 popup 返回 `not-exposed`；可见的真实空 listbox 仍返回 `exposed` 与空数组。
- 候选的 selected/checked 读取也在取得稳定 `data-value` 前检查完整祖先链；隐藏 selected 项不会仅凭技术 value 成为当前值。单选与多选嵌套 popup 回归都包含这类稳定值。
- 原生 datalist 的 `exposed` 候选优先于同一 input 上无关联 popup 的 ARIA `not-exposed`；`role="combobox"` 不会让已有原生候选被降级或被 `read_field_options` 拒绝。

R1 定向回归为 2 个文件 10 项全部通过；随后重新执行 page 全量 16 文件 52 项、page build、根 `tsc -b`、docs 与 diff check，结果全部通过。R1 未扩大写能力或浏览器操作范围。

R1 后编排侧没有可用 Chrome 窗口（CUA `cgWindowNotFound`），因此没有再次复验安装实例。上面的 13 字段结果是 R0 现场证据；R1 三个边界修复由新增 DOM 回归、page 构建及最终产物构建验证，不冒充第二次浏览器实测。

## 剩余限制

- DOM fallback 只报告有充分标签与单控件结构证据的可聚焦根；语义和结构都不足的任意 div 不会被猜成字段。
- 未渲染或远程树候选只报告 `optionsStatus:"not-exposed"`，不会自动打开控件，因此不承诺远程全集。
- 通用发现不提供未知控件写入；需要写入的站点组件仍应注册 `ControlledFieldAdapter`。
