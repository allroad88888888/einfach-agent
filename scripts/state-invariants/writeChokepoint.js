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
// 作用域是**整个仓库**，不只是 core。早一版只扫 `packages/agent-core/src`，于是应用层可以直接写
// 入账槽位而门禁一无所知 —— 实测 `apps/web` 的 Composer 就在用 `useSetAtom(composerDraftAtom)`
// 绕过收口点。规则本身声称的是「会话 atom 的写入必须收口」，那它就不能只在 core 里生效。
//
// 【关于插件的写入面】`CoreCtx.store` 是裸 `Store`（`coreCtx.ts` 头部写着「裸给」），但它**只对
//   仓内插件开放**：带 `LoopHooks` 的 `AgentPlugin` / `PluginApi` 住在 `runtime/core/pluginApi.ts`，
//   既不在 core 公开面白名单九条里，也不被 `plugin.ts` / `index.ts` 导出。公开插件经
//   `@einfach-agent/core/plugin` 拿到的是受限投影：run 级的 `PluginRunApi`（commands / observeRun /
//   hook / onAfterToolCall）与 hook 级的 `PluginHookContext`（身份 / signal / isCurrent / state）。
//   `state` 是 F2b 放开的会话与跨会话状态读写面（负责人 2026-08-20「给，读写同理」）——它给的是
//   能力，不是句柄：写入实现物理落在 `state/pluginStateAccess.ts`，转调 `writeSlot` /
//   `appendItemLogged`，账照记。所以插件写入面**仍然是收口的**，唯一没收口的写法（拿裸 Store 自己
//   setter）从来没出过公开面。仓内那几个（如 finishReasonPlugin）在本门禁扫描范围内，见豁免表。

import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { sessionAtomDeclarations } from './sessionAtomSource.js'
import { slotAtomNames } from './slotSource.js'
import { relativePath } from './sourceFiles.js'

const writeScopeDirectory = '.'
const sessionAtomModulePattern = /(?:state\/session(?:Atoms|TransientAtoms)|state\/subagentContinuationAtoms|execution\/graph)/
// 三种写入形态。React 那两个是新加的：UI 不用 `store.setter`，它 `useSetAtom(atom)` 拿到 setter
// 再调，只认 `.setter(` 的判据对渲染层完全失明 —— 而渲染层恰恰是最该被这条规则管住的地方。
const writePatterns = [
  { label: '.setter(', pattern: (name) => new RegExp(`\\.setter\\s*\\(\\s*${name}\\b`) },
  { label: 'useSetAtom(', pattern: (name) => new RegExp(`\\buseSetAtom\\s*\\(\\s*${name}\\b`) },
  { label: 'useAtom(', pattern: (name) => new RegExp(`\\buseAtom\\s*\\(\\s*${name}\\b`) },
]
const anyWritePattern = /\.setter\s*\(|\buseSetAtom\s*\(|\buseAtom\s*\(/
// 会话 atom 的写入被允许出现的位置：core 的写入器层与命令层。仓库其它任何地方都不许直接写 ——
// 应用层要改会话状态只能走 commands。
const writeAllowedPrefixes = [
  'packages/agent-core/src/state/',
  'packages/agent-core/src/runtime/commands/',
]
// **所有者模块**：某个会话 atom 的写入天然属于它，搬进 state/ 反而倒置分层。
//
// 这张表**只能容纳不进账本的 atom**。它原先登记的两项都是槽位（`executionGraphAtom`、
// `subagentContinuationsAtom`），登记理由写的是「接事务日志时它们就是被 transaction 包住的那一层」——
// 而事实是接上之后它们仍在用裸 `store.setter`，于是那两个槽位从未入账：撤销一轮会把
// items/run/plan 退回去，执行图与子 Agent continuation 停在新值上，状态自相矛盾且只在 undo 时浮出来。
// 两处已改走 `writeSlot`。**新增登记前先问一句：这个 atom 在 SESSION_SLOTS 里吗？在，就不该进这张表。**
//
// 当前为空。最后一条是 `execution/runtime.ts`，理由是它写 `executionEventsAtom`——那是一条只写不读、
// 无上限增长的事件列表，已随死重清理删掉，于是这条豁免连带失效。豁免过期不会报错（它只是不再命中
// 任何东西），所以删原子的那一步必须回头看这张表，否则它会一直挂着、给下一个人「这个模块本来就能
// 直接写会话 atom」的错觉。
const writeOwnerModules = []
// **欠债**：不是写入器却就地写会话 atom，应当收口。命中降级为观察项，但不代表没问题。
// 当前为空 —— L1 第一片已把三处收口：`finishReasonPlugin` 与 `modelTurnRequester` 改走
// `state/sessionWriters` 的 store-scoped 写入器（`appendItemToStore` /
// `setContextCheckpointOnStore`）。留着这张表是因为下一处欠债需要一个有名字的去处，
// 而不是被顺手登记成「所有者模块」。
const writeExemptions = []

async function checkWriteChokepoint({ repositoryRoot, files, errors, observations }) {
  const scopeRoot = resolve(repositoryRoot, writeScopeDirectory)
  const slotAtoms = await slotAtomNames(repositoryRoot)
  // 按名字认的是**会话 atom 全集**，不是只有槽位。早一版只认槽位，于是应用层从 barrel 拿到
  // 非槽位的会话 atom（`withdrawnTurnNoticeAtom`、`contextStatsAtom`）直接 useSetAtom 就地写，
  // 门禁一无所知 —— 而规则本身声称的是「会话 atom 的写入必须收口」，不是「槽位的写入」。
  const sessionAtomNames = new Set((await sessionAtomDeclarations(repositoryRoot)).map((item) => item.name))
  for (const path of files) {
    const scoped = relative(scopeRoot, path).split(sep).join('/')
    if (scoped.startsWith('..')) continue
    if (writeAllowedPrefixes.some((prefix) => scoped.startsWith(prefix))) continue
    const source = await readFile(path, 'utf8')
    const lines = source.split('\n')

    // 本文件 import 进来的、属于会话状态的标识符 —— 只有写这些才算命中。两个来源：
    //   · 按**模块**认：core 内部从会话 atom 模块 import 的一切（含非槽位的会话 atom）。
    //   · 按**名字**认：规则 4 枚举的会话 atom 全集，不管从哪条路径 import 进来的。
    // 后者是为了看穿 barrel：core 之外的文件从 `@einfach-agent/core` 拿 atom，模块路径里根本没有
    // `state/sessionAtoms` 这种字样，只按模块认就等于对整个应用层失明。
    const sessionAtoms = new Set()
    for (const [, names, specifier] of source.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
    )) {
      // 相对说明符先解析成仓相对路径：`execution/runtime.ts` 里的 './graph' 就是
      // `packages/agent-core/src/execution/graph`，直接对字面量做匹配会漏掉整个同目录 import 家族。
      const resolved = specifier.startsWith('.')
        ? relative(scopeRoot, resolve(dirname(path), specifier)).split(sep).join('/')
        : specifier
      const byModule = sessionAtomModulePattern.test(resolved)
      for (const raw of names.split(',')) {
        const name = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/).pop()?.trim()
        if (!name) continue
        if (byModule || sessionAtomNames.has(name)) sessionAtoms.add(name)
      }
    }
    if (sessionAtoms.size === 0) continue

    // 记下命中的是哪个 atom、以哪种形态写的：所有者模块表只能豁免「不进账本」的 atom，
    // 而报错信息里带上形态（`useSetAtom(` 之类）能让人一眼看到该改哪一行。
    const hits = []
    for (const [index, line] of lines.entries()) {
      if (!anyWritePattern.test(line) || /^\s*(?:\/\/|\*)/.test(line)) continue
      for (const { label, pattern } of writePatterns) {
        const atom = [...sessionAtoms].find((name) => pattern(name).test(line))
        if (atom) {
          hits.push({ index, atom, label })
          break
        }
      }
    }
    if (hits.length === 0) continue

    const owner = writeOwnerModules.find((item) => item.path === scoped)
    const exemption = writeExemptions.find((item) => item.path === scoped)
    for (const { index, atom, label } of hits) {
      const location = `${relativePath(repositoryRoot, path)}:${index + 1}`
      if (owner && slotAtoms.has(atom)) {
        // 所有者模块表挡不住这一类：槽位不记账 = undo 把它留在新值上、其余槽位已回滚，
        // 状态自相矛盾且全程不报错。这条正是 executionGraphAtom / subagentContinuationsAtom
        // 真实发生过的漏账（两者当时都登记在所有者模块表里）。
        errors.push(
          `${location} ${label}${atom} 在 SESSION_SLOTS 里 —— 槽位写入必须经 state/ 的 writeSlot 记账，`
          + '不能靠所有者模块表豁免：不入事务日志的槽位会在 undo 后停在新值上，而其余槽位已回滚',
        )
      } else if (owner) {
        observations.push(`${location} 所有者模块（按设计，非欠债）：${owner.reason}`)
      } else if (exemption) {
        observations.push(`${location} 待收口（L1 欠债）：${exemption.reason}`)
      } else {
        errors.push(
          `${location} ${label}${atom} —— 会话 atom 的写入必须落在 ${writeAllowedPrefixes.join(' 或 ')}`
          + '，或在 state-invariants/writeChokepoint.js 的所有者模块表里登记；新增写入点请走 writer/command 层',
        )
      }
    }
  }
}

export const writeChokepointRule = {
  summary: [
    `规则 2：全仓对**会话 atom** 的写入只允许出现在 ${writeAllowedPrefixes.join(' / ')}，`,
    '或所有者模块表里登记过的模块。root store 的跨会话登记表与应用层 atom 不在管辖范围。',
  ],
  run: checkWriteChokepoint,
}
