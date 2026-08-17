#!/usr/bin/env node
// 状态机制不变量门禁 —— 只管「违反后不报错、只在 undo 或崩溃恢复时以静默错值浮出来」这一类。
// ---------------------------------------------------------------------------
// 与 check-boundaries.js 的分工：那个管**包之间的边界**（import 方向、厂商名、公开面白名单），
// 本脚本管**状态机制本身**。两者都逐行扫源码，但判据与失效模式完全不同，故不合并。
//
// 只收能被 grep 判定的两条。需要判断的部分（这个 atom 该 primitive 还是 derived、
// 某处写入该不该进 command 层）靠 review 与 CLAUDE.md §状态与 UI 边界。
//
// 【关于插件的写入面】`CoreCtx.store` 是裸 `Store`（`coreCtx.ts` 头部写着「裸给」），但它**只对
//   仓内插件开放**：带 `LoopHooks` 的 `AgentPlugin` / `PluginApi` 住在 `runtime/core/pluginApi.ts`，
//   既不在 core 公开面白名单九条里，也不被 `plugin.ts` / `index.ts` 导出。公开插件经
//   `@web-agent/core/plugin` 只拿到 `PluginRunApi = { commands, observeRun, onAfterToolCall }`
//   —— 没有 store，写一律走 commands。所以插件写入面**已经收口**，仓内那几个（如
//   finishReasonPlugin）在本门禁扫描范围内，见豁免表。

import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootArgument = process.argv.indexOf('--root')
const repositoryRoot = rootArgument === -1 ? defaultRoot : resolve(process.argv[rootArgument + 1] ?? '')
const sourceFilePattern = /\.(?:ts|tsx)$/
// 与 check-boundaries 同口径：测试脚手架不是生产代码。
const testFilePattern = /\.(?:test|testHarness|testFixtures|fixtures)\.(?:ts|tsx)$/

// ---------------------------------------------------------------------------
// 规则 1 · derived 的 read fn 必须是纯函数
// ---------------------------------------------------------------------------
// 为什么：恢复 = 从快照重放；重放要能得出同样的结果。read fn 里读时钟或取随机数，
//   恢复后的派生值就和崩溃前不一样，而且不报错。
// 违反后：undo 之后重算的派生值和原来不一致，redo 也对不上。全程静默。
// 需要「当前时间」时，把它作为 primitive atom 写进去，由 command 层在写入时取值。
const impureCallPattern = /\b(?:Date\.now|Math\.random|performance\.now|crypto\.randomUUID)\s*\(|\bnew\s+Date\s*\(/
const derivedOpenPattern = /\batom\s*\(\s*\(\s*get\b/

// ---------------------------------------------------------------------------
// 规则 2 · 会话状态的写入必须落在它的所有者模块里
// ---------------------------------------------------------------------------
// 为什么：事务日志需要每次写入都留下 (key, prev, next)，而显式声明是唯一可行解——自动捕获
//   要给每个被追踪 atom 常驻订阅和基线值，成本 O(被追踪 atom 数)，在 family 场景下不成立。
// 违反后：这次写入不进事务日志。undo 越过它时该 atom 停在新值、其余全部回滚 —— 状态自相矛盾，
//   且只在 undo 或崩溃恢复时才以静默错值浮出来。
//
// **只管会话 atom**，判据是「这个 atom 会不会进 per-session 的事务日志」：
//   · 管：`state/sessionAtoms`、`state/sessionTransientAtoms`、`state/subagentContinuationAtoms`、
//     `execution/graph` 里的会话级 atom —— 它们是一个会话的内容。
//   · 不管：root store 的 `sessionsAtom` / `workspacesAtom` / `projectSkillsAtom` 等跨会话登记表。
//     它们不是会话内容，undo 一个会话不该动到会话列表，因此不需要事务包裹。
//   · 不管：`apps/web` 的 mcp/settings/plugins 与 `packages/subagents` 的视图 atom（同上，且不进快照）。
// 早一版规则按「文件里出现 .setter(」一刀切，把 root 写入误算成欠债；判据改成「这一行写的是哪个
// atom」之后，欠债清单才是 L1 真正要收口的那几处。
const writeScopeDirectory = 'packages/agent-core/src'
const sessionAtomModulePattern = /(?:state\/session(?:Atoms|TransientAtoms)|state\/subagentContinuationAtoms|execution\/graph)/
const setterPattern = /\.setter\s*\(/
// 会话 atom 的写入被允许出现的位置：写入器层与命令层。
const writeAllowedPrefixes = ['state/', 'runtime/commands/']
// **所有者模块**：某个会话 atom 的写入天然属于它，搬进 state/ 反而倒置分层。
//
// 这张表**只能容纳不进账本的 atom**。它原先登记的两项都是槽位（`executionGraphAtom`、
// `subagentContinuationsAtom`），登记理由写的是「接事务日志时它们就是被 transaction 包住的那一层」——
// 而事实是接上之后它们仍在用裸 `store.setter`，于是那两个槽位从未入账：撤销一轮会把
// items/run/plan 退回去，执行图与子 Agent continuation 停在新值上，状态自相矛盾且只在 undo 时浮出来。
// 两处已改走 `writeSlot`。**新增登记前先问一句：这个 atom 在 SESSION_SLOTS 里吗？在，就不该进这张表。**
const writeOwnerModules = [
  {
    path: 'execution/runtime.ts',
    reason: 'executionEventsAtom 的唯一写入者，而它不是槽位（不进快照、不进账本、当前全仓无读取方）；'
      + 'executionGraphAtom 已改走 state/ 的 writeSlot，不再靠本表豁免',
  },
]
// **欠债**：不是写入器却就地写会话 atom，应当收口。命中降级为观察项，但不代表没问题。
// 当前为空 —— L1 第一片已把三处收口：`finishReasonPlugin` 与 `modelTurnRequester` 改走
// `state/sessionWriters` 的 store-scoped 写入器（`appendItemToStore` /
// `setContextCheckpointOnStore`）。留着这张表是因为下一处欠债需要一个有名字的去处，
// 而不是被顺手登记成「所有者模块」。
const writeExemptions = []

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
    .catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await typescriptFiles(path))
    else if (entry.isFile() && sourceFilePattern.test(entry.name) && !testFilePattern.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function relativePath(path) {
  return relative(repositoryRoot, path).split(sep).join('/')
}

/** 从 derived 开括号处向后配平括号，返回该 atom 表达式覆盖的行区间。 */
function derivedBodyRange(lines, startIndex) {
  let depth = 0
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (character === '(') depth += 1
      else if (character === ')') depth -= 1
    }
    if (depth <= 0) return [startIndex, index]
  }
  return [startIndex, lines.length - 1]
}

async function checkDerivedPurity(files, errors) {
  for (const path of files) {
    const lines = (await readFile(path, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      if (!derivedOpenPattern.test(line)) continue
      const [start, end] = derivedBodyRange(lines, index)
      for (let cursor = start; cursor <= end; cursor += 1) {
        const body = lines[cursor]
        if (/^\s*(?:\/\/|\*)/.test(body)) continue
        const match = impureCallPattern.exec(body)
        if (!match) continue
        errors.push(
          `${relativePath(path)}:${cursor + 1} derived 必须是纯函数（${match[0].trim()}）`
          + ' —— 需要当前时间/随机数时改成 primitive atom，由 command 层写入时取值',
        )
      }
    }
  }
}

/**
 * SESSION_SLOTS 里登记的 atom 标识符。
 *
 * 从源码抽而不是 import：本脚本由 node 直跑，import TS 要先编译。找不到任何一项就抛 ——
 * 那说明槽位表的结构变了、这条规则已经失效，静默放过比不检查更糟。
 */
async function slotAtomNames() {
  const source = await readFile(
    resolve(repositoryRoot, writeScopeDirectory, 'state/sessionSlots.ts'), 'utf8',
  )
  const names = new Set()
  for (const [, name] of source.matchAll(/\bslot\(\s*'[^']*'\s*,\s*([A-Za-z_$][\w$]*)/g)) names.add(name)
  if (names.size === 0) {
    throw new Error('未能从 state/sessionSlots.ts 抽出槽位 atom —— 槽位表结构已变，请同步本脚本的抽取式')
  }
  return names
}

async function checkWriteChokepoint(files, errors, observations) {
  const scopeRoot = resolve(repositoryRoot, writeScopeDirectory)
  const slotAtoms = await slotAtomNames()
  for (const path of files) {
    const scoped = relative(scopeRoot, path).split(sep).join('/')
    if (scoped.startsWith('..')) continue
    if (writeAllowedPrefixes.some((prefix) => scoped.startsWith(prefix))) continue
    const source = await readFile(path, 'utf8')
    const lines = source.split('\n')

    // 本文件从会话 atom 模块 import 进来的标识符 —— 只有写这些才算命中。
    const sessionAtoms = new Set()
    for (const [, names, specifier] of source.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
    )) {
      // 相对说明符先解析成仓相对路径：`execution/runtime.ts` 里的 './graph' 就是
      // `execution/graph`，直接对字面量做匹配会漏掉整个同目录 import 家族。
      const resolved = specifier.startsWith('.')
        ? relative(scopeRoot, resolve(dirname(path), specifier)).split(sep).join('/')
        : specifier
      if (!sessionAtomModulePattern.test(resolved)) continue
      for (const raw of names.split(',')) {
        const name = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/).pop()?.trim()
        if (name) sessionAtoms.add(name)
      }
    }
    if (sessionAtoms.size === 0) continue

    // 记下命中的是哪个 atom：所有者模块表只能豁免「不进账本」的 atom，判定要用到名字。
    const hits = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => setterPattern.test(line) && !/^\s*(?:\/\/|\*)/.test(line))
      .map(({ line, index }) => ({
        index,
        atom: [...sessionAtoms].find((name) => new RegExp(`\\.setter\\s*\\(\\s*${name}\\b`).test(line)),
      }))
      .filter(({ atom }) => atom !== undefined)
    if (hits.length === 0) continue

    const owner = writeOwnerModules.find((item) => item.path === scoped)
    const exemption = writeExemptions.find((item) => item.path === scoped)
    for (const { index, atom } of hits) {
      const location = `${relativePath(path)}:${index + 1}`
      if (owner && slotAtoms.has(atom)) {
        // 所有者模块表挡不住这一类：槽位不记账 = undo 把它留在新值上、其余槽位已回滚，
        // 状态自相矛盾且全程不报错。这条正是 executionGraphAtom / subagentContinuationsAtom
        // 真实发生过的漏账（两者当时都登记在所有者模块表里）。
        errors.push(
          `${location} ${atom} 在 SESSION_SLOTS 里 —— 槽位写入必须经 state/ 的 writeSlot 记账，`
          + '不能靠所有者模块表豁免：不入事务日志的槽位会在 undo 后停在新值上，而其余槽位已回滚',
        )
      } else if (owner) {
        observations.push(`${location} 所有者模块（按设计，非欠债）：${owner.reason}`)
      } else if (exemption) {
        observations.push(`${location} 待收口（L1 欠债）：${exemption.reason}`)
      } else {
        errors.push(
          `${location} 会话 atom 的写入必须落在 ${writeAllowedPrefixes.join(' 或 ')}`
          + '，或在 check-state-invariants.js 的所有者模块表里登记；新增写入点请走 writer/command 层',
        )
      }
    }
  }
}

async function main() {
  const allFiles = (await Promise.all([
    typescriptFiles(resolve(repositoryRoot, 'packages')),
    typescriptFiles(resolve(repositoryRoot, 'tools')),
    typescriptFiles(resolve(repositoryRoot, 'apps')),
  ])).flat()
  const errors = []
  const observations = []
  await checkDerivedPurity(allFiles, errors)
  await checkWriteChokepoint(allFiles, errors, observations)

  if (observations.length > 0) {
    console.log(`状态不变量观察项（${observations.length} 处，均已登记）：`)
    for (const observation of observations) console.log(`- ${observation}`)
  }
  if (errors.length > 0) {
    console.error('状态不变量检查失败：')
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`状态不变量检查通过（扫描 ${allFiles.length} 个非测试 TS/TSX 文件，生效 2 条规则）。`)
  console.log('规则 1：derived 的 read fn 禁读时钟/随机数——否则重放得不到同样结果，且静默。')
  console.log(`规则 2：${writeScopeDirectory} 里对**会话 atom** 的写入只允许出现在 ${writeAllowedPrefixes.join(' / ')}，`)
  console.log('或所有者模块表里登记过的模块。root store 的跨会话登记表与应用层 atom 不在管辖范围。')
}

main().catch((error) => {
  console.error(`状态不变量检查失败：${error.message}`)
  process.exitCode = 1
})
