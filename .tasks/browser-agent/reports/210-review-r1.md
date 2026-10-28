# 210 R1 工具栏动作授权修复独立审查

## 结论

PASSED

未发现需要退回的实际重要问题。上一轮 `210-review.md` 仅保留为 R0 模块审查历史；本报告独立核对真实 Chrome 复现后追加的 R1 修正。

## R1 核对结果

- service worker 加载时显式调用 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })`，能够迁移此前持久化的自动侧栏设置；该调用的 Promise 拒绝已被收敛。
- `chrome.action.onClicked` 已注册。回调在同一同步调用链中直接调用 `chrome.sidePanel.open(...)`，调用前没有 `await`、微任务或其他异步边界，不会主动丢失 action 点击的用户手势。
- 打开侧栏使用事件所给 tab 的 `windowId`，且只接受整数；不会通过另一次活动窗口查询改绑到其他窗口。`sidePanel.open` 的 Promise 拒绝也已被收敛，不产生未处理拒绝。
- R1 未增加自动注入、自动创建 session 或额外授权行为。manifest 仍只有既有 `activeTab`、`scripting`、`sidePanel`、`storage` 必需权限和可选 HTTP/HTTPS host 权限，没有新增 `tabs` 或全站 required host 权限。
- `chrome.d.ts` 的 R1 增量限于实际使用的 `Tab.windowId`、`action.onClicked` 与 `sidePanel.open({ windowId })` 声明。
- 缺 URL 时的 `addHostAccessRequest` 提示、单 origin 权限请求、握手 tab/frame 校验以及先绑定后创建 session 的 R0 行为均未被 R1 改写。
- 网络消息仍在 `routeNetwork()` 中先用 ISOLATED world 探测绑定和 Chrome 原生 `documentId`，再按该 `documentId` 路由 MAIN world 调用；R1 的 action 处理没有使网络路由回退到普通 `tabs.sendMessage`。
- 新增测试覆盖关闭自动 action toggle、按点击 tab 的窗口立即打开侧栏，以及设置/打开 Promise 拒绝收敛；原 service worker 网络路由用例仍保留。

## 验证边界

按 210 R1 任务要求，本审查未重复运行已经绿色的测试，也未操作 Chrome。200 R1 报告记录 service worker 定向 8 项、extension 全部 29 项、extension build 与根 TypeScript 检查通过；本轮只读核对实现、测试、范围 diff 和 manifest。

真实 Chrome MV3 的 `activeTab` 授予及用户页面新建会话仍需编排者在现有浏览器中验证。本轮模拟测试只能证明调用顺序和拒绝处理，不能代替真实用户手势与网站权限确认。
