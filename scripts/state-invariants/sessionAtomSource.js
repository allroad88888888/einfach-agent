// 从「会话状态实际增长的那几个模块」里抽出每一个 atom 声明。
// ---------------------------------------------------------------------------
// 与 slotSource.js 一样是抽取而不是 import：本脚本由 node 直跑，import TS 要先编译。分成两个
// 抽取模块是因为两者认的东西不同——那边认 `slot(...)` 调用（一个会话**已登记**的状态），
// 这边认 `atom(...)` 声明（一个会话**实际拥有**的状态）。规则 4 做的正是把这两个集合对起来。

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { derivedOpenPattern } from './derivedPurity.js'
import { relativePath } from './sourceFiles.js'

/**
 * 枚举范围：会话状态实际增长的四个模块。
 *
 * 不扫全仓「所有 atom」：应用层与子 Agent 的视图 atom 不是会话内容，混进来会让规则 4 变成一张
 * 几十项的噪音表，然后没人再读它。**治理边界按「是不是会话状态」划，不按「值落在哪个 store」划**
 * ——`ActiveSessionProvider` 把整棵右栏挂在会话 store 上（`sessionAtomScope(id)` 返回的就是
 * `getSessionStore(id).store`），所以渲染层随手 `useAtom` 的东西物理上也落在会话 store 里；
 * 那不构成把 UI 折叠态纳入恢复契约的理由。
 *
 * 但「不扫全仓」不等于「这张清单可以悄悄过期」：core 里任何一个含 atom 声明的文件，
 * 要么在这张清单里、要么在 CORE_NON_SESSION_ATOM_FILES 里说明它凭什么不是会话状态。
 * 见下面的 `coreAtomFiles`。
 */
export const SESSION_ATOM_FILES = [
  'packages/agent-core/src/state/sessionAtoms.ts',
  'packages/agent-core/src/state/sessionTransientAtoms.ts',
  'packages/agent-core/src/state/subagentContinuationAtoms.ts',
  'packages/agent-core/src/execution/graph.ts',
]

/**
 * core 里含 atom 声明、但**不是**会话状态的文件。每项都要说清凭什么。
 *
 * 这张表存在的唯一理由是让上面那张清单不能悄悄过期：新开一个 `state/fooAtom.ts` 而不登记，
 * 它就既不被枚举、也不被排除——那正是红线 10 要防的静默缺席，只是换了个层级复发。
 */
export const CORE_NON_SESSION_ATOM_FILES = [
  {
    file: 'packages/agent-core/src/state/rootAtoms.ts',
    reason: 'root store 的跨会话登记表（工作区、会话元数据、当前会话 id），按定义不是某一个会话的内容',
  },
  {
    file: 'packages/agent-core/src/state/sessionHistory.ts',
    reason: 'createSessionHistory 闭包里的 undoAvailabilityAtom，是派生只读视图，没有写入面',
  },
  {
    file: 'packages/agent-core/src/state/recoveryProjection.ts',
    reason: 'apply/clear 两个命令 atom —— write 是动作而非赋值，本身不持有状态',
  },
]

const declarationPattern = /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*atom\b/gm

/**
 * 从 `atom` 关键字之后找到这次调用的左括号，跳过可能存在的泛型实参。
 *
 * 必须跳泛型而不是直接对源码测形态：`atom<Record<string, boolean>>({})` 与
 * `atom<Foo>((get) => …)` 的头部长得完全不同，拿 `derivedOpenPattern` 硬套前者不匹配（对的），
 * 套后者也不匹配（错的，而且错的方向是把 derived 误判成 primitive）。
 */
function callOpenIndex(source, from) {
  let cursor = from
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  if (source[cursor] === '<') {
    let depth = 0
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === '<') depth += 1
      else if (source[cursor] === '>') {
        depth -= 1
        if (depth === 0) { cursor += 1; break }
      }
    }
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  }
  return source[cursor] === '(' ? cursor : -1
}

/**
 * 四个模块里每一个 atom 声明：变量名、形态（derived / primitive）、文件与行号。
 *
 * 形态判据复用规则 1 的 `derivedOpenPattern`，只是先把泛型摘掉、重新拼成 `atom(…` 再测，
 * 这样两条规则对「什么算 derived」始终是同一个理解。
 *
 * 任何一个模块抽不出 atom 就抛：那说明该文件的写法变了、规则 4 已经对它失明，
 * 而静默判空比不检查更糟——门禁会继续报「通过」。
 */
/**
 * core 里所有含 atom 声明的文件（仓库相对路径）。
 *
 * 只认声明、不认引用：`import { runAtom }` 的地方遍地都是，那不代表那个文件拥有状态。
 */
export async function coreAtomFilesWithDeclarations(repositoryRoot, files) {
  const owning = []
  for (const path of files) {
    const scoped = relativePath(repositoryRoot, path)
    if (!scoped.startsWith('packages/agent-core/src/')) continue
    const source = await readFile(path, 'utf8')
    declarationPattern.lastIndex = 0
    if (declarationPattern.test(source)) owning.push(scoped)
  }
  return owning
}

export async function sessionAtomDeclarations(repositoryRoot) {
  const declarations = []
  for (const file of SESSION_ATOM_FILES) {
    const source = await readFile(resolve(repositoryRoot, file), 'utf8')
    let found = 0
    for (const match of source.matchAll(declarationPattern)) {
      const open = callOpenIndex(source, match.index + match[0].length)
      if (open === -1) {
        throw new Error(`${file} 里 ${match[1]} 的 atom(...) 调用无法解析 —— 请同步 sessionAtomSource.js 的抽取式`)
      }
      found += 1
      declarations.push({
        name: match[1],
        file,
        line: source.slice(0, match.index).split('\n').length,
        shape: derivedOpenPattern.test(`atom${source.slice(open, open + 48)}`) ? 'derived' : 'primitive',
      })
    }
    if (found === 0) {
      throw new Error(`未能从 ${file} 抽出任何 atom —— 该模块的写法已变，请同步 sessionAtomSource.js 的抽取式`)
    }
  }
  return declarations
}
