# 450 最新会话重复调用调查（2026-09-21，已定位观察链路缺口，未实施修复）

## 现场证据

检查当前 Chrome 插件的“项目问题核对”会话。最新用户输入是“开发责任人 选 汤平n”。
运行已被 core 终止，页面显示“运行出错 检测到重复工具调用循环”，并非仍在后台无限运行。

从当前会话 UI 的原始参数 / 回执只读统计出 43 次已展示调用：

| 工具 | 次数 |
|---|---:|
| request_tool_schema | 6 |
| read_form | 1 |
| read_dom | 27 |
| click_dom | 7 |
| wait_for_dom | 1 |
| press_dom_key | 1 |

43 个回执中未见顶层 error 或 ok:false。页面绑定的 documentId 一致；本次证据不支持把问题归因为页面绑定失效。
工具回执没有异常，不代表业务选择已经完成。

## 已确认的失效链

1. read_form 已找到“开发责任人”（field-14），值为空，readOnly:false、supported:false。后者表示该表单宿主没有直接写适配器，不表示页面禁用。
2. 模型读取该字段的 DOM，拿到 dom-393…dom-402，大部分仅有空 name 的 div 与 parentRef；点击了 dom-401、400、402、399 等不同层级。
3. 首次点击之后，wait_for_dom 以全页 text:"汤平"、condition:"present" 等待，立即返回 dom-28（title:"汤平"）。后续读取 dom-23 / dom-5 的上下文证明这是页面顶栏用户区域，不能作为责任人候选出现的证据。
4. 模型随后猜测 .ant-select、dropdown、option、listbox 等选择器；没有稳定地建立“目标字段 → 当前弹层 → 候选”的关系。
5. 调用序列扩散到系统环境（dom-281）和咨询类型（dom-203），而非持续限定开发责任人。日志中的系统环境初值与调查时显示值相同；没有据此推断其业务值被改动。
6. 后期反复返回空结果，直到 core 的相同参数重复检测终止运行。

## 实际浏览器对照

- 对目标控件只读查看 DOM：可聚焦 div，tabindex="1"，没有原生 / ARIA disabled 或 readonly 标记，实际绑定 onClick / onFocus 等事件。
- 用 CUA 手动点击一次“开发责任人”，人员列表正常展开，包含搜索框；没有选择人员，没有保存或提交。
- 在实际弹层仍打开时，只读执行模型最后反复使用的选择器：

```css
[class*="dropdown"], [class*="option"], [role="option"], [role="listbox"]
```

结果仍为 0。真实弹层是 TilingPopup / FormTree 的普通 div，没有 listbox role，且包含可见搜索 input。
因此“此选择器没有结果”不能推断“弹层没打开”。这里的具体 class 只作诊断证据，不应写成通用工具的业务特判。

边界：手动点击成功不证明先前每次合成点击都成功；原始点击是否打开后被漏读、是否涉及焦点 / 异步加载差异，现有回执无法还原。不能凭 dispatched:true 作结论。

## 代码位置与缺口

- `browser-agent/tools/dom/src/dom-node.ts:5` / `:31`：返回属性白名单不含 class / tabindex，普通控件结构几乎退化为匿名 div 链。没有表示控件与弹层关系的通用观察结果。
- `browser-agent/tools/dom/src/dom-reader.ts:17`：候选主要以文本 / 标签存在性筛选；无文字但可交互的非原生节点可能被丢弃。`:29` 未指定 scopeRef 时默认扫描整个文档。
- `browser-agent/tools/dom/src/waiter.ts:19`：present 仅判断当前查询非空，不要求点击后的新节点，也不验证候选属于目标控件。本例的全页姓名等待符合 API 条件，却不符合业务目标。
- `browser-agent/tools/dom/src/dom-actions.ts:12` 与 `dom-host.ts:24`：点击发出事件后返回 dispatched:true；没有弹层出现 / 值改变的验证。文档已经说明这是“已派发”，但缺少下一步的可靠结构化观察结果。
- `packages/agent-core/src/runtime/core/plugins/loopGuardPlugin.ts:106` / `runtime/shared/toolRepetition.ts:97`：只对无正文的工具轮累计“工具名 + 完整参数”签名，阈值 3；出现正文会清零。改变 scopeRef、selector 或 limit 都换签名，不会识别“换参数但仍无进展”。本次保护最终生效，但未能早期收敛。
- 另有 UI 误报：`browser-agent/ui/src/chat/ConversationTimeline.tsx:52` 用 /error|failed|失败/i 匹配整个回执字符串。两个 request_tool_schema 明明 loaded:true，guide 中含错误相关词也被标为失败。这是显示问题，不是本次模型循环的执行错误。

## 建议修复顺序

1. 在现有 read_dom / click_dom / wait_for_dom 上补足有界的交互结构与点击前后变化观察；让模型从实际返回结构定位弹层，不猜网站框架类名。
2. 等待与验证限定在关联弹层，或相对操作前快照的新变化；不能把全页已经存在的同名文本视为新候选。
3. 对连续无变化 / 相同空观察提供可解释反馈并收敛重试，必要时使用现有 ask_user_question；保留 core 循环保护，不能靠调高阈值继续跑。
4. UI 按结构化结果判断成功 / 失败，区分“动作已派发”与“业务效果已验证”。

本轮只调查并记录：未修改生产代码、未重启模型运行、未删除会话、未修改业务字段、未重载扩展或刷新业务页面。诊断记录与截图保留于 CUA 工具输出；未创建远程 issue。
