# Browser network tools

`@einfach-agent/tools-browser-network` 提供六个只观察页面业务流量的浏览器工具，以及纯 Web 的 `createWindowNetworkHost`。嵌入方可在页面尽早调用 `installWindowNetworkRecorder({ window })`：它会立即同步包装当前 Document realm 的 `fetch`/`XMLHttpRequest`，让之后建立的会话读取注入后、对话开始前的有界记录。`list_network_requests` 可省略 `captureId` 直接读取这份文档预缓冲；`start_network_capture` 用于建立独立过滤视图，`includeBuffered: false` 可只看 start 之后的流量。

记录只在内存保存，URL、请求头与安全正文会在入缓存前脱敏。工具不重发请求、不注入凭据；停止会话 capture 不影响独立页面 recorder。重复安装在同一 Window 共享观察器，页面预缓冲采用所有 recorder 中更保守的容量、正文和保留时间限制，普通 host 不会扩大这些限制；释放较严 recorder 本身不会自动放宽已经收紧的限制。`retainForDocument: true` 会关闭按时间淘汰，仍保留请求数与正文大小上限。最后一个使用者释放后才恢复本包拥有的包装。

范围仅限安装所在 Window 当前 Document realm 中包装后发生的 fetch/XHR。无法补抓注入前历史，也不捕获 WebSocket、图片/导航、service worker 内部、worker 或其他 frame 独立 realm 的流量。所有 `pagehide` 都会清理当前 Document；BFCache 恢复时，仍存活的 recorder 引用会在 persisted `pageshow` 同步重新安装。刷新后应在新 Document 重新安装。

```ts
import { createWindowNetworkHost, installWindowNetworkRecorder, registerNetworkTools } from '@einfach-agent/tools-browser-network'

const recorder = installWindowNetworkRecorder({ window })
const host = createWindowNetworkHost({ window, targetId: 'tab-1' })
registerNetworkTools(registry, host)
// teardown: host.dispose(); recorder.dispose()
```
