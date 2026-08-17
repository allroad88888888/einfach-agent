#!/usr/bin/env node
// 状态机制不变量门禁 —— 只管「违反后不报错、只在 undo 或崩溃恢复时以静默错值浮出来」这一类。
// ---------------------------------------------------------------------------
// 与 check-boundaries.js 的分工：那个管**包之间的边界**（import 方向、厂商名、公开面白名单），
// 本脚本管**状态机制本身**。两者都逐行扫源码，但判据与失效模式完全不同，故不合并。
//
// 只收能被 grep 判定的两条。需要判断的部分（这个 atom 该 primitive 还是 derived、
// 某处写入该不该进 command 层）靠 review 与 CLAUDE.md §状态与 UI 边界。
//
// 【本门禁看不到的缺口】`runtime/core/coreCtx.ts` 的头部注释写着「写：ctx.store.setter(atom, next)
//   **裸给**」——插件上下文按设计把裸 setter 交给插件。仓内插件（如 finishReasonPlugin）会被规则 2
//   扫到，但**仓外插件不在扫描范围**，所以这不是一个站点而是一扇门。接入事务日志前必须把它换成
//   受事务包裹的写入面，否则每个第三方插件的写都绕过 undo 日志。

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
// 规则 2 · core 会话状态的写入必须收口在 writer / command 层
// ---------------------------------------------------------------------------
// 为什么：undo 需要每次写入都留下 (key, prev, next)，而显式声明是唯一可行解——自动捕获
//   要给每个被追踪 atom 常驻订阅和基线值，成本 O(被追踪 atom 数)，在 family 场景下不成立。
// 违反后：这次写入不进事务日志。undo 越过它时该 atom 停在新值上、其余全部回滚 —— 状态自相矛盾。
// 作用域刻意只到 packages/agent-core/src：apps/web 的 mcp/settings/plugins 与 packages/subagents
//   的视图 atom 不是会话状态、不进恢复快照，也不该进 undo 日志，属于本规则之外。
const writeScopeDirectory = 'packages/agent-core/src'
const writeAllowedPrefixes = ['state/', 'runtime/commands/']
const setterPattern = /\.setter\s*\(/
// 白名单外的既有命中：命中时降级为观察项而不是 fail，且必须写明原因与归属。
// 这张表是「冻结今天的集合、阻止新增」，不是「这些写法没问题」——它们恰恰是 L1 要收口的对象。
const writeExemptions = [
  {
    path: 'runtime/modelTurnRequester.ts',
    reason: 'contextCheckpointAtom（在 V1 快照里）由压缩流程就地写；L1 收口时改走 writer',
  },
  {
    path: 'execution/runtime.ts',
    reason: 'executionGraphAtom / executionEventsAtom（前者在 V1 快照里）由执行图 reducer 就地写；同上',
  },
  {
    path: 'runtime/core/plugins/finishReasonPlugin.ts',
    reason: 'itemsAtom（在 V1 快照里）追加提示条目；插件写入面的收口见 coreCtx 那条',
  },
  {
    path: 'subagents/continuationStore.ts',
    reason: 'subagentContinuationsAtom（在 V1 快照里）由子 run 机制就地写；同上',
  },
  {
    path: 'runtime/toolLoading.ts',
    reason: 'sessionsAtom 是 ghost guard 的权威登记表，非会话内容；不进 undo 日志',
  },
  {
    path: 'runtime/core/plugins/migrationPlugin.ts',
    reason: '同上：迁移改写 SessionMeta 静态字段',
  },
  {
    path: 'runtime/core/projectSkillsStore.ts',
    reason: 'projectSkillsAtom 是跨会话的 root 状态，不是会话内容',
  },
]

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

async function checkWriteChokepoint(files, errors, observations) {
  const scopeRoot = resolve(repositoryRoot, writeScopeDirectory)
  for (const path of files) {
    const scoped = relative(scopeRoot, path).split(sep).join('/')
    if (scoped.startsWith('..')) continue
    if (writeAllowedPrefixes.some((prefix) => scoped.startsWith(prefix))) continue
    const lines = (await readFile(path, 'utf8')).split('\n')
    const hits = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => setterPattern.test(line) && !/^\s*(?:\/\/|\*)/.test(line))
    if (hits.length === 0) continue
    const exemption = writeExemptions.find((item) => item.path === scoped)
    for (const { index } of hits) {
      const location = `${relativePath(path)}:${index + 1}`
      if (exemption) {
        observations.push(`${location} 观察项：core 状态写入未收口 —— 豁免原因：${exemption.reason}`)
      } else {
        errors.push(
          `${location} core 状态写入必须收口在 ${writeAllowedPrefixes.join(' 或 ')}`
          + '（新增写入点请走 writer/command 层；确有理由请在 check-state-invariants.js 的豁免表里写明）',
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
    console.log(`状态不变量观察项（${observations.length} 处，均在豁免表内）：`)
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
  console.log(`规则 2：${writeScopeDirectory} 里的 .setter( 只允许出现在 ${writeAllowedPrefixes.join(' / ')}；`)
  console.log('作用域不含 apps/web 的 mcp/settings/plugins 与 packages/subagents 的视图 atom——它们不是会话状态。')
}

main().catch((error) => {
  console.error(`状态不变量检查失败：${error.message}`)
  process.exitCode = 1
})
