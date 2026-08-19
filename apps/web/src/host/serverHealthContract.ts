// `/api/health` 握手载荷的**客户端侧契约副本** —— 只回答一个问题：
// 「刚才那个 200 是不是我们自己的 Node server 应答的；如果是，它跑在什么平台上。」
//
// ★ 为什么是副本而不是 import ★
// 服务端的那份住在 `apps/server/src/health.ts`，而 `apps/server` 与 `apps/web` 是**两个 app**。
// 依赖方向 `agent-ai ← agent-core ← {tools-*、能力包} ← app` 里没有 app→app 这条边：app 是消费端，
// 不是被消费端（S1 交回时已经据此拒绝了给 `apps/server` 加 alias/paths——那会凭空造出一条
// 「可以 import 另一个 app」的公开面）。真去 import 还会顺带把 `node:http`/`node:fs` 那条链拖进
// 浏览器产物的模块图里，而本文件所需的全部信息只有三个字符串字面量和一个四值域。
//
// 副本的代价是**漂移**：服务端改了字面量而这里没跟，探测会静默把 server 宿主判成 static，
// 表现是「模型看不到任何本机能力」且没有一句报错。所以副本不是靠注释维持的——
// `serverHealthContract.test.ts` 把 `apps/server/src/health.ts` 当**文本**读进来逐字对拍
// （读文件不是 import，不产生模块边，也不进任何产物）。改了一头没改另一头 = 红灯。
//
// 第三种做法（把契约抽成一个共享包）留给 D 线：它要新增包、加 alias/paths、过 check-boundaries，
// 收益是省掉那条对拍测试，而当前只有三个常量，不值当。
import type { HostPlatform } from '@web-agent/core'

/** 与 `apps/server/src/health.ts` 的 `HEALTH_PATH` 对应。 */
export const HEALTH_PATH = '/api/health'

/**
 * 与 `apps/server/src/health.ts` 的 `SERVICE_IDENTIFIER` / `HOST_IDENTIFIER` 对应。
 *
 * **判据必须是这两个值，不能只判「200」**：本机随便一个开发服务器都可能在同一个端口上对
 * `/api/health` 回 200（这正是服务端那边加判别字段的理由）。误判成 server 宿主的后果不是少点
 * 功能，而是整个应用去打一个根本不存在的命令桥，每一条 invoke 都以看不懂的方式失败。
 */
export const SERVICE_IDENTIFIER = 'web-agent'
export const HOST_IDENTIFIER = 'node-server'

// 四值域与 core 的 `HostPlatform` **是同一个**（服务端那份 `HealthPlatform` 也是）。
// 写成 Record 而不是数组字面量，是为了让「core 哪天加了第五个值」变成本文件的**编译错误**：
// 数组少一项不会有任何人报错，只会让那种平台的服务端被判成 static。
const HOST_PLATFORM_MEMBERS: Readonly<Record<HostPlatform, true>> = {
  macos: true,
  linux: true,
  windows: true,
  unsupported: true,
}

/** 对拍测试用；生产路径只用下面的 `readServerPlatform`。 */
export const HOST_PLATFORMS: readonly HostPlatform[] = Object.keys(HOST_PLATFORM_MEMBERS) as HostPlatform[]

function isHostPlatform(value: unknown): value is HostPlatform {
  return typeof value === 'string' && Object.hasOwn(HOST_PLATFORM_MEMBERS, value)
}

/**
 * 从 health 载荷里取出宿主声明的平台；**不是我们的握手就答 `undefined`**。
 *
 * 【只认三个字段，其余一律忽略】M 线还要往 health 里加东西（模型代理的能力声明之类）。
 * 写成「字段集合恰好等于这几个」的断言，会让那时候的 health 把宿主判成 static —— 而服务端
 * 那份文件头写明了载荷是**具名字段的 JSON 对象**，加字段对老客户端向后兼容，靠的就是消费方
 * 这一条纪律。
 *
 * 【平台不认识 = 握手没成功，不猜也不回落】S5 把 platform 做成 `configureHostInvoke` 的必填
 * 字段，就是不允许消费方自己发明回落值（那等于把「宿主是什么平台」的权威劈成两处）。
 * 身份对上但平台报不出来的载荷，是没走完的握手，按 `undefined` 处置——调用方据此落到 static，
 * 与「还不知道自己是不是 server 宿主时本来就不该登记桥」是同一条规矩。
 * 尤其**不要**把认不出的值兜成 `'unsupported'`：那个值的含义是「宿主声明自己没有可用 shell」，
 * 拿它冒充「我们没看懂」是在替宿主说一句它没说过的话。
 */
export function readServerPlatform(payload: unknown): HostPlatform | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (record.service !== SERVICE_IDENTIFIER) return undefined
  if (record.host !== HOST_IDENTIFIER) return undefined
  return isHostPlatform(record.platform) ? record.platform : undefined
}
