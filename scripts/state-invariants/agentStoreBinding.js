// ---------------------------------------------------------------------------
// 规则 5 · core 的 atom 只能从 core 的 store 读
// ---------------------------------------------------------------------------
// 为什么：界面与 agent 分住不同 store（见 apps/web/src/uiStore.ts）。einfach 只有一个
//   `StoreContext`，而**环境 store 给的是界面**；core 的两个 store 各走自己的 Provider
//   （`packages/agent-react/src/coreStoreBindings.tsx`）。于是在 core 之外对一个 core 的 atom 用裸
//   `useAtomValue` / `useAtom` / `useSetAtom`，读到的是**界面 store 里那个 atom 的默认值**。
// 违反后：不抛异常。会话列表空着、消息列表空着、计划面板不显示、工具进度条永远不出现 ——
//   组件"正常"渲染了一份空状态。dev 里肉眼可见，但 CI 里没人看，而单测如果两层绑了同一个
//   store 就更看不出来（renderWithStore 的三个默认因此刻意是三个不同实例）。
//
// 判据：**名字来自哪里 + 落在什么位置**。从受治理的包（atomBindingTable.js 的
// GOVERNED_PACKAGES）import 进来的标识符，只要出现在裸 hook 的**第一个实参位置**，就是违规
// ——裸 hook 的第一个实参在类型上只能是 atom，所以「这名字来自 core / subagents」已经足够定罪。
// 不按模块路径认：应用层拿到的是 barrel，路径里没有 `state/…` 字样。
//
// 判据不枚举 atom 名，是因为枚举过的那一版漏掉了两种形状，而且都不是假想：
//   1. **atom 工厂调用** `useAtomValue(sessionUndoAvailabilityAtom(id))` —— 名字是函数不是 atom
//      声明，任何「抽 atom 声明」的枚举都抽不到它。撤销条因此在生产里从来没显示过（B1，9243a67）。
//   2. **另一个包的会话 atom** —— 旧判据只认 `@einfach-agent/core` 一个来源，于是
//      `@einfach-agent/subagents` 的整族视图 atom 全在治理之外：命令写会话 store、组件读界面
//      store，面板恒空（A3 已删掉那个组件，a16f0e8）。
// 现在枚举只用来把报错说准（该换哪个 hook）；**说不准也照样红**，退回泛化文案。
//
// 写入面不归本规则管，归规则 2（会话 atom 的写入必须走 command）。这里只挡读。

import { readFile } from 'node:fs/promises'
import {
  AGENT_STORE,
  ATOM_FACTORIES,
  EXEMPT_HOOK_ARGUMENTS,
  GOVERNED_PACKAGES,
  ROOT_STORE,
  UNKNOWN_STORE,
} from './atomBindingTable.js'
import { rootAtomDeclarations, sessionAtomDeclarations } from './sessionAtomSource.js'
import { relativePath } from './sourceFiles.js'

const BINDINGS_FILE = 'packages/agent-react/src/coreStoreBindings.tsx'
const TABLE_FILE = 'scripts/state-invariants/atomBindingTable.js'
// core 自己不用 React hook，扫它纯属浪费；而且它内部本来就直接持 store。
// 其余受治理的包**不豁免**：subagents 若哪天自己写个组件裸读，那和应用层裸读是同一个 bug。
const scopeExcludedPrefix = 'packages/agent-core/src/'
// 第三个捕获组是「实参后面紧跟一个左括号」，即 `useAtomValue(factory(id))` 这种工厂调用形态。
const hookArgumentPattern = /\b(useAtomValue|useAtom|useSetAtom)\s*\(\s*([A-Za-z_$][\w$]*)\s*(\()?/g
const importPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
const commentLinePattern = /^\s*(?:\/\/|\*|\/\*)/

/** 本文件从受治理的包 import 进来的标识符 → 它来自哪个包。 */
function governedImports(source) {
  const imported = new Map()
  for (const [, clause, specifier] of source.matchAll(importPattern)) {
    const owner = GOVERNED_PACKAGES.find(
      (pkg) => specifier === pkg.specifier || specifier.startsWith(`${pkg.specifier}/`),
    )
    if (!owner) continue
    for (const raw of clause.split(',')) {
      const name = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/).pop()?.trim()
      if (name) imported.set(name, owner)
    }
  }
  return imported
}

/**
 * 整行注释清空后再扫。
 *
 * 清空而不是删除：行数不变，match 的下标仍能换算回真实行号。顺带把判据从「逐行匹配」解放出来
 * —— 换行写的 `useAtomValue(\n  itemsAtom,\n)` 在逐行版里是个白送的逃逸口。
 */
function withoutCommentLines(source) {
  return source
    .split('\n')
    .map((line) => (commentLinePattern.test(line) ? '' : line))
    .join('\n')
}

/**
 * 名字 → 该读哪个 store。两张来源分开建，好让报错直接说清该换成哪个 hook ——
 * 说「用错 store 了」而不说用哪个，读到报错的人还得自己去翻。
 */
async function bindingByName(repositoryRoot) {
  const [sessionAtoms, rootAtoms] = await Promise.all([
    sessionAtomDeclarations(repositoryRoot),
    rootAtomDeclarations(repositoryRoot),
  ])
  const bindings = new Map()
  for (const item of sessionAtoms) bindings.set(item.name, AGENT_STORE)
  for (const item of rootAtoms) bindings.set(item.name, ROOT_STORE)
  for (const item of ATOM_FACTORIES) bindings.set(item.name, item.binding)
  return bindings
}

function violation({ scoped, line, hook, name, call, target }) {
  const subject = call ? `${name} 返回的 atom` : name
  const hint = target === UNKNOWN_STORE
    ? `（${name} 不在 ${TABLE_FILE} 的登记面里：多半是 atom 工厂或新开的 atom 模块。`
      + '定罪不依赖登记，登记只是让这句话能说准哪个 hook）'
    : ''
  return `${scoped}:${line} ${hook}(${name}${call ? '(…)' : ''}) —— ${subject}住${target.store}；`
    + '裸 hook 读的是环境 store（界面 store），只会拿到默认值且不报错。'
    + `读请改用 ${BINDINGS_FILE} 的 ${target.hook}，写请走 runtime/commands 的命令${hint}`
}

function reportBareHooks({ scoped, source, imported, bindings, exempt, errors, observations }) {
  const scannable = withoutCommentLines(source)
  for (const match of scannable.matchAll(hookArgumentPattern)) {
    const [, hook, name, call] = match
    const owner = imported.get(name)
    if (!owner) continue
    const line = scannable.slice(0, match.index).split('\n').length
    const waived = exempt.get(name)
    if (waived) {
      observations.push(`${scoped}:${line} 观察项：规则 5 豁免 ${hook}(${name}) —— 豁免原因：${waived.reason}`)
      continue
    }
    errors.push(violation({
      scoped,
      line,
      hook,
      name,
      call,
      target: bindings.get(name) ?? owner.binding ?? UNKNOWN_STORE,
    }))
  }
}

/** 登记过的工厂在源码里真的还存在吗——改名或删掉之后留在表里的条目是陈旧账。 */
function noteFactoryDeclarations(scoped, source, pending) {
  if (pending.size === 0) return
  if (!GOVERNED_PACKAGES.some((pkg) => scoped.startsWith(pkg.sourcePrefix))) return
  for (const name of [...pending.keys()]) {
    if (new RegExp(`\\b(?:function|const)\\s+${name}\\b`).test(source)) pending.delete(name)
  }
}

function reportTableDebt(pending, errors) {
  const searched = GOVERNED_PACKAGES.map((pkg) => pkg.sourcePrefix).join(' / ')
  for (const name of pending.keys()) {
    errors.push(
      `${TABLE_FILE} 的 ATOM_FACTORIES 里有 ${name}，但 ${searched} 里已无此声明`
      + ' —— 陈旧条目会让报错指向一个不存在的名字，请删掉它',
    )
  }
  for (const item of [...ATOM_FACTORIES, ...EXEMPT_HOOK_ARGUMENTS]) {
    if (!item.reason) errors.push(`${TABLE_FILE} 的条目 ${item.name} 没写理由 —— 指不出代码位置的理由等于没核实过`)
  }
}

async function checkCoreStoreBinding({ repositoryRoot, files, errors, observations = [] }) {
  const bindings = await bindingByName(repositoryRoot)
  const exempt = new Map(EXEMPT_HOOK_ARGUMENTS.map((item) => [item.name, item]))
  const pendingFactories = new Map(ATOM_FACTORIES.map((item) => [item.name, item]))

  for (const path of files) {
    const scoped = relativePath(repositoryRoot, path)
    const source = await readFile(path, 'utf8')
    noteFactoryDeclarations(scoped, source, pendingFactories)
    if (scoped.startsWith(scopeExcludedPrefix)) continue
    const imported = governedImports(source)
    if (imported.size === 0) continue
    reportBareHooks({ scoped, source, imported, bindings, exempt, errors, observations })
  }

  reportTableDebt(pendingFactories, errors)
}

export const agentStoreBindingRule = {
  summary: [
    `规则 5：core 之外读 ${GOVERNED_PACKAGES.map((pkg) => pkg.specifier).join(' / ')} 的 atom，`
    + '会话的走 useAgentAtomValue、跨会话的走 useRootAtomValue —— 裸 useAtomValue 落在界面 store 上，'
    + '拿到的是默认值：组件照常渲染一份空状态，不抛异常。',
    'atom 工厂调用（useAtomValue(factory(id))）与整包治理的会话 atom 同样定罪，登记表只决定文案精度。',
  ],
  run: checkCoreStoreBinding,
}
