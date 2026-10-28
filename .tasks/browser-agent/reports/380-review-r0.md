# 380 独立审查

结论：**REJECTED**。

## Critical

✅ 未发现 Critical。

## Important

❌ **D03 缺少验收标准要求的 bridge → service worker → content script 组合验证。** `page-bridge.test.ts:99-108` 把 `chrome.runtime.sendMessage` 直接 mock 成最终 DOM 返回，只覆盖 bridge 的 `readDom`/`clickDom`；`service-worker.test.ts:87-95` 又把 `chrome.tabs.sendMessage` 直接 mock 成最终 content 返回，只覆盖 `readDom`/`clickDom` 的 validator/失联分支。测试目录没有加载或执行 `content-script.ts` 的 DOM 分派，因此没有一条测试让真实 `ExtensionPageBridge` 请求经过真实 service-worker 路由、进入真实 content listener/`createDomToolsHost`，再返回 bridge。其余四个方法 `typeDom`、`pressDomKey`、`scrollDom`、`waitForDom` 也没有经过该组合链，取消在 DOM 写上的传播、content 侧拒绝已取消写、导航后新 listener 拒绝旧绑定均未在这条真实组合上证明。实现接线可见于 `content-script.ts:49-60`、返回验证可见于 `service-worker.ts:110-111`，但分层存在代码不等于完成组合验收。

❌ **D04 的 mock-core 测试没有证明模型真正回读两个目标。** 两个 harness 最后确实各调用一次 `read_dom`（`dom-model.integration.test.ts:50-57`），但 mock 模型在下一轮不检查最终 tool message 的 page、节点或显示值，直接固定回复“已选择安全漏洞”；测试本身只在 core 外读取两个 DOM 的 `textContent`（第 14-15 行），并检查模型请求中出现过三个工具名（第 16-17 行）。因此即使最终 `read_dom` 返回空节点、错页结果，甚至模型未据回读结果判断成功，测试仍会通过。目标隔离的断言也只是第二文档独有候选是否存在（第 18-19 行），没有断言两份最终回读分别携带各自 PageRef 并包含选中显示值。可见 fixture 的 `runDomPreview` 有工具侧回读检查（`fixture-dom-preview.testFixtures.ts:27-29`），但不能替代“模拟模型真实 core run 消费两目标回读”的标准。

## Minor

✅ D03 的生产接线方向正确：同一 `ExtensionPageBridge` 实现 page/DOM host，六方法沿用绑定、requestId 和 cancel 通道；service worker 对读/等待使用 `isDomSnapshot`，对四个 DOM 动作使用 `isDomActionResult`，并把四个动作纳入 `unknownResult`（`service-worker.ts:110-111,154-155`）。未发现自动重放。

✅ D04 的宿主注册与目录选择符合冻结语义：extension、embedded 和 UI fixture 显式注册 DOM 工具；Agent 仍只保存用户选择的 `toolNames`，session 创建时锁定所选能力，没有默认把 DOM 工具加入既有 Agent/session。可见演示按钮走真实 ToolRegistry/host，并对选后显示值做回读检查。

✅ D05 的静态边界符合范围：生产 side panel 使用空 API source 且默认拒绝（`sidepanel.tsx:20-23`），`extension/src`/产物未发现 `fixture-cities`；该 fixture 只留在测试/演示。DOM workspace 依赖、根 paths/alias 和 browser headless boundary 扫描均已接入，未见 DOM 包反向依赖 React、Chrome 或 Node。

✅ 审查未重复既有 40 tests/build/gates；以上两项由源码与现有测试可达路径即可确定。370 尚在 R1、380 最终产物等待重建不作为本轮额外缺陷，但在上述 Important 补齐并复审前不能批准。
