# 160 R1 独立窄复审

结论：**PASSED**

## Findings

### Critical

无。

### Important

无。

### Minor

无。

## R1 修复复核

- `BrowserAgentView` 现在按 `BrowserAgentClient` 对象身份为内部工作区提供稳定 React key。相同 client 的正常重渲染不会丢失状态；client A→B 时，内部工作区同步卸载并重建，因此旧导航、编辑对象、连接/模型选择、notice、password 草稿和其他未受控表单字段都不会进入 B。
- 连接回归先在 A 选择已有连接并填写名称及 password 草稿，再 rerender 到 B，断言草稿清空；随后实际保存 B 的新连接，并断言没有沿用 A 的连接 ID。
- Agent 回归先在 A 编辑已有 Agent，再 rerender 到 B，断言旧草稿清空且默认连接来自 B；随后保存 B 的新 Agent，并断言没有 A 的 Agent ID 或连接引用。
- 上述两项测试直接覆盖初审 Important finding；修复未读取 namespace、配置内容或凭据，也没有扩大公开合同。

## 可观察验收

1. ✅ 初始空态和常驻导航均明确显示“模型与 API Key”，并直达完整连接表单。
2. ✅ 表单区分连接名称、接口地址、模型 ID 列表和 password 类型的 API Key；有输入提示、配置状态和不回填说明。保存成功清空 Key，失败保留草稿。
3. ✅ 连接保存后提供创建 Agent 的下一步；刚保存连接成为 Agent 默认连接，多个模型可选；无连接及缺失 connection/model/tool/skill 引用均有可执行或显式保护路径。
4. ✅ 可见流程完整覆盖连接→Agent/第二模型→对话→新会话→消息；Skill 与 tools 配置仍保留。
5. ✅ meaningful UI 测试通过公开 client、fake IndexedDB 和 mock fetch 验证目标 endpoint、第二个模型与测试 Key 实际进入 transport，同时 Key 不在界面回显。原八项 UI 覆盖保留。
6. ✅ client 上下文切换隔离由 R1 双 client 回归补齐。CUA 已实查宽嵌入与真实 360 CSS px 容器：两列/单列布局、完整字段、安全 Key 空栏、模拟预览提示均可见，无肉眼可见遮挡或横向溢出。原生浏览器 Tab 检查因用户同时操作窗口而中断，报告没有冒称完成；R1 使用 `user-event.tab` 验证连接名称→接口地址→模型 ID→API Key→保存按钮的焦点链，作为自动化补证，限制说明准确。
7. ✅ 执行者 UI 14 项测试与 build 已通过；编排验证 UI+agent 37 项、根 tsc、state、boundaries、扩展重建和 diff check 均通过。最终组合日志为 48 files / 179 tests 全部通过。本复审按约束未重复运行已绿测试。

## M01–M04 最终覆盖

- **M01 空态/常驻入口：✅ 完整覆盖。** 组件测试与 CUA 空态实查一致。
- **M02 连接表单与下一步：✅ 完整覆盖。** 字段、提示、Key 清理/不回填、保存错误及下一步均有实现和测试证据。
- **M03 Agent 模型选择与管理入口：✅ 完整覆盖。** 第二模型实际进入 mock transport，缺失引用与 client 切换隔离均已覆盖。
- **M04 模拟预览与 360px/宽屏：✅ 完整覆盖。** fixture 明确模拟响应并提供两个模型；CUA 已验证宽屏和 360px 容器。键盘证据的自动化/原生边界已如实记录。

本复审未访问系统钥匙串，未启动浏览器/CDP，未修改产品代码，也未重复执行已报告通过的测试。
