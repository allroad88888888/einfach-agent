# 160 独立验收与覆盖审计

结论：**REJECTED**

## Findings

### Critical

无。

### Important

1. **公开视图切换 `client` 后会沿用旧上下文的配置编辑状态，并可能把旧连接 ID 写入新 client。** `BrowserAgentView` 在 `client` 改变时只刷新顶层 snapshot 和订阅（`ui/src/View.tsx:10-16`），`SettingsView` 及其编辑器没有按 client 身份重挂载或清理状态。`ConnectionEditor` 把所选连接对象保存在本地 `editing`（`ui/src/settings/ConnectionEditor.tsx:13-19`），提交时直接把其中的旧 `id` 传给当前 props 中的新 `client.saveConnection`（`:21-31`）；表单又以该旧 ID 为 key（`:50`）。因此在同一个视图实例从 client A rerender 到 client B 后，页面仍显示 A 的连接草稿，点击保存会在 B 中创建一个带 A ID 的连接（client 对未知 ID 会按新连接处理）。`AgentEditor` 同样保留旧 `editing`、connection/model 和未受控输入（`ui/src/settings/AgentEditor.tsx:5-19,35,46,51-56`），会显示或提交另一上下文的配置。现有隔离测试只同时挂载两个独立组件，没有覆盖同一公开视图更换 client。请在 client 改变时重置/重挂载全部 client-scoped UI 状态，并增加 rerender A→B 后旧连接、Agent、草稿和 ID 均不可见/不可提交的回归测试。

### Minor

无。

## 逐项验收

1. ✅ 空态有“配置模型与 API Key”按钮，顶层常驻入口同名，均直达连接表单；M01 静态覆盖成立。
2. ✅ 表单清楚区分连接名称、接口地址、模型 ID 列表和 password 类型的 API Key；成功后清空 Key，公开 snapshot 只显示 `credentialConfigured`；失败路径不重挂载表单，草稿保留。M02 成立。
3. ✅ 保存连接后有创建 Agent 的下一步，刚保存的连接会成为新 Agent 默认连接；多个模型可选择，无连接时可返回配置；缺失 tool/skill/connection/model 引用仍有显式保护。M02/M03 成立。
4. ✅ 静态流程可从连接到 Agent，再回到对话创建会话；Skill 与 tools 表面仍保留。首次流程测试确实选择第二个模型并发送消息。
5. ✅ `first-setup.test.tsx` 使用真实 client、fake IndexedDB 与 mock fetch，断言请求 URL、`precise-model` 和测试 Authorization，并验证 Key 输入已清空。原八项测试仍在。
6. ❌ 上下文切换隔离不成立，见 Important 1。360px 的 container query 和 fixture `width=360` 入口已实现，但修正后的 CUA 证据尚未生成：`160-browser-check.md` 仍写“待实现完成后补充”，`160-root-verification.md` 不存在。按任务约束不重跑浏览器，等待编排补充宽屏/360px/键盘/错误态实证。
7. ✅ 执行报告记录 UI 12 项测试和 UI build 通过；本审查按要求未重复执行这些测试。根级验证报告尚待编排补充。

## M01–M04 覆盖结论

- M01 空态与常驻入口：✅
- M02 连接表单与下一步：✅
- M03 Agent 选择模型与管理入口：✅，但 client 上下文切换存在上述隔离缺陷。
- M04 模拟预览与响应式：静态实现及 fixture 标注 ✅；实际宽屏与 360px CUA 证据待编排补齐。

本审查未访问系统钥匙串，未启动浏览器/CDP，未修改产品代码，也未重复执行执行者已报告通过的测试。
