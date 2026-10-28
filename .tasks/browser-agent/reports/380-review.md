# 380 R1 独立复审

结论：**APPROVED**。

## Critical

✅ 未发现 Critical。

## Important

✅ **R0 的 D03 组合验证缺口已关闭。** `extension/tests/dom-routing.integration.test.ts` 用同一内存 Chrome transport 加载真实 `ExtensionPageBridge`、service-worker listener、content-script listener 与 `createDomToolsHost`。测试让六个公开 DOM 方法实际经过 bridge → service worker → content script 并作用于绑定 document，同时覆盖运行中取消、预取消写、旧 PageRef、导航后的旧 binding、畸形 nested node 和错页返回。它验证的是实际组合路径，不再以 bridge/service 两端分别 mock 最终结果代替。

✅ **R0 的 D04 模型回读缺口已关闭。** `ui/tests/dom-model.integration.test.ts` 的 mock 模型在最终答复前解析最后一条 `read_dom` tool message，检查其 `page.targetId` 等于各自预期目标且节点包含选中显示值“安全漏洞”；不满足即抛错。测试随后分别断言 `first` 与 `second` 的 readback 为各自 PageRef targetId 和选中值，因此错误目标、空回读或未消费回读均不能通过。

## Minor

✅ D03 六方法继续共用既有 session→tab/frame/document 绑定、requestId 与取消通道；service worker 对 snapshot/action 使用 DOM 包公开 validator，四个 DOM 写动作均纳入 `unknownResult`，未发现自动重放或放宽 sender/document 校验。

✅ D04 extension、embedded 与 UI fixture 均注册 DOM 工具；可见演示按钮仍走真实 ToolRegistry/host 链并在选择后回读。Agent 保存的 `toolNames` 和 session capability lock 保持原冻结语义，没有默认扩权既有 Agent 或会话。

✅ D05 保持生产 extension 无 `fixture-cities` 默认来源；side panel 的空 API host 默认拒绝来源，演示数据只存在于 fixture/embedded。workspace 链接、根 alias/paths 与 boundary 扫描已包含 DOM 包，未见跨入 React、Chrome 或 Node 的包边界回归。

✅ 370 R1 已独立批准，共享合同未发生单边变化。复审按要求未重复已通过的 9 files / 37 tests、tsc、docs 与 diff gates；源码、R1 精确增量和报告证据一致。
