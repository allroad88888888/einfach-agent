// 发包构建里补齐 Vite 的 `?raw` 语义：把 `import md from './x.md?raw'` 内联成字符串模块。
// ---------------------------------------------------------------------------
// esbuild 不认识 `?raw` 后缀（会把它当文件名的一部分去找 `x.md?raw` 这个文件而失败），
// 所以要自己接管解析与加载。语义对齐两个既有实现，三处必须一致：
// - Vite（web/dev）：原生支持 `?raw`，默认导出文件文本。
// - apps/cli/src/raw-module-loader.mjs（Node CLI 宿主）：同样产出 `export default <文本>`。
// 只做「读文件 → default 导出字符串」，不做任何转义/裁剪：skill 正文里的反引号与 `${}`
// 靠 JSON.stringify 落进字符串字面量，不会被当模板串求值。
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Options } from 'tsup'

// 根 node_modules 里没有 esbuild（pnpm 不提升），故从 tsup 的选项类型里反取，避免为一个类型加依赖。
type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number]

const rawSuffix = '?raw'
/** 私有 namespace：进了它的路径一律走本插件的 onLoad，不再落回 esbuild 的文件加载器。 */
const rawNamespace = 'web-agent-raw'

export function rawTextPlugin(): EsbuildPlugin {
  return {
    name: 'web-agent-raw',
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, async (args) => {
        const target = args.path.slice(0, -rawSuffix.length)
        // 相对说明符以「引用方所在目录」为基准，与 Vite/Node loader 的相对语义一致。
        if (target.startsWith('.') || path.isAbsolute(target)) {
          return { path: path.resolve(args.resolveDir, target), namespace: rawNamespace }
        }
        // 包说明符（`pkg/skill.md?raw`）交给 esbuild 自己的解析器定位真实文件，再转进本 namespace。
        const resolved = await build.resolve(target, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
        })
        if (resolved.errors.length > 0) return { errors: resolved.errors }
        return { path: resolved.path, namespace: rawNamespace }
      })

      build.onLoad({ filter: /.*/, namespace: rawNamespace }, async (args) => {
        const contents = await readFile(args.path, 'utf8')
        return {
          contents: `export default ${JSON.stringify(contents)}\n`,
          loader: 'js',
          // namespace 加载的产物不在 esbuild 的文件依赖图里，watch 模式要显式登记源文件。
          watchFiles: [args.path],
        }
      })
    },
  }
}
