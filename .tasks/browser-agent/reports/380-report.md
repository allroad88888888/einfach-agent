# 380 执行报告

## 结论

PASS（R1）。扩展、无 UI embedded 宿主和 UI fixture 都已注册 `@einfach-agent/tools-browser-dom` 六项工具。扩展沿用现有 session→tab/frame/document 绑定、requestId、取消通道和 service worker 返回校验；DOM 写操作失联标记 `unknownResult` 且不重放。生产 side panel 已移除 `fixture-cities` 数据源，保留空 API host 以兼容既有工具目录名称和已存 Agent 配置。

## 交付

- `extension/src/protocol.ts`：在既有 page-call 通道加入六个 DOM method 与两类 DOM result。
- `extension/src/page-bridge.ts`：同一个 `ExtensionPageBridge` 同时实现 page/DOM host；所有带 PageRef 的调用先校验当前 session 绑定。
- `extension/src/content-script.ts`：以同一 targetId/documentId/revision 创建 DOM host，复用取消 controller。
- `extension/src/service-worker.ts`：用 DOM 包公开 validator 校验深层 node/PageRef；click/type/key/scroll 纳入未知写结果保护。
- `extension/tests/dom-routing.integration.test.ts`（R1）：内存 Chrome transport 运行真实 bridge、service worker listener、content-script listener 与 `createDomToolsHost`，六方法均到实际 document；覆盖运行中取消、预取消写、旧导航 binding、畸形 nested node 与错页返回。
- `extension/src/sidepanel.tsx`：注册 DOM 工具；删除生产演示城市源，空 API host 默认拒绝来源。
- `examples/embedded/src/main.ts`：两个 namespace 各自注册 DOM host；模拟模型显式取得 schema，再按观察到的 ref/parentRef 完成普通 div/span 异步下拉选择。
- `ui/tests/fixture-business.testFixtures.ts`：可见同源 iframe 增加无 ARIA role 的自定义下拉和延迟候选。
- `ui/tests/fixture-dom-preview.testFixtures.ts`：按钮“运行DOM选择演示”通过真实 ToolRegistry 执行 read→click→scoped wait→click→read，确认候选已关闭且显示值是“安全漏洞”。
- `ui/tests/dom-model.integration.test.ts`：两个独立 iframe/namespace/session 的模拟模型真实 core run；模型消费最终 `read_dom` tool message，逐一检查各自 PageRef targetId 与“安全漏洞”显示值后才报告成功；测试断言两份模型内 readback 和目标隔离。
- `ui/tests/tool-preview.integration.test.ts`：可见演示真实 registry 回归。
- package manifests、`pnpm-lock.yaml`、根 alias/paths：补 DOM workspace 依赖和开发解析；仅新增 workspace link，无版本或 resolution 变化。
- `scripts/check-boundaries.js` / `.test.js`：DOM 包进入 headless browser source 扫描并有拒绝 Chrome 依赖的自测。
- `browser-agent/README.md`：25 项目录、已有 Agent/会话冻结语义、DOM 调用顺序、合成事件和 iframe/shadow 边界。

## 验证

- 定向组合：extension 全部测试 + UI DOM/model/network preview，10 files / 40 tests，PASS（`380-related-tests.log`）。
- DOM 模拟模型隔离闭环：1 file / 1 test，PASS（`380-dom-model.log`）。首次失败分别暴露 detached `createHTMLDocument` 不满足当前文档绑定，以及 mock 重复同参数工具调用触发循环保护；改用已挂载的两个 iframe，并先显式加载 schema 后再调用，未放宽运行时断言。
- UI 可见 registry 演示：2 tests，PASS（`380-ui-preview.log` / `380-dom-fixtures.log`）。
- extension、embedded、UI、DOM 包 build：PASS。首次并行构建在 UI/DOM dist 尚未完成时解析失败；依赖产物完成后按依赖顺序重跑通过，属于构建调度而非源码缺陷。
- `check:dist`：24 个 packed packages、34 个公开 ESM 入口、CSS、NodeNext declarations 与 negative exports，PASS（`380-dist.log`）。
- 根 `tsc -b`：PASS（`380-tsc.log`）。
- state、boundaries 与 boundary 自测 16 项：PASS（`380-state.log`、`380-boundaries.log`、`380-boundaries-test.log`）。
- 生产 extension `src` 与最终 `dist` 搜索 `fixture-cities`：0 命中。
- 根完整 browser-agent 组合回归由编排者统一执行，本叶未重复。
- R1 定向：extension 全目录 + 双目标 mock-core，9 files / 37 tests，PASS（`380-r1-targeted.log`）；根 `tsc -b` PASS（`380-r1-tsc.log`）。
- 编排者 CUA 已点击 `http://127.0.0.1:4178/fixture.html?scenario=configured` 的“运行DOM选择演示”，实际 iframe 显示“安全漏洞”且五步回读通过；证据归 `390-browser-check.md`。

## 文件规模与职责

所有新增/大改普通文件均小于 300 行。主要行数：protocol 30、bridge 123、content 74、service worker 161、sidepanel 35、embedded main 111、fixture business 103、fixture preview 37、model integration 71、tool preview 53。每个新增 fixture 文件分别只负责业务 DOM、可见 registry 演示或模型闭环；未制造按名称拆分但共享状态的假拆分。

## 适用范围与未实测项

实现覆盖绑定的 top document；embedded 可显式传同源 iframe document。跨源 iframe、closed shadow root、依赖 `isTrusted` 的站点和任意第三方组件兼容性不在本次合同内。本执行者未启动浏览器/CDP/Chrome for Testing、未调用真实模型或真实业务请求；可见 fixture 的 CUA 验证由编排者执行。未 install、升级依赖、commit 或 push。
