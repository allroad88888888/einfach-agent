// 从请求行取出 pathname，**不做任何归一**。
//
// 刻意不用 `new URL(request.url, base).pathname`，尽管那是最顺手的写法。理由不是它不安全
// （它的 dot-segment 弹栈到根就停，不会真的越界），而是它会在我们的判定**之前**静默改写路径：
// 实测 `new URL('/%2e%2e/secret.txt', base).pathname === '/secret.txt'`——URL 规范把
// `..` / `.%2e` / `%2e.` / `%2e%2e` 四种形态都算作 dot segment 并就地消掉，而 `%2f` / `%5c`
// 编码的分隔符它又原样留着。于是同一类穿越请求，一半在 URL 解析里被改写成一个看着合法的路径、
// 另一半才落到 staticPath.ts 的判定上：路径的权威被劈成两处，攻击流量在日志里表现为「某个
// 客户端从没请求过的路径 404 了」，而不是一次明确的拒绝。
//
// 拿原样的 pathname，让 staticPath.ts 做唯一一次判定：`..` 一律拒，编码分隔符一律按分隔符切。
// 这也让 `/api/health` 的匹配是精确的——`/api/./health` 不是 health，不会因为别处的归一而蒙混。

/** absolute-form（代理风格的 `GET http://host/path`）是这里唯一交给 URL 解析的形态。 */
function absoluteFormPathname(target: string): string {
  try {
    return new URL(target).pathname
  } catch {
    return '/'
  }
}

export function requestPathname(target: string | undefined): string {
  if (target === undefined || target === '') return '/'
  const stop = target.search(/[?#]/)
  const path = stop === -1 ? target : target.slice(0, stop)
  // origin-form（浏览器与我们自己的客户端唯一会发的形态）。
  return path.startsWith('/') ? path : absoluteFormPathname(path)
}
