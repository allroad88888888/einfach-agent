# 020 R3 同源 iframe 集成复审

结论：**PASSED**

本次只审查 R3 相对 R2 的同源 iframe / cross-realm 差异；R1/R2 已通过的其他实现未重复审查，也未重跑报告已证明的测试、tsc 或 build。

## 实现核对

- **跨 realm 原生控件识别正确。** `browser-agent/tools/page/src/dom-fields.ts:6-17` 以 HTML namespace 和 `localName` 定义 input、textarea、select 守卫，不再依赖创建 host 所在 window 的构造器。读取种类、值、选项、敏感字段过滤、readOnly 与 supported 判定在 `dom-fields.ts:27-55` 全部复用这些守卫。
- **填充与校验路径完整迁移。** `browser-agent/tools/page/src/dom-write.ts:7-32` 的可写检查、checkbox/radio、单选和多选分支均使用 realm 无关守卫；`browser-agent/tools/page/src/dom-host.ts:24` 的实际值回读以及 `dom-host.ts:51-59` 的约束校验也使用同一判据。不存在读取已识别、写入或校验仍回退到父 realm `instanceof` 的分叉。
- **事件来自控件所属 realm。** `browser-agent/tools/page/src/dom-write.ts:3-6` 优先使用 `element.ownerDocument.defaultView.Event` 构造 `input` / `change` 事件，适用于传入的同源 iframe Document；仅在 Document 没有关联 window 时使用环境 Event 作为后备。
- **标签识别保持可靠。** `browser-agent/tools/page/src/dom-fields.ts:18-25` 使用 `ownerDocument` 查询 `aria-labelledby` 和显式 label，并通过 `closest('label')` 支持包裹标签，不再使用父 realm `HTMLElement` 判断。

## 回归证据核对

`browser-agent/tools/page/src/dom-host.iframe.test.ts:17-39` 使用真实 `iframe.contentDocument`，覆盖 text、select、multiple select、checkbox、password/hidden 排除、显式与包裹 label，以及 read → fill → validate 闭环。断言校验结果包含每个请求的实际值，能够发现只读成功但填充/回读失败的半修复。

`browser-agent/tools/page/src/dom-host.iframe.test.ts:41-56` 创建两个真实 iframe Document 和各自 host，并发读取和写入同名字段，断言字段身份、标签和值没有跨 Document 混用。队列仍以原有 `WeakMap<Document, ...>` 为键，R3 未改变其隔离或 FIFO 行为。

## 原保护回归

- password/hidden 仍在 adapter 匹配前和最终候选阶段过滤：`dom-fields.ts:17,43-51`。
- adapter 仍先于 native 候选并排除重复原生处理：`dom-fields.ts:45-51`。
- native disabled/readOnly 强制约束仍由 `nativeReadOnly` 和 `assertWritable` 执行：`dom-fields.ts:13-16`、`dom-write.ts:7-14`。
- 字段身份、PageRef、取消、写后实际值比较和按 Document FIFO 的产品代码没有退化；R3 只替换原生类型判据及事件构造。
- 严格限定 HTML namespace，避免仅凭 tag 名把 SVG/XML 同名元素误判为 HTML 表单控件。

报告记录新增 iframe 用例修前 2 失败、修后 2 通过；全包为 8 文件 25 测试，并记录 tsc、build、docs 与 diff check 通过。公开接口未变化，说明也没有将同源 iframe 支持扩大为跨源 iframe 访问。

未发现 Critical、Important 或 Minor 问题。
