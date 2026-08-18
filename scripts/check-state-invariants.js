#!/usr/bin/env node
// 状态机制不变量门禁 —— 只管「违反后不报错、只在 undo 或崩溃恢复时以静默错值浮出来」这一类。
// ---------------------------------------------------------------------------
// 与 check-boundaries.js 的分工：那个管**包之间的边界**（import 方向、厂商名、公开面白名单），
// 本脚本管**状态机制本身**。两者都逐行扫源码，但判据与失效模式完全不同，故不合并。
//
// 只收能被机械判定的五条。需要判断的部分（这个 atom 该 primitive 还是 derived、
// 某处写入该不该进 command 层）靠 review 与 CLAUDE.md §状态与 UI 边界。
//
// 本文件只负责装配：五条规则各住 `state-invariants/` 下的一个模块，判据、表与解释性注释都在
// 那里。这里按序调用它们、汇总 errors/observations、打印结论并决定退出码。

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentStoreBindingRule } from './state-invariants/agentStoreBinding.js'
import { atomDispositionRule } from './state-invariants/atomDisposition.js'
import { derivedPurityRule } from './state-invariants/derivedPurity.js'
import { slotJournalShapeRule } from './state-invariants/slotJournalShape.js'
import { typescriptFiles } from './state-invariants/sourceFiles.js'
import { writeChokepointRule } from './state-invariants/writeChokepoint.js'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootArgument = process.argv.indexOf('--root')
const repositoryRoot = rootArgument === -1 ? defaultRoot : resolve(process.argv[rootArgument + 1] ?? '')

// 顺序即报错顺序，也是末尾规则说明的打印顺序。
const rules = [
  derivedPurityRule,
  writeChokepointRule,
  slotJournalShapeRule,
  atomDispositionRule,
  agentStoreBindingRule,
]

async function main() {
  const allFiles = (await Promise.all([
    typescriptFiles(resolve(repositoryRoot, 'packages')),
    typescriptFiles(resolve(repositoryRoot, 'tools')),
    typescriptFiles(resolve(repositoryRoot, 'apps')),
  ])).flat()
  const errors = []
  const observations = []
  for (const rule of rules) await rule.run({ repositoryRoot, files: allFiles, errors, observations })

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
  console.log(
    `状态不变量检查通过（扫描 ${allFiles.length} 个非测试 TS/TSX 文件，生效 ${rules.length} 条规则）。`,
  )
  for (const rule of rules) for (const line of rule.summary) console.log(line)
}

main().catch((error) => {
  console.error(`状态不变量检查失败：${error.message}`)
  process.exitCode = 1
})
