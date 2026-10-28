# 130 扩展网络桥报告

## 交付

- 新增 `ExtensionNetworkBridge`，完整实现六项 `NetworkToolsHost` 方法，并从既有 `ExtensionPageBridge.target(sessionId)` 闭包读取绑定目标。未绑定、导航后原生 document 不匹配及旧 capture 均关闭失败，不回退当前活动页。
- 协议新增独立 `network-call` / `cancel-network-call`。service worker 仍校验扩展页面 sender；网络调用先在 ISOLATED world 读取只读逻辑绑定标记，再使用该次 `InjectionResult.documentId` 把 MAIN world 调用固定到同一原生 Document。
- 新增独立 `network-main.ts` bundle。MAIN 入口仅接受 sessionId、固定白名单 method、工具参数及绑定文档身份；内部按 session 建 host，requestId 对应 AbortController。无模型连接、Key、storage 配置或任意 eval/string 脚本输入。
- 已授权 web origins 动态注册 ISOLATED `content-script.js` 与 MAIN `network-main.js` 两个 top-frame `document_start` 脚本。启动、安装、权限添加会同步注册；权限撤销会取消对应后续注入并尽力清理已打开匹配页面的 recorder。首次 handshake 同步注册且立即注入当前 Document。
- MAIN 启动即安装 100 条、32 KiB body、5 分钟滚动预缓冲 recorder；工具 `includeBuffered` 由 120 host 消费。sidepanel pagehide 停止自身 captures 并保留既有恢复式 client dispose，不销毁页面预缓冲。
- `network-main.js` 是自包含 entry，经产物扫描无外部 `import`。manifest 未新增必需权限，未加入 debugger、webRequest 或持久全站 host permission。

## 验证

- `pnpm --filter @einfach-agent/browser-extension exec vitest run tests/page-bridge.test.ts tests/network-bridge.test.ts tests/script-registration.test.ts tests/service-worker.test.ts`：4 files / 13 tests passed。覆盖六方法、双 session 目标、未绑定关闭失败、立即 abort/late result、dispose stop、双 world document_start 注册、当前文档注入、未授权 sender、ISOLATED probe 与原生 documentId 固定。
- `pnpm --filter @einfach-agent/browser-extension build`：通过；生成独立 `dist/network-main.js`，扫描无外部 import。
- extension TypeScript 检查已执行；当前被上游 120 的 `window-host.ts:54` 与 `window-host.ts:70` 两处类型错误阻塞，已向编排报告，130 自身在该上游增量出现前通过。
- 未启动浏览器/CDP。以上证明 mock 扩展路由、bundle 与 120 纯 Web host 接线；未声称真实 MV3 网络场景已通过，真实配置页/fixture 由 140 和编排 CUA 验证。
