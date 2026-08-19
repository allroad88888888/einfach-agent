// URL 路径 → 站点根下的相对分段。**纯函数、零 IO**，因为它是路径禁闭的第一道也是最硬的一道：
// 只要这里不放行任何 `..`，后面拼出来的路径就不可能指向根外，落盘那一步的 realpath 复核
// （见 staticFiles.ts）挡的是另一件事——软链接。
//
// 分成独立文件的理由不是行数，是**可测性**：走完整 HTTP 栈根本测不到最要紧的那些形态。
// WHATWG `URL` 在解析时就会把**未编码**的 `..` 消掉（`new URL('/a/../../etc', base).pathname`
// === `/etc`），Node 的 http client 也会规范化请求行。于是「明文 ../」这种输入压根到不了 handler
// ——它被规范化成了一个根下的普通路径。真正能活着到达的是**百分号编码**的变体，而那正是本函数
// 存在的原因。两类形态各有各的测法：明文变体直接喂这个函数，编码变体走真实 HTTP 请求。
//
// 【解码只做一次】这是防二次编码的全部机制。攻击形态是 `%252e%252e%252f`：解码一次得到
// `%2e%2e%2f`（一个字面文件名，磁盘上不存在 → 404），解码两次才会变成 `../`。所以规则不是
// 「解码后再检查有没有残留的编码」，而是**解码恰好一次，然后判定，之后再也不解码**。
// 下游（staticFiles.ts）拿到的是分段数组而不是字符串，结构上就没有「再解一次」的入口。

const SEPARATOR_PATTERN = /[/\\]+/

export type StaticPathResolution =
  | { readonly kind: 'segments', readonly segments: readonly string[] }
  | { readonly kind: 'rejected', readonly reason: string }

/**
 * `pathname` 收的是 URL 的 path 部分（以 `/` 开头、仍带百分号编码）。
 * 返回的分段可以直接 `join(root, ...segments)`：已经保证不含 `..`、`.` 与空段。
 */
export function resolveStaticPath(pathname: string): StaticPathResolution {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // `%zz` 这类坏编码。不要「解不开就原样用」——那等于给了一条绕过下面全部判定的旁路。
    return { kind: 'rejected', reason: '请求路径的百分号编码不合法。' }
  }
  if (decoded.includes('\0')) {
    // `%00` 截断：老式 C 字符串 API 会在 NUL 处截断，让 `/index.html%00.png` 这类输入骗过
    // 「扩展名是图片」的判定。Node 自己也会对含 NUL 的路径抛错，这里显式拒掉，报因不报果。
    return { kind: 'rejected', reason: '请求路径包含非法字符。' }
  }
  const segments: string[] = []
  // `\` 与 `/` 一视同仁地当分隔符：Windows 上 `\` 就是分隔符，而在 unix 上把 `..\..` 当成
  // 一个普通文件名去 stat 顶多是 404——按分隔符切是两个平台都安全的那一侧。
  for (const segment of decoded.split(SEPARATOR_PATTERN)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { kind: 'rejected', reason: '请求路径越出站点根目录。' }
    segments.push(segment)
  }
  return { kind: 'segments', segments }
}
