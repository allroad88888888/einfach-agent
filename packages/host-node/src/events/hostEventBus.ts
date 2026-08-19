// 宿主事件汇：订阅面与发射面，以及派发语义
// ---------------------------------------------------------------------------
// 【为什么是工厂，不是模块级单例 + configure】
// `hostBridge.ts` 收 loader 而不是已解析的 invoke，为的是消灭「已登记但 `hasHostBridge()` 仍为假」
// 那段窗口。事件面这里有一个更干脆的做法：**根本不要「登记」这个动作**。
// `createHostEventBus()` 一次调用同时产出订阅面与发射面，对象存在即两半都可用，不存在就是不存在，
// 没有中间态可言，也就没有窗口可留。模块级单例反而会把窗口请回来——它必须配一个
// `configure` 和一个给测试用的 `reset`，而 reset 型的测试隔离正是「登记了但没生效」那一族 bug 的
// 温床。本包本来也是工厂风格（`createNodeHostInvoke(options)`）。
//
// 【为什么订阅面与发射面是同一次创建的两半】（`hostBridge.ts` 的 S5 教训）
// 平台与桥必须同生共死，所以它们是**一次**登记的两个字段而不是两个入口。这里同理：一条事件
// 只有「有人发」和「有人收」凑齐才有意义，拆成两个各自可独立创建的东西，立刻会出现
// 「发射方挂在 A 汇上、订阅方挂在 B 汇上」——那是彻底的静默失败，事件发得好好的，就是没人收。
// 但**消费**时两半要分开：C1 的 MCP 传输层只需要发（`HostEventSink`），C3 的 SSE 端点只需要收
// （`HostEventSource`）。所以下面给出两个窄接口 + 一个合并接口：一次创建，按半消费。
//
// 【派发语义：四件事的裁决】
//
// 1. **派发中途取消订阅**。派发前对订阅列表取快照（`[...list]`），并在每次调用前复查
//    `subscription.active`。两者缺一不可：
//      · 只有快照：在 handler 里取消另一个（或自己的）订阅，被取消的那个仍在快照里，照样被调用
//        ——`onHostEvent` 返回的取消函数就成了「有时不管用」。
//      · 只有复查、直接遍历原数组：`splice` 会让游标跳过下一个 handler（经典的删除即跳过），
//        而派发中途新增订阅还会让新 handler 收到一条它订阅之前就发生的事件。
//    取消 = 置 `active = false` **且**从列表移除。置位管住「本次派发的快照」，移除管住「下一次
//    派发不用再扫死条目」，长期订阅/退订的场景下少一条内存泄漏。
//    派发中途**新增**的订阅不收本次事件：它订阅时事件已经发生了，收到才是错的。
//
// 2. **一个 handler 抛异常不能拖垮其余 handler，也不能拖垮宿主**。每次调用各自 try/catch，
//    异常交给 `onHandlerError` 报告后继续下一个。返回 Promise 的 handler 另接一个 `catch`：
//    Node 从 v15 起**默认把未处理的 rejection 当致命错误直接结束进程**，一个 async handler 里
//    的 `await` 失败就能把整个 CLI/server 带走——这正是「拖垮宿主」最现实的一条路径。
//    报告出口的形状照抄 `apps/server/src/requestRouter.ts` 的 `onInternalError`：可注入，
//    缺省 `console.error`。缺省不能是静默吞掉——那是「静默地正确」本身。
//    第二个参数给事件名，方便宿主归因；`(error) => void` 形态的 `onInternalError` 可以直接传进来
//    （TS 允许少收参数），C3 因此不必为此另写一个适配。
//    报告函数自己抛异常时只能吞——再往上报没有下一站了，而让它把派发循环打断，等于一个坏的
//    报告器就能实现「一个 handler 拖垮其余 handler」。
//
// 3. **重复订阅同一个 handler**：算**两条独立订阅**，事件到时调用两次，各自拿到自己的取消函数。
//    不去重的理由是取消语义：接口承诺「每次 `onHostEvent` 返回一个能取消这次订阅的函数」，
//    去重之后两次订阅只剩一条，先调用的那个取消函数就会把另一个消费方的订阅一并杀掉——而
//    两个消费方传同一个函数引用是常事（同一个模块级 logger、同一个 bound method）。
//    Node 的 `EventEmitter` 也不去重；DOM `addEventListener` 去重是因为它的取消是按
//    `(type, listener)` 而不是按次，两套语义不能各取一半。
//
// 4. **重复调用同一个取消函数**：幂等，第二次及以后是 no-op，不抛异常。
//    清理路径天然会跑两遍（`finally` 加错误分支、显式 close 加 React effect cleanup），
//    在那种地方抛异常等于惩罚正确的防御式写法。
//    取消函数持有的是**自己那条订阅记录**，置位与移除都只针对那一条。两道措施分工不同：
//    `active` 是**判据**（决定还调不调，也是第 1 条里派发中途取消能生效的那一半），
//    `indexOf(subscription)` 只是**列表卫生**（把死条目摘掉）。所以若把移除写成「按 handler
//    身份找一条删」，投递行为仍然正确（`active` 兜着，这一点实测过、测试也抓不到），
//    但摘掉的会是**另一条**记录——重复订阅/退订多轮后列表里堆的是一串已死条目。
//    按订阅记录的身份删不多花什么，就没有这个问题。
//
// 本域不提供「清空整个汇」的入口：订阅是按连接/按客户端建立与取消的，一个总闸只会多出
// 「这个汇是不是已经废了」这种状态；CLI 退出由进程负责，server 端每条连接自己退订。

import { assertJsonEventPayload } from './jsonPayload'
import { isHostEventName, type HostEventName } from './hostEventNames'
import type { HostEventPayloadMap } from './hostEventPayloads'

/**
 * 事件 handler。允许返回 Promise：MCP 工具清单变化的消费方要重新拉一次 `tools/list`，
 * 天然是异步的（`tauriStdioConnector.ts` 的 `McpToolsChangedListener` 就是这个形状）。
 * 返回值本身不被等待——派发不串行化，一个慢 handler 不该拖住其余 handler。
 */
export type HostEventHandler<Name extends HostEventName = HostEventName> = (
  payload: HostEventPayloadMap[Name],
) => void | Promise<void>

/** handler 抛出/reject 时的报告出口。第二个参数是事件名，用于归因。 */
export type HostEventErrorReporter = (error: unknown, event: HostEventName) => void

export interface HostEventBusOptions {
  /**
   * 不传 → `console.error(error)`（口径同 `apps/server` 的 `requestRouter.ts`）。
   * 传进来的函数**必须自己保证不抛**；真抛了本模块只能吞掉。
   */
  readonly onHandlerError?: HostEventErrorReporter
}

/** 订阅面。C3 的 SSE 端点、C4 经 C3 到达的前端，只需要这一半。 */
export interface HostEventSource {
  /**
   * 订阅一个宿主事件，返回取消函数。取消后 handler 一定不再被调用，**包括事件正在派发的中途
   * 取消**；重复取消是 no-op。同一个 handler 订阅两次 = 两条独立订阅。
   */
  onHostEvent<Name extends HostEventName>(
    name: Name,
    handler: HostEventHandler<Name>,
  ): () => void
}

/** 发射面。C1 的 MCP stdio 传输层只需要这一半。 */
export interface HostEventSink {
  /**
   * 发出一个宿主事件。同步派发给当前的订阅者；载荷在**任何 handler 被调用之前**校验，
   * 不合规抛 `TypeError`（见 `jsonPayload.ts`），所以不存在半送达。
   */
  emitHostEvent<Name extends HostEventName>(
    name: Name,
    payload: HostEventPayloadMap[Name],
  ): void
}

export interface HostEventBus extends HostEventSource, HostEventSink {}

interface Subscription {
  // 存成 `(payload: never) => …`：`HostEventHandler<'mcp-stdio-close'>` 在 strictFunctionTypes 下
  // 不能赋给 `HostEventHandler<HostEventName>`（参数逆变），而 `never` 可赋给任何参数类型，
  // 于是存入无需断言、只在调用点留一次 `as never`。类型安全靠公开的泛型签名兜住，
  // 汇内部本来就不该认识具体是哪个事件。
  readonly handler: (payload: never) => void | Promise<void>
  active: boolean
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}

export function createHostEventBus(options: HostEventBusOptions = {}): HostEventBus {
  const reportError = options.onHandlerError
    ?? ((error: unknown) => {
      console.error(error)
    })
  const subscriptions = new Map<HostEventName, Subscription[]>()

  function report(error: unknown, event: HostEventName): void {
    try {
      reportError(error, event)
    } catch {
      // 报告出口自己坏了。再往上报没有下一站，只能吞——但绝不能让它中断派发循环，
      // 否则一个坏的报告器就等价于「一个 handler 拖垮其余 handler」。
    }
  }

  return {
    onHostEvent(name, handler) {
      // 名字在运行期也判一次：调用方可能是从线上读回来的字符串（C3/C4），或者有人 `as` 掉了类型。
      // 不判的话，错名字订阅是一条永远不会被派发到的死订阅——静默失败，正是收敛联合要消灭的东西。
      if (!isHostEventName(name)) {
        throw new TypeError(`Unknown host event name: ${String(name)}`)
      }
      const subscription: Subscription = { handler, active: true }
      let list = subscriptions.get(name)
      if (!list) {
        list = []
        subscriptions.set(name, list)
      }
      const owner = list
      owner.push(subscription)
      return () => {
        if (!subscription.active) return
        subscription.active = false
        const index = owner.indexOf(subscription)
        if (index >= 0) owner.splice(index, 1)
      }
    },

    emitHostEvent(name, payload) {
      if (!isHostEventName(name)) {
        throw new TypeError(`Unknown host event name: ${String(name)}`)
      }
      assertJsonEventPayload(name, payload)
      const list = subscriptions.get(name)
      if (!list || list.length === 0) return
      // 快照 + 逐个复查 active：见文件头第 1 条。
      for (const subscription of [...list]) {
        if (!subscription.active) continue
        try {
          const result = subscription.handler(payload as never)
          if (isPromiseLike(result)) {
            // 只在真返回 thenable 时接一层：同步 handler 因此完全同步完成，不拖一个多余的微任务，
            // 也让「同步抛出 → 同步报告」这条路径在测试里是确定的。
            Promise.resolve(result).then(undefined, (error: unknown) => {
              report(error, name)
            })
          }
        } catch (error) {
          report(error, name)
        }
      }
    },
  }
}
