// `/api/model/request` 的路径判定 —— 只回答「这条请求归不归模型流式端点」。
// ---------------------------------------------------------------------------
// 单独成文件的理由与 `invokeRouteCommandName.ts` / `eventsRoutePath.ts` 同：`requestRouter.ts`
// 只需要这个判据来分派，而 handler 工厂那边拖着 `@einfach-agent/host-node` 的转发实现与整条流式
// 管道。判据独立出来，路由分派就不必为了问一句「这是不是模型请求路径」把那些全拉进模块图。
//
// 【为什么是精确相等】这个端点没有参数段——要发给哪个供应商的哪个路径，全由请求体里那份信封的
// `target` 说了算，而 `target` 只能是白名单里的四元组。前缀匹配会把 `/api/model/request/foo`
// 和 `/api/model/request/../..` 一并吃进来：路径打错的调用方拿到的是一次正常的模型请求，
// 而不是一句「没这个接口」。精确相等下它们落到 `handleApi` 的 404 兜底。

/**
 * 模型代理的流式端点。**在 `/api/*` 之下**，所以它自动受 `authGuard.ts` 三道防线的管辖
 * （对端地址 → Host → Origin → token），本模块不需要、也不应该为它开任何豁免——
 * health 的豁免有它自己的理由（探测发生在拿到 token 之前），这条没有：调用方就是已经拿到
 * token 的那个页面。而这个端点会借用户的模型 API Key 去打上游，豁免它等于把用户的额度
 * 交给本机任何一个网页。
 */
export const MODEL_ROUTE_PATH = '/api/model/request'

/** `handleApi` 用它判断一条请求是否归本模块处理。 */
export function isModelRoutePath(pathname: string): boolean {
  return pathname === MODEL_ROUTE_PATH
}
