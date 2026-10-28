# 200 R1 工具栏动作授权修复报告

## 结果

- 扩展 service worker 启动时显式设置 `openPanelOnActionClick: false`，覆盖 Chrome 已持久化的旧设置。
- 注册 `chrome.action.onClicked` 后，在用户点击的同一个同步回调中立即调用 `chrome.sidePanel.open({ windowId: tab.windowId })`，不在调用前 `await`。这使 Chrome 能处理该次 action 的 `activeTab` 用户手势，同时仍打开点击标签所在窗口的侧栏。
- `setPanelBehavior` 和 `sidePanel.open` 的 Promise 拒绝均已收敛，不会产生 unhandled rejection。
- 源码留有简短注释，记录 Chrome 自动 side-panel action 会在授予 `activeTab` 前直接 toggle 侧栏，防止将手动处理误改回旧行为。
- 未改动 R0 的缺 URL 恢复提示、单 origin 授权、握手目标校验及 session/document 隔离。

## 修改文件

- `browser-agent/extension/src/service-worker.ts`
- `browser-agent/extension/src/chrome.d.ts`
- `browser-agent/extension/tests/service-worker.test.ts`

## 回归覆盖

- 确认自动 action toggle 被禁用。
- 确认 action 回调按被点击 tab 的 `windowId` 立即打开侧栏。
- 确认设置和打开侧栏的 Promise 拒绝被收敛。
- 保留并通过原有网络桥、原生 documentId、无效载荷、页面绑定和恢复回归。

## 验证

- `pnpm exec vitest run browser-agent/extension/tests/service-worker.test.ts`：1 file / 8 tests 通过。
- `pnpm exec vitest run browser-agent/extension`：6 files / 29 tests 通过。
- `pnpm --filter @einfach-agent/browser-extension build`：通过；加注释后已再次构建最新 `dist`。
- `pnpm exec tsc -b --pretty false`：通过。

## 边界

- 未改 manifest，未新增 `tabs` 或全站必需权限，未注入额外脚本，未自动创建 session。
- 本执行者未操作真实 Chrome；扩展重载和实际新建会话绑定由编排者验证。
