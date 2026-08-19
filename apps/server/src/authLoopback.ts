// 第一道防线：这条 TCP 连接的**对端**是不是本机。
//
// 三道防线各挡各的，这一道挡的是「局域网里的另一台机器」：咖啡馆的 WiFi、公司内网的扫描器、
// 同一台路由器下的另一台设备。它看的是**内核告诉我们的 socket 地址**，请求方伪造不了——
// 这正是它与第三道（`authOrigin.ts` 的 Origin / Host 判定）的分界：那一道看的是请求自己声称的
// 字符串，只在浏览器如实填写时才有意义。**这一道彻底挡不住本机浏览器里的任何一个标签页**，
// 因为那些请求的对端就是 127.0.0.1，与我们自己的页面逐字节相同。
//
// 判据与 `scripts/model-preview-relay.ts` 的 `isLoopbackAddress` 逐字相同（IPv4 回环、IPv6 回环、
// IPv4-mapped IPv6 三种写法）。**刻意没有 import 那一份**：那个模块的 import 图经
// `model-preview-relay-routes.ts` 直达模型凭证路由（`ModelPreviewRelayCredentials` 持有三家
// provider 的 Key），把它拉进本进程等于给一台随后要执行 `run_shell_command` 的 server 接上一条
// 读模型 Key 的边——这是本卡明令不得引入的那类代码路径。一个三行谓词不值这个代价。
// 两处若将来要分叉，分叉的是判据本身，那时两边一起改。
//
// **已知的收窄（可接受，fail-closed）**：RFC 1122 把整个 `127.0.0.0/8` 都算回环，而这里只认
// `127.0.0.1`。真要撞上需要客户端**特意**把源地址绑到 `127.0.0.2` 之类（`curl --interface`），
// 正常路径不会发生；宁可多拒一个也不自己发明一套比中继更宽的判据。

/**
 * 默认绑定地址。**只绑回环**，所以局域网上的其他机器连 TCP 握手都完不成。
 *
 * 写字面量 IP 而不是 `'localhost'`：`listen('localhost')` 要过一次 DNS/hosts 解析，
 * 结果可能是 `::1`、可能是 `127.0.0.1`、也可能被一条 `/etc/hosts` 改成别的——「绑在哪」
 * 这件事不该有解析这一步。
 *
 * 真正的 `listen` 调用点在 S4；本常量是那一步的默认值。**即便 S4（或将来的某个 `--host` 选项）
 * 绑到了 `0.0.0.0`，`/api/*` 仍然只对回环开放**——`authGuard.ts` 在每条请求上重新判一次对端地址，
 * 非回环一律 403。绑定地址是默认值，对端判定才是执行。
 */
export const DEFAULT_BIND_ADDRESS = '127.0.0.1'

const LOOPBACK_PEER_ADDRESSES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  // 双栈监听套接字上收到的 IPv4 连接，Node 报的是这种 IPv4-mapped 形态。
  '::ffff:127.0.0.1',
])

/** 对端地址是否为本机回环。`undefined`（socket 已断开）一律判否。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_PEER_ADDRESSES.has(address)
}
