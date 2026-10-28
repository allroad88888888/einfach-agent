# 210 活动页面授权与绑定独立审查

## 结论

PASSED

未发现需要退回的实际重要问题。

## 核对结果

- `bindActiveTab()` 已区分无活动标签与活动标签存在但 URL 不可见；标签 ID `0` 被视为合法值。
- 仅在当前窗口查询无结果时回退 `lastFocusedWindow`。当前窗口已有无 URL 标签时不会跨窗口改绑。
- URL 不可见时，支持的浏览器只调用 `permissions.addHostAccessRequest({ tabId })` 请求该唯一标签。该 Promise 完成后仍抛出用户授权与重试提示，不把完成当作授权成功，不发送握手。
- API 缺失或调用失败均进入可操作的点击插件图标回退提示；URL 可见后的重试继续使用单 origin `contains/request` 流程。
- 无标签、非法 URL、受限协议、权限拒绝、握手失败、坏响应及 tab/frame 不匹配均在返回绑定前失败。
- `ExtensionApp.createSession()` 先等待 `bindActiveTab()` 成功，再调用 `client.createSession()` 并写入绑定，因此不会在未绑定时创建会话。
- service worker 将握手定向发送至请求的 `tabId` 与 `frameId`；`bindActiveTab()` 又校验返回目标必须匹配请求的 tab 和主帧 `0`。
- manifest 未新增 `tabs` 或全站 required host 权限；仍为既有 `activeTab`、`scripting`、`sidePanel`、`storage` 和可选 HTTP/HTTPS host 权限。
- 本次变更没有改动既有 session/document 隔离、取消、恢复实现；范围 diff 中相关既有回归仍保留。

## 验证边界

按 210 任务要求，本审查未重跑已绿测试，也未启动浏览器、CDP 或访问真实网站。200 报告记录 extension 测试 27 项、extension build 与根 TypeScript 检查通过；本次只读核对其实现、测试、调用链和范围 diff。

真实 Chrome MV3 网站访问授权需要用户在浏览器 UI 中操作，本次未进行真实权限确认，模拟测试不能视为真实 MV3 授权实测。
