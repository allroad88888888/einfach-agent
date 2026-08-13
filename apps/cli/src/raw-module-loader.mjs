import { readFile } from 'node:fs/promises'

const rawPrefix = 'web-agent-raw:'

/** Makes Vite-style relative `*.md?raw` imports available to the Node CLI host. */
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith('?raw')) return nextResolve(specifier, context)
  const target = new URL(specifier.slice(0, -4), context.parentURL).href
  return { url: `${rawPrefix}${encodeURIComponent(target)}`, shortCircuit: true }
}

export async function load(url, context, nextLoad) {
  // tsx 等先注册的 loader 可能在 resolve 阶段 shortCircuit，让 ?raw 保留在最终 file URL 上——
  // 此时我们的 resolve 拿不到机会，只能在 load 阶段兜住。
  if (url.startsWith('file:') && url.endsWith('?raw')) {
    const content = await readFile(new URL(url.slice(0, -4)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(content)};`, shortCircuit: true }
  }
  if (!url.startsWith(rawPrefix)) return nextLoad(url, context)
  const sourceUrl = decodeURIComponent(url.slice(rawPrefix.length))
  const content = await readFile(new URL(sourceUrl), 'utf8')
  return {
    format: 'module',
    source: `export default ${JSON.stringify(content)};`,
    shortCircuit: true,
  }
}
