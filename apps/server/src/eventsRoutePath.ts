// `/api/events` 的路径判定 —— 只回答「这条请求归不归 SSE 端点」。
// ---------------------------------------------------------------------------
// 单独成文件的理由与 `invokeRouteCommandName.ts` 同：`requestRouter.ts` 需要这个判据来分派，
// 而 handler 工厂那边还拖着 `HostEventSource` 与 `node:http` 的一整条流式实现。判据独立出来，
// 路由分派就不必为了问一句「这是不是事件流路径」把整条实现拉进模块图。
//
// 【为什么是精确相等，而不是像 invoke 那样按前缀匹配】
// invoke 的路径自带一个参数段（`/api/invoke/<command>`），前缀匹配是它的形状使然。事件流没有
// 参数段，前缀匹配只会把 `/api/events/foo`、`/api/eventsX` 一并吃进来：调用方把路径打错，
// 拿到的却是一条正常的事件流，而它订阅的那个「子路径」压根不存在——静默地正确。精确相等下
// 这类请求落到 `handleApi` 的 404 兜底（`unknown_endpoint`），是一句准确的回答。
//
// 连带一条：`/api/events/` 这个多一个斜杠的形态同样是 404。这也是刻意的——今天宽松放行，
// 等到将来真要开 `/api/events/<something>` 这样的子路径时，旧客户端那条打错的路径已经被
// 当成合法用法用了好几个版本，那时收严就是一次破坏性变更。

/**
 * 事件流端点。**在 `/api/*` 之下**，所以它自动受 `authGuard.ts` 三道防线的管辖
 * （对端地址 → Host → Origin → token），本模块不需要、也不应该为它开任何豁免——
 * health 的豁免有它自己的理由（探测发生在拿到 token 之前），事件流没有那个理由：
 * 订阅方就是已经拿到 token 的那个页面。
 */
export const EVENTS_ROUTE_PATH = '/api/events'

/** `handleApi` 用它判断一条请求是否归本模块处理。 */
export function isEventsRoutePath(pathname: string): boolean {
  return pathname === EVENTS_ROUTE_PATH
}
