# 200 活动页绑定修复报告

## 结果

- `bindActiveTab()` 现在区分“没有活动标签”与“已有标签 ID 但未获得 URL”，并正确接受 ID `0`。
- `currentWindow` 无结果时才查询 `lastFocusedWindow`；当前窗口已有标签但 URL 不可见时不跨窗口换目标。
- URL 不可见时，如浏览器支持 `permissions.addHostAccessRequest`，只为当前 `tabId` 登记网站访问请求。Promise 完成后仍要求用户在工具栏授权并重试，不会发送握手或创建未绑定会话。
- API 不存在或调用失败时，提示用户在目标 HTTP/HTTPS 页面点击插件图标后重试。
- URL 已可见时保留单 origin 的 `contains/request` 权限流程。受限页、非法 URL、拒绝授权、握手失败和无效响应均返回可理解的中文错误。
- 握手结果必须与请求的 `tabId` 和主帧 `frameId: 0` 一致，否则拒绝绑定。原有 session/document 隔离、取消和恢复逻辑未改变。

## 修改文件

- `browser-agent/extension/src/page-bridge.ts`
- `browser-agent/extension/src/chrome.d.ts`
- `browser-agent/extension/tests/page-bridge.test.ts`

## 验证

- `pnpm exec vitest run browser-agent/extension`：6 files / 27 tests 通过。
- `pnpm --filter @einfach-agent/browser-extension build`：通过。
- `pnpm exec tsc -b --pretty false`：通过。

## 边界

- 未改 manifest，未新增 `tabs` 或全站权限。
- 未进行真实浏览器交互，不声称已观测用户具体标签数据。
