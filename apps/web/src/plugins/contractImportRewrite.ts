// apps/web/src/plugins/contractImportRewrite.ts —— 求值前把契约裸说明符改写成可解析 URL
// ---------------------------------------------------------------------------
// 只负责一件事：在插件源码里，把宿主认识的裸说明符（当前只有 `@einfach-agent/core/plugin`）
// 出现在【静态 import/export 语句】里的那一处，替换成契约模块桥给的 URL；其余一概不碰。
//
// 这不是 bundler，也不打算长成 bundler：
// - 只改「说明符」这一个 token，不解析 import 子句、不重排语句、不改行号——报错栈仍然对得上
//   插件作者的源码行；
// - 只认宿主注册过的说明符，别的裸说明符原样放过，让浏览器自己报
//   "Failed to resolve module specifier"（那句话本来就足够清楚，且照实反映「宿主没这条通路」）；
// - 遇到 import() / import.meta.resolve() 这类【运行时才知道要解析什么】的形态直接拒绝并说清
//   怎么改，而不是假装支持后在求值时才炸。
//
// 正则可行的前提：ESM 的静态 import/export 里，说明符只能是字符串字面量，且必然紧跟
// `from` 或 `import` 关键字。代价是注释和字符串里的同形文本也会被换——那只影响注释文本本身，
// 不改变语义，不值得为它引一个 parser。

import type { ContractModuleResolver } from './contractModuleBridge'

/** 桥给的 URL 会被塞进源码字符串里，必须是「像 URL 且不含引号/反斜杠/空白」的形状。 */
const SAFE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:[^'"\s\\]+$/

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `import x from 'spec'` / `export { x } from 'spec'`：说明符跟在 from 后面。 */
function fromFormPattern(specifier: string): RegExp {
  return new RegExp(`(\\bfrom\\s*)(['"])${escapeRegExp(specifier)}\\2`, 'g')
}

/** `import 'spec'`（纯副作用导入）：说明符直接跟在 import 后面，与 import( 不会混淆。 */
function sideEffectPattern(specifier: string): RegExp {
  return new RegExp(`(\\bimport\\s*)(['"])${escapeRegExp(specifier)}\\2`, 'g')
}

/** 拒绝面：动态 import 与 import.meta.resolve——两者都不是可以静态改写的位置。 */
function dynamicFormPattern(specifier: string): RegExp {
  const spec = escapeRegExp(specifier)
  return new RegExp(
    `\\bimport\\s*\\(\\s*(['"])${spec}\\1|\\bimport\\s*\\.\\s*meta\\s*\\.\\s*resolve\\s*\\(\\s*(['"])${spec}\\2`,
  )
}

export interface ContractImportRewriteResult {
  /** 改写后的源码；没有任何命中时与入参逐字相同。 */
  readonly source: string
  /** 实际被改写的说明符，按 resolver.specifiers 的顺序。诊断与测试用。 */
  readonly rewritten: readonly string[]
}

/**
 * 改写插件源码里对宿主契约模块的静态 import。
 *
 * 抛出（由 desktopImportModule 交给 loader 记成该插件的 failed 诊断）：
 * - 源码用动态 import() 或 import.meta.resolve() 引用契约说明符；
 * - 桥给出的 URL 形状不安全（防止把源码写坏，正常不会发生）。
 */
export function rewriteContractImports(
  source: string,
  resolver: ContractModuleResolver,
): ContractImportRewriteResult {
  let output = source
  const rewritten: string[] = []

  for (const specifier of resolver.specifiers) {
    if (!output.includes(specifier)) continue

    if (dynamicFormPattern(specifier).test(output)) {
      throw new Error(
        `入口用动态 import()/import.meta.resolve() 引用 '${specifier}'，桌面宿主只能改写静态 import 语句；`
        + `请改成顶层 \`import { ... } from '${specifier}'\``,
      )
    }

    const fromForm = fromFormPattern(specifier)
    const sideEffect = sideEffectPattern(specifier)
    if (!fromForm.test(output) && !sideEffect.test(output)) continue

    const url = resolver.urlFor(specifier)
    if (!SAFE_URL.test(url)) {
      throw new Error(`契约模块 ${specifier} 的桥 URL 形状不合法（${url}），拒绝改写源码`)
    }
    // 两点：lastIndex 会被上面的 test 推走，replace 前重新造一次正则；替换用函数而不是
    // `$1$2...` 字符串，免得 URL 里万一出现 `$&` 这类序列被当成替换指令。
    const swap = (_match: string, prefix: string, quote: string) => `${prefix}${quote}${url}${quote}`
    output = output
      .replace(fromFormPattern(specifier), swap)
      .replace(sideEffectPattern(specifier), swap)
    rewritten.push(specifier)
  }

  return { source: output, rewritten }
}
