# 120 网络工具实现报告

新增 `@einfach-agent/tools-browser-network` 私有包，公开六个工具工厂、registrar、固定 host 类型、`createWindowNetworkHost` 与早期 `installWindowNetworkRecorder`。共享观察器捕获当前 Document realm 的 fetch/XHR；会话捕获按 session/capture 隔离并支持缓冲快照、分页、详情、等待和停止。

URL、允许头和安全正文在入缓存前有界处理并脱敏。文档明确注入前历史、WebSocket、导航/图片、worker/service worker 和其他 frame realm 不在范围内。

验证：network TypeScript、build、7 files / 10 tests、文档门禁通过。最大新增源码 147 行。测试覆盖早期缓冲、响应读取、脱敏、includeBuffered:false、隔离、停止和等待结算。
