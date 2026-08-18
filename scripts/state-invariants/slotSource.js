// 从 state/sessionSlots.ts 的源码里抽出每一次 `slot(...)` 调用的声明。
// ---------------------------------------------------------------------------
// 规则 2（会话 atom 的写入收口）与规则 3（槽位的记账形态）都要认识槽位表，抽取式只写一遍：
// 两条规则对「什么是槽位」的理解一旦分叉，其中一条就会在无人察觉时判空。

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** 槽位表的源码位置：抽取从这里读，规则 3 的报错信息也指向这里。 */
export const SLOTS_FILE = 'packages/agent-core/src/state/sessionSlots.ts'

/**
 * SESSION_SLOTS 里每一次 `slot(...)` 调用：逻辑 key、atom 标识符、实参个数、行号。
 *
 * 从源码抽而不是 import：本脚本由 node 直跑，import TS 要先编译。找不到任何一项就抛 ——
 * 那说明槽位表的结构变了、规则 2 与规则 3 已经失效，静默放过比不检查更糟。
 *
 * 自己配平括号而不是写一条正则：实参跨行、含数组与对象字面量，而「有没有第 4 个参数」正是规则 3
 * 要判的那件事 —— 正则数不准逗号，这条规则就等于没有。
 */
export async function slotDeclarations(repositoryRoot) {
  const source = await readFile(resolve(repositoryRoot, SLOTS_FILE), 'utf8')
  const declarations = []
  for (const match of source.matchAll(/\bslot\(/g)) {
    const open = match.index + match[0].length - 1
    // 逐段收集而不是数逗号：本仓的调用都带尾逗号，`commas + 1` 会把
    // `slot('k', a, [],)` 数成 4 个实参 —— 恰好是「registrar 被删掉」那一刻，规则 3 会静默放过。
    const segments = ['']
    let depth = 0
    let end = -1
    let quote = ''
    for (let cursor = open; cursor < source.length; cursor += 1) {
      const character = source[cursor]
      if (quote) {
        segments[segments.length - 1] += character
        if (character === '\\') cursor += 1
        else if (character === quote) quote = ''
        continue
      }
      // 行注释里的中文撇号会把引号状态带偏，跳掉整行最省事。
      if (character === '/' && source[cursor + 1] === '/') {
        cursor = source.indexOf('\n', cursor)
        if (cursor === -1) break
        continue
      }
      if (character === "'" || character === '"' || character === '`') quote = character
      else if ('([{'.includes(character)) depth += 1
      else if (')]}'.includes(character)) {
        depth -= 1
        if (depth === 0) { end = cursor; break }
      } else if (character === ',' && depth === 1) {
        segments.push('')
        continue
      }
      if (depth >= 1) segments[segments.length - 1] += character
    }
    if (end === -1) continue
    const args = segments.map((segment) => segment.replace(/^\(/, '').trim()).filter(Boolean)
    const parsed = /^'([^']*)'$/.exec(args[0] ?? '')
    const atom = /^[A-Za-z_$][\w$]*$/.exec(args[1] ?? '')
    if (!parsed || !atom) continue
    declarations.push({
      key: parsed[1],
      atom: atom[0],
      argumentCount: args.length,
      line: source.slice(0, open).split('\n').length,
    })
  }
  if (declarations.length === 0) {
    throw new Error('未能从 state/sessionSlots.ts 抽出槽位 —— 槽位表结构已变，请同步本脚本的抽取式')
  }
  return declarations
}

export async function slotAtomNames(repositoryRoot) {
  return new Set((await slotDeclarations(repositoryRoot)).map((item) => item.atom))
}
