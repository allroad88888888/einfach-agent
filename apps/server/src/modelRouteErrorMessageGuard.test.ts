// 守卫：apps/server 的运行时源码里，**不许有任何一处比对中文错误文案**。
// ---------------------------------------------------------------------------
// 这是 M6 的第二条判据，写成机械判定而不是一次性 grep——它要在往后每一次改动上都成立。
//
// 【守的是什么】host-node 的错误文案是一份**跨宿主对外契约**：桌面宿主与 Node 宿主必须对同一
// 种失败说同一句话。apps/server 一旦照抄一份中文串来 switch（或者 `.includes('未配置')` 这种
// 更隐蔽的写法），这份契约就有了第二个权威——那边改一次措辞，这里静默落进兜底分支，状态码
// 退化，而**没有任何编译错误、没有任何用例转红**。判别面是 `reason` 字段，映射表只有一张
// （modelRouteError.ts），这个文件负责让「又冒出一张」当场被抓住。
//
// 【两层判据】
//   ① host-node model 域的文案常量，在 apps/server 的运行时源码里**一次都不许出现**（连注释里
//      引用一句都算——注释同样会漂移，而且它正是「先抄进注释、再抄进代码」的第一步）。
//   ② 任何含中文的字符串字面量，不许出现在**比较位置**（`===`/`!==`、`case`、`.includes(` …）。
//      ①管的是照抄整句，②管的是按片段猜。
//
// 【为什么不扫 `*.test.ts`】用例里出现中文文案是**断言**，不是分派：它钉住「这次响应确实把
// host-node 那句话原样透传了」，而这正是本卡要保住的行为。断言不参与运行时决策，也不会在
// 文案改动时静默劣化——它会当场转红，那时人正在改文案，这是要的效果。
// `*.testHarness.ts` **在扫描范围内**：它是普通模块，没有「转红即提醒」这层保护。
//
// 【这个守卫自己不许静默失效】下面第三个 describe 是它的自检：抽取到的文案条数有下限，
// 注释剥离与比较位置识别各有一条正反用例。少了自检，一个写坏的正则会让整份守卫恒绿。

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SERVER_SRC = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SERVER_SRC, '..', '..', '..')
const HOST_NODE_MODEL_ERRORS = join(REPO_ROOT, 'packages/host-node/src/model/errors.ts')

const CJK = /[㐀-䶿一-鿿]/

/**
 * 把注释剥掉，保留字符串字面量本身。
 *
 * 必须剥注释：本仓库的注释全是中文，而且**会举例说明不该怎么写**（比如上面那段文件头就写着
 * `.includes('未配置')`）。不剥的话守卫会被自己的说明文字判红。
 *
 * 正则字面量按「上一个有意义字符」的经典启发式识别——认错了只会漏判某一行，不会误报，
 * 而漏判有第 ① 层兜着。
 */
function stripComments(source: string): string {
  let out = ''
  let index = 0
  let lastSignificant = ''
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          out += source.slice(index, index + 2)
          index += 2
          continue
        }
        out += source[index]
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      lastSignificant = quote
      continue
    }
    if (char === '/' && '(,=:[!&|?{;+*%<>~^'.includes(lastSignificant)) {
      // 正则字面量：整段跳过，里面的引号不当字符串起始。
      out += char
      index += 1
      let inClass = false
      while (index < source.length) {
        const current = source[index]
        if (current === '\\') {
          index += 2
          continue
        }
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) {
          index += 1
          break
        }
        index += 1
      }
      lastSignificant = '/'
      continue
    }
    out += char
    if (!/\s/.test(char)) lastSignificant = char
    index += 1
  }
  return out
}

/** 源码里所有含中文的字符串/模板字面量（模板按 `${}` 切成片段）。 */
function chineseLiterals(code: string): string[] {
  const found: string[] = []
  for (const match of code.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    for (const piece of raw.split(/\$\{[^}]*\}/)) {
      if (CJK.test(piece)) found.push(piece)
    }
  }
  return found
}

/** apps/server 的运行时源码（用例不算，理由见文件头）。 */
function runtimeSources(): { path: string, source: string }[] {
  const files: { path: string, source: string }[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push({ path, source: readFileSync(path, 'utf8') })
      }
    }
  }
  walk(SERVER_SRC)
  return files
}

/** 比较位置：等号两侧、case 标签、以及几个「按内容找」的字符串方法。 */
const COMPARISON_PATTERNS: readonly RegExp[] = [
  /(?:===|!==|==|!=)\s*(['"`])([^'"`\n]*)\1/g,
  /(['"`])([^'"`\n]*)\1\s*(?:===|!==|==|!=)/g,
  /\bcase\s+(['"`])([^'"`\n]*)\1/g,
  /\.(?:includes|startsWith|endsWith|indexOf|lastIndexOf|search|match|matchAll)\(\s*(['"`])([^'"`\n]*)\1/g,
]

function comparisonsAgainstChinese(code: string): string[] {
  const hits: string[] = []
  for (const pattern of COMPARISON_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      if (CJK.test(match[2] ?? '')) hits.push(match[0])
    }
  }
  return hits
}

const MODEL_ERROR_MESSAGES = chineseLiterals(
  stripComments(readFileSync(HOST_NODE_MODEL_ERRORS, 'utf8')),
)

describe('host-node 的错误文案不许出现在 apps/server 的运行时源码里', () => {
  it('抽到的文案不少于 11 条——抽空了的话下面整组断言就是恒绿的', () => {
    // MODEL_ERROR 十条 + 「模型请求已取消」+「未配置 」这个模板片段。
    expect(MODEL_ERROR_MESSAGES.length).toBeGreaterThanOrEqual(11)
  })

  it.each(MODEL_ERROR_MESSAGES)('%s 零命中', (message) => {
    const offenders = runtimeSources()
      .filter((file) => file.source.includes(message))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })
})

describe('apps/server 的运行时源码里没有任何一处比对中文文案', () => {
  it('等号、case、includes/startsWith… 全扫过', () => {
    const offenders = runtimeSources().flatMap((file) =>
      comparisonsAgainstChinese(stripComments(file.source)).map((hit) => `${file.path}: ${hit}`),
    )
    expect(offenders).toEqual([])
  })

  it('扫描面不为空——目录走错时这条会红，而不是让整组断言恒绿', () => {
    const files = runtimeSources()
    expect(files.length).toBeGreaterThan(20)
    expect(files.some((file) => file.path.endsWith('modelRouteError.ts'))).toBe(true)
  })
})

describe('守卫自身的自检', () => {
  it('注释里的示例不算违规', () => {
    const snippet = `// 反例：error.message === '模型请求格式无效'\n/* case '模型响应过大': */\nconst x = 1\n`
    expect(comparisonsAgainstChinese(stripComments(snippet))).toEqual([])
  })

  it('真的比较则一定被抓住', () => {
    const cases = [
      `if (error.message === '模型请求格式无效') return 400`,
      `if ('模型响应过大' === message) return 502`,
      `switch (m) { case '模型请求已取消': break }`,
      `if (message.includes('未配置')) return 503`,
      `if (message.startsWith('模型')) return 400`,
    ]
    for (const code of cases) {
      expect(comparisonsAgainstChinese(stripComments(code)).length).toBeGreaterThan(0)
    }
  })

  it('英文字面量的比较不受影响——守的是中文文案，不是所有字符串', () => {
    expect(comparisonsAgainstChinese(stripComments(`if (kind === 'invalid-json') return 400`)))
      .toEqual([])
  })

  it('剥注释不会把字符串里的 // 或 /* 当成注释', () => {
    const snippet = `const url = 'http://example.com/*not-a-comment*/'\n`
    expect(stripComments(snippet)).toContain('http://example.com')
  })
})
