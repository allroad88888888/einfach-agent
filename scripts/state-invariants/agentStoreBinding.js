// ---------------------------------------------------------------------------
// 规则 5 · 会话 atom 只能从 agent store 读
// ---------------------------------------------------------------------------
// 为什么：会话状态与渲染态住两个 store（见 apps/web 的 ActiveSessionProvider）。einfach 只有一个
//   `StoreContext`，环境 store 给的是 **UI store**，agent store 走
//   `@web-agent/react-plugin` 的 `useAgentAtomValue`。于是在 core 之外对一个会话 atom 用裸
//   `useAtomValue` / `useAtom` / `useSetAtom`，读到的是 **UI store 里那个 atom 的默认值**。
// 违反后：不抛异常。消息列表空着、计划面板不显示、工具进度条永远不出现 —— 组件"正常"渲染了一份
//   空状态。dev 里肉眼可见，但 CI 里没人看，而单测如果两层绑了同一个 store 就更看不出来。
//
// 判据只认**名字来自哪里**：从 `@web-agent/core`（含任何 subpath）import 进来、且在规则 4 枚举的
// 会话 atom 全集里的标识符。不按模块路径认 —— 应用层拿到的是 barrel，路径里没有 `state/…` 字样。
//
// 写入面不归本规则管，归规则 2（会话 atom 的写入必须走 command）。这里只挡读。

import { readFile } from 'node:fs/promises'
import { sessionAtomDeclarations } from './sessionAtomSource.js'
import { relativePath } from './sourceFiles.js'

const RULE_FILE = 'packages/agent-react/src/agentStore.tsx'
// core 自己不用 React hook，扫它纯属浪费；而且它内部本来就直接持 store。
const scopeExcludedPrefix = 'packages/agent-core/src/'
const bareReadPattern = /\b(useAtomValue|useAtom|useSetAtom)\s*\(\s*([A-Za-z_$][\w$]*)/g
const importPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g

/** 本文件从 @web-agent/core 家族 import 进来的标识符。 */
function coreImportedNames(source) {
  const names = new Set()
  for (const [, clause, specifier] of source.matchAll(importPattern)) {
    if (!specifier.startsWith('@web-agent/core')) continue
    for (const raw of clause.split(',')) {
      const name = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

async function checkAgentStoreBinding({ repositoryRoot, files, errors }) {
  const sessionAtoms = new Set((await sessionAtomDeclarations(repositoryRoot)).map((item) => item.name))
  for (const path of files) {
    const scoped = relativePath(repositoryRoot, path)
    if (scoped.startsWith(scopeExcludedPrefix)) continue
    const source = await readFile(path, 'utf8')
    const imported = coreImportedNames(source)
    if (imported.size === 0) continue

    for (const [index, line] of source.split('\n').entries()) {
      if (/^\s*(?:\/\/|\*)/.test(line)) continue
      bareReadPattern.lastIndex = 0
      for (const [, hook, atom] of line.matchAll(bareReadPattern)) {
        if (!imported.has(atom) || !sessionAtoms.has(atom)) continue
        errors.push(
          `${scoped}:${index + 1} ${hook}(${atom}) —— ${atom} 是会话 atom，住 agent store；`
          + `裸 hook 读的是环境 store（UI store），只会拿到默认值且不报错。`
          + `读请改用 ${RULE_FILE} 的 useAgentAtomValue，写请走 runtime/commands 的命令`,
        )
      }
    }
  }
}

export const agentStoreBindingRule = {
  summary: [
    '规则 5：core 之外对会话 atom 一律经 useAgentAtomValue 读 —— 裸 useAtomValue 落在 UI store 上，',
    '拿到的是默认值：组件照常渲染一份空状态，不抛异常。',
  ],
  run: checkAgentStoreBinding,
}
