// 静态托管：把 `apps/web/dist` 的产物按请求路径发出去。
//
// 路径禁闭是两道，各挡各的：
// ① 词法（staticPath.ts）——解码一次、按分隔符切段、见 `..` 即拒。挡 URL 层的穿越。
// ② 落盘（本文件的 realpath 复核）——把候选路径解析到真实位置，再确认它仍在站点根之内。
//    挡的是软链接：产物目录里一条指向 `/etc` 的链接不含任何 `..`，第一道看不见它。
//    两道都用 `path.relative` 判包含关系而**不是** `startsWith` 字符串前缀——`/ws-evil` 以字符串
//    论确实以 `/ws` 开头（N2 卡记过这个陷阱），`relative` 是按分量比的。
//
// 每次请求都重新 realpath 站点根，不在启动时缓存：用户完全可能先启动服务、再去跑 `pnpm build`
// （提示页正是这么教的）。缓存一次「不存在」会让产物出来之后仍然一直显示提示页，
// 而这种「重启才好」的毛病最难被归因到缓存上。
//
// 正文用 readFile 一次读入而不是流式：dist 是前端构建产物（MB 级），一次读入换来的是更简单的
// 失败语义——所有可能出错的时点都在写响应头**之前**，不存在「头都发完了才发现读不下去」
// 那种只能粗暴断连的中间态。

import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, relative } from 'node:path'
import { contentTypeFor } from './contentType'
import { replyAsset, replyHtml, replyText, type ReplyOptions } from './httpReply'
import { renderMissingBuildPage } from './missingBuildPage'
import { resolveStaticPath } from './staticPath'

const INDEX_FILE = 'index.html'

function isInside(root: string, target: string): boolean {
  const difference = relative(root, target)
  if (difference === '') return true
  return !difference.startsWith('..') && !isAbsolute(difference)
}

type LocatedFile =
  | { readonly kind: 'file', readonly path: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'outside' }

/** 把已经过词法禁闭的分段解析成一个确实存在、且确实在根内的文件。 */
async function locateFile(root: string, segments: readonly string[]): Promise<LocatedFile> {
  const candidate = join(root, ...segments)
  // `fs/promises` 的 realpath 走 POSIX 语义（先解链接再吃 `..`）；这里 `..` 已被词法层拒光，
  // 两种语义不会分叉，取它是为了和 host-node 的路径底座（N2）保持同一个判据。
  const resolved = await realpath(candidate).catch(() => undefined)
  if (resolved === undefined) return { kind: 'missing' }
  if (!isInside(root, resolved)) return { kind: 'outside' }
  const info = await stat(resolved)
  if (info.isDirectory()) {
    // 目录请求回落到它下面的 index.html；只回落一层，避免任何形式的递归探测。
    return segments[segments.length - 1] === INDEX_FILE
      ? { kind: 'missing' }
      : locateFile(root, [...segments, INDEX_FILE])
  }
  if (!info.isFile()) return { kind: 'missing' }
  return { kind: 'file', path: resolved }
}

export async function handleStaticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  distDirectory: string,
): Promise<void> {
  const includeBody = request.method !== 'HEAD'
  const replyOptions: ReplyOptions = { includeBody }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('allow', 'GET, HEAD')
    replyText(response, 405, '静态资源只接受 GET 与 HEAD 请求。\n', replyOptions)
    return
  }
  const resolution = resolveStaticPath(pathname)
  if (resolution.kind === 'rejected') {
    replyText(response, 400, `${resolution.reason}\n`, replyOptions)
    return
  }
  const root = await realpath(distDirectory).catch(() => undefined)
  if (root === undefined) {
    // 根都不在：此刻访问者只可能是在浏览器里开首页的用户，一律给提示页而不是 404。
    replyHtml(response, 503, renderMissingBuildPage(distDirectory), replyOptions)
    return
  }
  const segments = resolution.segments.length === 0 ? [INDEX_FILE] : resolution.segments
  const located = await locateFile(root, segments)
  if (located.kind === 'outside') {
    replyText(response, 403, '目标位于站点根目录之外。\n', replyOptions)
    return
  }
  if (located.kind === 'missing') {
    // 根在、但连 index.html 都没有，属于「产物不完整」，与根缺失是同一件事、同一个处置。
    // 其余资源缺失才是普通 404——它多半意味着请求路径本身写错了。
    if (segments.length === 1 && segments[0] === INDEX_FILE) {
      replyHtml(response, 503, renderMissingBuildPage(distDirectory), replyOptions)
      return
    }
    replyText(response, 404, '未找到该资源。\n', replyOptions)
    return
  }
  replyAsset(response, contentTypeFor(located.path), await readFile(located.path), replyOptions)
}
