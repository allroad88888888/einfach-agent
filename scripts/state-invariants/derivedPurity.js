// ---------------------------------------------------------------------------
// 规则 1 · derived 的 read fn 必须是纯函数
// ---------------------------------------------------------------------------
// 为什么：恢复 = 从快照重放；重放要能得出同样的结果。read fn 里读时钟或取随机数，
//   恢复后的派生值就和崩溃前不一样，而且不报错。
// 违反后：undo 之后重算的派生值和原来不一致，redo 也对不上。全程静默。
// 需要「当前时间」时，把它作为 primitive atom 写进去，由 command 层在写入时取值。

import { readFile } from 'node:fs/promises'
import { relativePath } from './sourceFiles.js'

const impureCallPattern = /\b(?:Date\.now|Math\.random|performance\.now|crypto\.randomUUID)\s*\(|\bnew\s+Date\s*\(/
// 导出给规则 4 复用：那条规则要判「登记成 derived 的到底是不是 derived」，用的必须是同一个
// 「什么算 derived」的判据 —— 两处各写一遍，其中一处迟早会在无人察觉时判空。
export const derivedOpenPattern = /\batom\s*\(\s*\(\s*get\b/

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

async function checkDerivedPurity({ repositoryRoot, files, errors }) {
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
          `${relativePath(repositoryRoot, path)}:${cursor + 1} derived 必须是纯函数（${match[0].trim()}）`
          + ' —— 需要当前时间/随机数时改成 primitive atom，由 command 层写入时取值',
        )
      }
    }
  }
}

export const derivedPurityRule = {
  summary: ['规则 1：derived 的 read fn 禁读时钟/随机数——否则重放得不到同样结果，且静默。'],
  run: checkDerivedPurity,
}
