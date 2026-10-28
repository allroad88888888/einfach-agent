# 160 模型与 API Key 首次配置续修报告

## 文件职责

- `ui/src/View.tsx`：管理对话与目标配置区之间的顶层导航。
- `ui/src/chat/ChatView.tsx`：展示会话操作与无 Agent 时的首配入口。
- `ui/src/settings/SettingsView.tsx`：编排 Agent、技能、模型连接三个编辑器。
- `ui/src/settings/ConnectionEditor.tsx`：编辑模型连接并引导进入 Agent 创建。
- `ui/src/settings/AgentEditor.tsx`：编辑 Agent 引用并保护缺失引用。
- `ui/src/first-setup.test.tsx`：验证首次配置到真实 mock transport 的完整路径。
- `ui/src/styles.css`：提供可嵌入视图的视觉与容器响应式规则。
- `ui/tests/fixture.testFixtures.tsx`、`ui/tests/fixture.html`：提供模拟模型的宽屏与 360px 浏览器验收现场。

上述新增或大改普通文件均少于 300 行。`BrowserAgentView.test.tsx` 在追加两项 R1 隔离回归后为 271 行，原八项覆盖全部保留。

## 实际变更

- 对话空态新增“配置模型与 API Key”按钮，顶层常驻入口也使用同一明确名称，并直达实际表单。
- 表单明确区分连接名称、接口地址、模型 ID 列表和 API Key，补充输入提示；模型列表只接受用户服务实际 ID。
- 保存成功后清空 Key 输入、保持已配置连接可见，并显示“下一步：创建 Agent”。失败继续保留当前非 Key 草稿。
- Agent 页面可直接管理模型与 Key；没有连接时提供可执行入口。连接保存后的 Agent 草稿默认使用刚保存的连接，模型仍由用户显式选择。
- Agent 保存后提供回到对话的操作，用户可继续选择 Agent、创建会话并发送消息。
- 产品 CSS 使用 container query，使 360px 嵌入容器即使位于宽浏览器窗口中也能切换为单列；fixture 的 `width=360` 只约束容器宽度。
- fixture 明示“演示预览：模型请求为模拟响应，请勿输入真实 API Key”，并提供 `quick-1`、`precise-1` 两个演示模型。
- 新增 meaningful UI 测试，完整走连接→第二个模型→Agent→会话→消息，并断言 mock transport 收到目标 endpoint、`precise-model` 与测试 Key，同时 DOM 不回显 Key。

## R1 隔离修复

- 将公开 `BrowserAgentView` 的 client 身份映射为内部工作区的稳定 React key。相同 client 正常保留视图状态；同一组件 rerender 为另一 client 时，导航、选择、编辑对象和未受控表单同步重挂载，不经过旧状态可交互的中间帧。
- key 只使用 client 对象身份和本地递增编号，不读取 namespace、配置或凭据，也不复制、缓存或重新暴露 API Key。
- 新增真实双 client 回归：连接场景在 A 中选择既有连接并填写 password 草稿，切到 B 后断言所有草稿清空，再实际保存 B 新连接并确认未沿用 A 的 ID；Agent 场景在 A 中编辑既有 Agent，切到 B 后断言编辑对象及连接选择重置，再保存 B 新 Agent 并确认没有 A 的 ID 或数据。
- 连接隔离回归同时用 `user-event` 验证连接名称→接口地址→模型 ID 列表→API Key→保存按钮的 Tab 焦点顺序。

## 验证

- `pnpm exec vitest run browser-agent/ui`：R1 复验通过，4 个文件、14 项测试；原 8 项测试全部保留。
- `pnpm --filter @einfach-agent/browser-agent-ui build`：通过，tsup、声明构建与说明符修复完成。
- `pnpm exec tsc -b --pretty false`：通过，根 TypeScript project references 无错误。
- `node scripts/check-docs.js`：R1 复验通过，615 个 Markdown 文件。
- `git diff --check -- browser-agent/ui browser-agent/README.md .tasks/browser-agent/reports/160-report.md`：通过。
- 编排者已通过现有原生 Chrome/CUA 完成宽屏与 360px 表单实查和截图；原生浏览器键盘实查因用户正在改变窗口而停止，键盘焦点顺序由上述 `user-event` 测试覆盖。执行过程未启动浏览器、CDP 或 Playwright。

## 风险与边界

- fixture 只验证确定性模拟模型请求，不证明任意真实服务的兼容性。
- API Key 仍遵循现有 browser-agent client 的本地凭据合同；公开快照只暴露 `credentialConfigured`，界面不回填明文。
- 本次未改变 agent 运行包、扩展入口、provider 框架或工具接线，也未访问系统钥匙串。
