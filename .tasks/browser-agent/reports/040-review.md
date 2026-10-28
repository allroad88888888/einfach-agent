# 040 独立审查

结论：**REJECTED**

审查方式：按 `040-ui.md`、全局 `index.md`、执行报告和 `040-scope.diff` 静态核对源码、声明产物与四张既有浏览器截图；遵守约束，未启动浏览器、未重跑报告中已通过的测试。

## 逐项验收

- ✅ 包根导出 `BrowserAgentView` 与 props 类型，样式通过 `./styles.css` 显式 export；生产视图消费外部 client，卸载仅释放自身订阅，没有创建、销毁或停止 client。
- ✅ 使用 `RootStoreProvider(client.core.rootStore)` 和按所选会话创建的 `AgentStoreProvider(client.core.sessionAtomScope(sessionId))`；未发现 Chrome API、`apps/web` 私有模块、默认 core 或全局 Provider fallback。
- ✅ Agent、Skill、连接均具备创建、编辑、删除界面；模型随连接选择，instructions、工具和 Skill 可选，Skill 支持多项文本资源增删改，连接密码字段不会回填且成功保存后清空。
- ❌ Agent 配置对已缺失的工具引用没有可见提示，也不能保留该引用。`AgentEditor.tsx:12,37` 只渲染 `client.core.tools.list()` 的当前结果；编辑一个仍带有已注销工具名的 Agent 时，该工具完全消失，提交会在 `AgentEditor.tsx:19` 用表单当前复选框重写 `toolNames`，从而静默删掉引用并显示“Agent 已保存”。这违反“缺失 Skill/tool 可见且不能假保存成功”的明确要求。**Important**
- ✅ 配置版本与会话快照关系有清晰文案；Skill 明确为文本而非脚本；无连接时保存 Agent 被禁用。
- ✅ 聊天按 Agent 新建/切换会话，使用公开 timeline 投影显示消息、推理、工具进度/结果、运行事件和卡片；运行、等待确认、等待用户、错误、中断、完成及取消均有对应展示或操作。
- ✅ send、stop、answer/resume、confirm/reject、recovery、undo/redo 的实现都显式传入当前展示的 `sessionId`；输入只在 send 成功后清空，undo/redo 使用 core availability 并展示拒绝及外部副作用边界。
- ✅ recovery 区分 `recoverable` 与 `reconciliation_required`，后者明确阻止自动重放不确定的外部操作。
- ✅ 两 client 和真实 client + fake IndexedDB/mock fetch 的测试代码覆盖配置、建会话、发送、工具结果、隔离、保存失败、显式会话命令、undo/redo 与恢复；报告记录 6/6 通过，本次未重跑。
- ✅ build 报告记录 JS/CSS、声明生成与 specifier 修复通过；现有 `dist/index.d.ts` 使用带 `.js` 的可消费导出，包清单包含 types 与独立 CSS export。
- ✅ 四张既有截图覆盖空态、配置、等待用户、运行中以及 360px/1040px 两种宽度；视觉检查未见横向溢出，既有 JSON 证据记录无 console error 且 Tab 后有可见 focus outline。
- ✅ README 展示外部创建 client、显式加载样式、视图卸载与宿主 dispose 的所有权，并说明 UI 为可选包。
- ❌ README 的异步初始化示例直接 `await createBrowserAgent(...)`，没有展示任务交接所要求由宿主承接的加载/损坏配置失败界面；生产视图自身也没有 loading/error 输入，因此当前交付没有形成“加载失败”覆盖证据。**Minor**
- ❌ 各 Editor 的“新建”在当前已处于新建态时只再次执行 `setEditing(undefined)`，React 不会重挂载相同 key 的表单，用户已经输入的未保存草稿不会被清空（`AgentEditor.tsx:29-30`，Skill/Connection 同构）。按钮语义与实际行为不一致。**Minor**

## 必须修复

1. 编辑 Agent 时合并并明确标示其快照中已不存在于当前 registry 的工具；禁止保存成功时静默丢弃缺失引用，可选择阻止保存并给出文本错误，或要求用户明确移除。
2. 在 README 的宿主接入示例中展示异步 client 初始化失败的加载/错误处理，使“加载失败归外部初始化”成为可执行的接入说明。
3. 让各配置页的“新建”可靠重置当前草稿，或在已有未保存新建草稿时提供符合按钮语义的行为。
