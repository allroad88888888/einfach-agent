# 040 R1 独立复审

结论：**PASSED**

复审范围仅限原审查的三个发现及修复的直接影响。依据 `040-ui.md`、`040-report.md` 的 R1 追加记录、`040-scope-r1.diff`、原 `040-review.md` 和当前相关源码静态核验；未启动浏览器，未重跑已报告通过的测试，未修改产品代码。

## 原发现复核

- ✅ **Important：缺失工具引用会静默丢失**已修复。`AgentEditor.tsx` 将已保存 profile 中不在当前 `client.core.tools.list()` 的工具合并为勾选的“已缺失”项；保存前检查仍被选中的缺失引用并返回文本错误，不调用 `saveAgent`。用户只有明确取消选择后才能保存。R1 测试通过真实注册后注销 `retired_tool`，验证缺失项可见、首次保存不增加 revision 且保留引用、取消选择后才更新 revision 并移除引用。该路径同时处理缺失 Skill；缺失连接和模型也保留可见选项并禁用保存，避免隐式替换。
- ✅ **Minor：README 未承接异步初始化失败**已修复。README 示例先渲染 loading 状态，以 `try/catch` 包裹 `createBrowserAgent`，失败时渲染 `role="alert"` 的配置加载错误；成功时仍由宿主持有并最终 dispose client，符合外部初始化边界。
- ✅ **Minor：“新建”不能清空当前新建草稿**已修复。Agent、Skill、Connection editor 均增加递增 draft key，`beginNew()` 即使在 `editing === undefined` 时也会改变 form key 并重挂载；Skill 同时清空受控 resources。R1 测试分别填写三个新建表单后再次点击“新建”，验证字段恢复为空。

## 直接影响核验

- ✅ 当前公开工具仍来自 `client.core.tools.list()`；R1 测试加入 call-timing 工具并验证它不出现在配置界面，修复没有扩大到内部协议工具。
- ✅ 缺失引用错误只阻止存在且仍勾选的缺失项；明确取消后可保存，正常已注册工具和 Skill 的提交路径保持不变。
- ✅ 缺失连接/模型不会被 effect 自动替换；用户选择当前连接时才由 `chooseConnection` 设置该连接的首个模型。
- ✅ 修改限于 UI 包源码、测试、样式、README 和执行报告所述范围；未见因修复引入新的 Critical、Important 或 Minor 问题。
- ✅ 执行报告记录 R1 后组件测试 8/8、JS/CSS 与声明 build、脚本语法、文档与 diff 检查通过；依约未重复执行。

最终判定：**PASSED**。
