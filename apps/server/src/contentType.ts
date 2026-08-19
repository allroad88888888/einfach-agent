// 扩展名 → MIME。一张表，别的什么都不做。
//
// 不引 `mime-types` 之类的依赖：我们服务的是**自己 build 出来的前端产物**，扩展名集合是封闭的
// （Vite 产物 + public/ 里的图标字体），一张三十行的表覆盖得完；引一个包换来的是一条供应链面
// 和一份「它认得的类型比我们多」的错觉。表里没有的一律 `application/octet-stream`——
// 浏览器会下载而不是执行，这是保守的一侧。

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** `fileName` 收的是文件名或路径；大小写不敏感（`.PNG` 与 `.png` 同义）。 */
export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return DEFAULT_CONTENT_TYPE
  return CONTENT_TYPES[fileName.slice(dot).toLowerCase()] ?? DEFAULT_CONTENT_TYPE
}
