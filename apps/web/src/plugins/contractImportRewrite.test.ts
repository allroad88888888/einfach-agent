// 说明符改写的支持/拒绝矩阵（P11）。
//
// 这里钉的是「哪些写法算静态 import」——它决定了 quickstart 那种插件在桌面上到底能不能装。
// 改写只换说明符 token 这一件事，所以每条用例都同时看两点：换对了没有、有没有多换。

import { describe, expect, it, vi } from 'vitest'
import { rewriteContractImports } from './contractImportRewrite'
import type { ContractModuleResolver } from './contractModuleBridge'

const SPEC = '@einfach-agent/core/plugin'
const URL_ = 'blob:test/contract-0'

function resolver(url = URL_): ContractModuleResolver {
  return { specifiers: [SPEC], urlFor: vi.fn(() => url) }
}

describe('rewriteContractImports', () => {
  it('quickstart 的写法：具名 import 换成桥 URL，行数与其余内容不变', () => {
    const source = [
      "import { definePlugin } from '@einfach-agent/core/plugin'",
      '',
      'export default definePlugin({ install() {} })',
    ].join('\n')

    const result = rewriteContractImports(source, resolver())

    expect(result.rewritten).toEqual([SPEC])
    expect(result.source).toBe([
      `import { definePlugin } from '${URL_}'`,
      '',
      'export default definePlugin({ install() {} })',
    ].join('\n'))
    // 行号不能漂：插件报错栈还要对得上作者的源码。
    expect(result.source.split('\n')).toHaveLength(3)
  })

  it.each([
    ['双引号', `import { definePlugin } from "${SPEC}"`, `import { definePlugin } from "${URL_}"`],
    ['默认 + 具名 + 重命名', `import d, { a as b } from '${SPEC}'`, `import d, { a as b } from '${URL_}'`],
    ['命名空间导入', `import * as ns from '${SPEC}'`, `import * as ns from '${URL_}'`],
    ['纯副作用导入', `import '${SPEC}'`, `import '${URL_}'`],
    ['再导出', `export { definePlugin } from '${SPEC}'`, `export { definePlugin } from '${URL_}'`],
    ['星号再导出', `export * from '${SPEC}'`, `export * from '${URL_}'`],
    ['from 后无空格', `import x from'${SPEC}'`, `import x from'${URL_}'`],
  ])('支持：%s', (_label, source, expected) => {
    expect(rewriteContractImports(source, resolver()).source).toBe(expected)
  })

  it('支持：跨行的 import 子句（只匹配 from 之后那一段，不解析子句）', () => {
    const source = `import {\n  definePlugin,\n} from '${SPEC}'\n`
    expect(rewriteContractImports(source, resolver()).source).toBe(
      `import {\n  definePlugin,\n} from '${URL_}'\n`,
    )
  })

  it('支持：同一个说明符出现多次，全部改写', () => {
    const source = `import { definePlugin } from '${SPEC}'\nexport { isPublicPlugin } from '${SPEC}'\n`
    const result = rewriteContractImports(source, resolver())
    expect(result.source).not.toContain(SPEC)
    expect(result.source.match(/blob:test\/contract-0/g)).toHaveLength(2)
  })

  it('拒绝：动态 import() 引用契约模块——说清怎么改，不留到求值时才炸', () => {
    const source = `const m = await import('${SPEC}')\nexport default m.definePlugin({})`
    expect(() => rewriteContractImports(source, resolver())).toThrow(/动态 import\(\)/)
    expect(() => rewriteContractImports(source, resolver())).toThrow(/静态 import/)
  })

  it('拒绝：import.meta.resolve() 引用契约模块', () => {
    const source = `const url = import.meta.resolve("${SPEC}")`
    expect(() => rewriteContractImports(source, resolver())).toThrow(/动态 import\(\)/)
  })

  it('拒绝：桥给出的 URL 形状不安全（会把源码写坏）', () => {
    const source = `import { definePlugin } from '${SPEC}'`
    expect(() => rewriteContractImports(source, resolver("blob:x'+evil+'"))).toThrow(/形状不合法/)
  })

  it('放过：宿主没注册的裸说明符原样保留，交给浏览器自己报解析失败', () => {
    const source = "import { registerStandardTools } from '@einfach-agent/tools'"
    const result = rewriteContractImports(source, resolver())
    expect(result.source).toBe(source)
    expect(result.rewritten).toEqual([])
  })

  it('放过：源码里没有契约说明符时逐字返回，且不构造桥（不白造 blob）', () => {
    const urlFor = vi.fn(() => URL_)
    const source = "import './local.js'\nexport default {}"
    const result = rewriteContractImports(source, { specifiers: [SPEC], urlFor })
    expect(result.source).toBe(source)
    expect(urlFor).not.toHaveBeenCalled()
  })

  it('已知代价：注释里的同形文本也会被换——只影响注释文本，不改变语义', () => {
    const source = `// 见 import { definePlugin } from '${SPEC}'\nexport default {}`
    const result = rewriteContractImports(source, resolver())
    expect(result.source).toContain(URL_)
    expect(result.source.startsWith('// 见 import')).toBe(true)
  })
})
