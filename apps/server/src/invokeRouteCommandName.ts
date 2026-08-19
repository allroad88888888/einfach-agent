// 从 `/api/invoke/<command>` 的请求路径里取出命令名。
// ---------------------------------------------------------------------------
// 只做一件事：URL path → 命令名字符串。合不合法（是不是 28 条全集里的那个）**不在这里判**——
// `commandNames.ts` 的 `NODE_HOST_COMMANDS_BY_DOMAIN` 是唯一权威，交给 `HostInvoke` 内部的
// `isNodeHostCommandName` 判，判定结果经 `NodeHostCommandError.reason` 带回来
// （invokeRouteError.ts 把它映射成 404/501）。在这里再校验一遍命令名字符集，只会造出第二个权威、
// 且两处判据一旦漂移（比如 Rust 侧新增命令而这里的正则没跟上）比现在更难查。

const INVOKE_ROUTE_PREFIX = '/api/invoke/'

/** `handleApi` 用它判断一条请求是否归本模块处理。 */
export function isInvokeRoutePath(pathname: string): boolean {
  return pathname.startsWith(INVOKE_ROUTE_PREFIX)
}

/**
 * 取出 `:command` 段并解码**恰好一次**。
 *
 * 【解码失败时回落到未解码原串，而不是报错】
 * 合法命令名都是不含 `%` 的纯 ASCII snake_case（`commandNames.ts` 的 28 条穷举）。一个解码失败
 * 的分段（形如 `%zz` 这种非法转义）本来就不可能等于任何合法命令名，让它原样往下传，
 * `invoke()` 内部的 `isNodeHostCommandName` 检查照样会判它「不在全集内」，走到与「解码成功但
 * 查无此命令」完全相同的 `unknown-command` → 404 路径。特地在这里另开一条「解码失败」的错误分支
 * 只会多出一种对外表现，却不比合流到同一个 404 更准确——两种情况对调用方的建议都是「这个命令名
 * 不对」，而「什么是合法命令」始终只有 host-node 一处权威。
 *
 * 【不用 `new URL()` 归一】同样是 requestPathname.ts / staticPath.ts 已经踩过的坑：WHATWG URL
 * 会在解析阶段就吞掉 dot segment，把判定的权威提前劈成两处。这里只做一次 `slice` + 一次
 * `decodeURIComponent`，命令名的合法性完全交给 host-node。
 *
 * 空分段（`/api/invoke/`）与含内嵌斜杠的分段（`/api/invoke/foo/bar`）同样不在这里特殊处理：
 * 它们解码后分别是 `''` 与 `'foo/bar'`，都不在 28 条全集里，一样会在 `invoke()` 里落到
 * `unknown-command`。
 */
export function resolveInvokeCommandName(pathname: string): string {
  const rawSegment = pathname.slice(INVOKE_ROUTE_PREFIX.length)
  try {
    return decodeURIComponent(rawSegment)
  } catch {
    return rawSegment
  }
}
