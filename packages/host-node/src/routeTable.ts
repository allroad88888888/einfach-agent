// 路由表的类型契约：一个域交出来的东西长什么样
// ---------------------------------------------------------------------------
// 各域的 registrar（`src/<domain>/index.ts`）返回 `NodeHostRouteTable`，
// createNodeHostInvoke.ts 把它们合成一张总表。契约放在这里、不放在 createNodeHostInvoke.ts，
// 是为了让依赖方向单向：域 → 契约 ← 组装。域文件反过来 import 组装文件的类型也能编译
// （`import type` 会被完全擦除），但那会把「组装根」变成「类型来源」，谁都能从任何一头开始读，
// 后面 24 张卡各写各的就散了。

import type { NodeHostCommandName } from './commandNames'

/**
 * 一条命令的实现。
 *
 * 参数是 `Record<string, unknown>` 而**不是** commandArgs.ts 里那条命令的入参类型——这不是
 * 偷懒，是传输决定的：同一张路由表要同时挂在 `POST /api/invoke/:command`（载荷来自浏览器发
 * 的 JSON，是外部输入）、CLI 进程内注入和 Tauri sidecar 后面。把入参类型直接写进签名，等于
 * 用一句 `as` 把「没校验」伪装成「已校验」，而校验失败的表现是在系统调用那一层才炸。
 * **每个 handler 自己负责收窄**；commandArgs.ts 是收窄的目标形状，不是收窄的替代品。
 *
 * 返回值同理是 `unknown`：`HostInvoke` 的类型实参（调用点写的 `invoke<Foo>(...)`）只是编译期
 * 承诺，运行时不做任何校验；core 侧每个调用点后面都跟着一段 `normalizeResult`，那才是真正
 * 认结果形状的地方。
 *
 * `args` 恒为对象：调用方不传第二个实参时（`invoke('get_user_home_dir')`），分发层补 `{}`，
 * 免得每个 handler 各写一遍空值判断。
 */
export type NodeHostCommandHandler = (args: Record<string, unknown>) => Promise<unknown>

/**
 * 命令名 → 实现。**故意是 `Partial`**：N 线是 25 张卡逐域落地的，任何时刻都有一批命令还没有
 * 实现。缺席在类型上就是「这个键不存在」，分发层据此给出「尚未实现」而不是「未知命令」——
 * 两者对调用方的含义完全不同，见 createNodeHostInvoke.ts 的 NodeHostCommandError。
 *
 * 键被约束在 `NodeHostCommandName` 上，所以某个域的 registrar 里写错一个命令名会当场编译失败，
 * 而不是变成一条永远不会被分发到的死路由。
 */
export type NodeHostRouteTable = Partial<Record<NodeHostCommandName, NodeHostCommandHandler>>
