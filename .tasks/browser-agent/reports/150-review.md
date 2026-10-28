# 150 网络捕获最终覆盖审查

结论：**PASSED**。逐条审查 N01–N06、120/130/140 最新执行与独立复审报告、最终 scope diff 及冻结产品源码后，未发现 Critical、Important 或 Minor 问题。

本轮只读产品代码；未重跑已有通过测试，未发起 HTTP、未启动浏览器/CDP、未访问钥匙串。

## Critical

无。

## Important

无。

## Minor

无。

## N01：六工具合同与纯 Web 捕获 — PASSED

- 六个工具由包根统一创建和注册，具体工具仍各自保留实现、说明和就近测试；公开 host 合同包含 start/list/request/response/wait/stop（`browser-agent/tools/network/src/index.ts:13-24`、`browser-agent/tools/network/src/types.ts:4-23`）。
- fetch 包装准确透传原 `this` 与 `arguments`，返回原 Promise/Response 路径；观察异常被隔离（`browser-agent/tools/network/src/window-observer.ts:94-116`）。XHR 在原 open/header 成功后更新观察元数据，并保持原 send/事件路径（`browser-agent/tools/network/src/window-observer.ts:119-159`）。
- 已证明：纯 Web 模块测试与 fixture 覆盖真实 registry 调用、fetch/XHR、Request/Response 正文以及错误、取消和等待语义；最终证据记录 47 files / 176 tests 全过（`reports/network-final-verification.md`）。

## N02：隔离、脱敏与有界资源 — PASSED

- capture 以 sessionId 查找所有权，重启只替换同一 session 的 capture；每个 capture 独立复制 record，并单独执行容量、正文与 TTL 上限（`browser-agent/tools/network/src/window-host.ts:35-87,90-117,188-213`）。停止 capture 会解除订阅和 observer 引用，但保留该 capture 的已复制记录供读取（`browser-agent/tools/network/src/window-host.ts:77-87,119-145`）。
- URL 去凭据/hash并按常见敏感词变体脱敏；header 使用非凭据白名单；JSON 递归脱敏且超深、超量或超限时整体省略，urlencoded 先脱敏后裁剪（`browser-agent/tools/network/src/sanitize.ts:1-83`）。
- 页面预缓冲按 Window/Document 共享，recorder 取共存限制中更保守值，普通 host 不扩大 recorder 上限；滚动 prune 会清理 reader/listener，异步回写重新检查记录存活（`browser-agent/tools/network/src/window-observer.ts:23-61,194-253,284-298`）。R3 专项覆盖 recorder/host 不同加入顺序和 pending 收紧（`browser-agent/tools/network/src/recorder-limits.test.ts:31-100`）。
- 已证明：容量、滚动过期、多 session、不同 Window、stop/TTL/dispose、迟到结果、敏感正文与返回副本均有模块测试证据。未证明的外部客户流量兼容性未被宣称。

## N03：扩展可信路由、document 固定与取消 — PASSED

- 网络调用先在 ISOLATED world 读取不可由 MAIN 页面伪造的逻辑 binding；取该探针返回的 Chrome 原生 `documentId`，随后 MAIN 调用固定到 `target.documentIds`，避免 frameId 检查后导航竞态（`browser-agent/extension/src/service-worker.ts:47-72`）。
- service worker 只接受本扩展页面 sender，MAIN 返回值有形状、数量、字符串和总传输大小限制（`browser-agent/extension/src/service-worker.ts:11-19,96-127`）。bridge 在本地 abort 后立即拒绝并尽力发 cancel，late reply 不再改变调用结果（`browser-agent/extension/src/network-bridge.ts:35-57`）。
- MAIN gateway 仅接收 session/target/document/request/method/input；每 session 独立 host，wait 取消只中止观察等待，不取消页面业务请求（`browser-agent/extension/src/network-main.ts:21-47`）。
- 已证明：单元/模块集成覆盖 native documentId、导航拒绝、异步 executeScript 错误回包、取消、结果验证、BFCache、刷新和撤权。未证明：真实安装后的 MV3 客户站点行为。

## N04：19 项配置与真实本地请求演示 — PASSED

- fixture 在创建 Browser Agent 前安装 recorder、创建 host并发出初始化 cities fetch（`browser-agent/ui/tests/fixture-business.testFixtures.ts:14-28`）；工具从生产 registry 运行 start/list/get/wait/stop，后续发真实 Window fetch/XHR，不手工塞捕获结果（`browser-agent/ui/tests/fixture-network-preview.testFixtures.ts:18-41`）。
- 集成测试实际执行模型 transport并确认固定 Authorization 到达模型 fetch，同时逐条读取业务 capture 的 request/response，证明模型 endpoint、credential 和响应标记不进入业务 iframe 捕获（`browser-agent/ui/tests/network-preview.integration.test.ts:34-65`）。
- CUA 记录真实 Vite HTTP 的早期 CN 初始化响应、后续 fetch/XHR、19 项工具可见（`reports/140-browser-check.md`）。该报告明确限定为纯 Web iframe，不冒充 MV3 实测。

## N05：公开包、无 UI 嵌入与依赖方向 — PASSED

- network 是独立 headless 工具包，仅依赖公开 core/tools；UI 对 network 仅为 devDependency，生产 UI 未耦合具体 tools（`browser-agent/tools/network/package.json`、`browser-agent/ui/package.json`）。
- embedded 示例直接装配 recorder、network host 和 registrar，不依赖 React、UI 或 Chrome API（`browser-agent/examples/embedded/package.json`、`browser-agent/examples/embedded/src/main.ts:1-27`）。边界门禁把 network 与 embedded 纳入 headless 扫描（`scripts/check-boundaries.js:52-57,223-228`）。
- 最终产物证据为 23 packed packages、33 公开 ESM 入口、NodeNext d.ts 与 negative exports 全过；没有新增 SDK 层或无消费者抽象（`reports/network-final-verification.md`）。

## N06：document_start 提前采集与对话前请求 — PASSED

- 已授权 http/https origin 动态注册两份 top-frame `document_start` 脚本：ISOLATED content script 与 MAIN network recorder；同步串行且按授权 origin 签名幂等（`browser-agent/extension/src/script-registration.ts:1-19,35-49`）。安装、启动、授权变化和 handshake 均触发同步；首次绑定当前页也立即注入两 world（`browser-agent/extension/src/service-worker.ts:4-9,21-30`）。
- MAIN entry 加载即同步安装 recorder，尚无 session/sidepanel tool start 也会预采集；pagehide 清当前资源，BFCache persisted pageshow 可恢复，明确 dispose/撤权移除生命周期监听且不会被 pageshow 复活（`browser-agent/extension/src/network-main.ts:16-63`）。
- `startCapture` 默认快照预缓冲；`includeBuffered:false` 排除已有 requestId，pending 旧请求后续更新也不会混入（`browser-agent/tools/network/src/window-host.ts:90-117`）。fixture 的初始化请求发生在 Agent 创建与会话 start 之前，之后仍能读取响应（`browser-agent/ui/tests/fixture.testFixtures.tsx:17-18,29-30`、`browser-agent/ui/tests/network-preview.integration.test.ts:14-43`）。
- 行为边界准确：只能读取 recorder 注入之后、对话之前的请求；首次给已打开页面授权时，注入前初始化 body 无法补抓，需刷新才能覆盖。README 明确该限制以及 other frames/workers/WebSocket 不覆盖（`browser-agent/README.md:20-22`）。

## 复杂度与验证边界

- 普通 source/tests 均不超过 300 行；最大源码 `window-observer.ts` 为 298 行。observer、host/capture、sanitize、request input、recorder、六个 tool 各按职责拆分，没有通过单行压缩规避限制。
- `reports/network-final-scope.diff` 共 3481 行，SHA-256 为 `f6656ba42ddb928dbec9e837d2f8d34db080123f59b364bd6ccfce714e82e678`，与 `reports/network-final-verification.md` 记录一致。
- 已证明：纯 Web fetch/XHR 捕获、真实本地 HTTP fixture、工具注册与调用、扩展模块接线、动态脚本配置、可信路由与构建产物。
- 未证明：真实浏览器安装后的 MV3 `document_start` 抓包、任意客户站点/API、Microsoft Edge、注入前历史正文。现有报告和 README 均明确保留这些边界，因此不构成验收缺陷。
