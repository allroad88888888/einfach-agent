// 规则 5 的枚举面登记表 —— 判定住 agentStoreBinding.js，账在这里。
// ---------------------------------------------------------------------------
// 与 atomDispositionTable.js 同一个分法：**判定与账分开**。加一个受治理的包、加一个 atom 工厂
// 的人只需要读这张表，不必读判据；反过来改判据的人也不用在一堆条目里找那几行逻辑。
//
// 表里三类东西：
//   · GOVERNED_PACKAGES —— 哪些包的导出名一旦落进裸 hook 就算违规。判据**不枚举 atom 名**：
//     裸 hook 的第一个实参在类型上只能是 atom，所以「这个名字是从受治理的包导入的」已经足够定罪。
//     枚举只用来把报错说准（该换成哪个 hook），说不准时退回泛化文案——**说不准也照样红**。
//     这是刻意的：B2 之前判据按「名字必须在 core 的 atom 枚举面里」定罪，于是
//     `useAtomValue(sessionUndoAvailabilityAtom(id))` 因为名字是**函数**而整条漏过，
//     撤销条在生产里从来没显示过（B1 修，提交 9243a67）。
//   · ATOM_FACTORIES —— 返回 atom 的函数。它们不是 atom 声明，抽不出来，只能登记；
//     **登记只影响文案精度**，漏登记的工厂仍然会被判死。陈旧条目是 error。
//   · EXEMPT_HOOK_ARGUMENTS —— 豁免表，当前为空。留着是因为「判据表达不了合法例外」会逼人
//     去改判定逻辑，那比多一张空表糟得多。

/** 会话 store：per-session agent store，读用 useAgentAtomValue。 */
export const AGENT_STORE = { hook: 'useAgentAtomValue', store: 'core 的 per-session agent store' }
/** 跨会话 store：core 的 root store，读用 useRootAtomValue。 */
export const ROOT_STORE = { hook: 'useRootAtomValue', store: 'core 的 root store' }
/** 说不准是哪一个时的退路：照样定罪，只是把两个 hook 都摆出来让人自己选。 */
export const UNKNOWN_STORE = {
  hook: 'useAgentAtomValue（会话）/ useRootAtomValue（跨会话）',
  store: 'core 的某一个 store（不是环境 store）',
}

/**
 * 受治理的包：从这些包 import 进来的名字，出现在裸 hook 的第一个实参位置即违规。
 *
 * `binding` 是**整包默认归属**：能对整包一口咬定时写它，报错就能直接说该换哪个 hook；
 * 咬不定的写 undefined，逐名去查（core 是这种：会话 atom 归 agent store、跨会话 atom 归 root store）。
 * `sourcePrefix` 供 ATOM_FACTORIES 的陈旧条目检查用——工厂声明只可能在这些目录里。
 */
export const GOVERNED_PACKAGES = [
  {
    specifier: '@einfach-agent/core',
    sourcePrefix: 'packages/agent-core/src/',
    binding: undefined,
    reason: 'core 的 atom 分住两个 store，逐名判：会话 atom → agent store，跨会话登记表 → root store',
  },
  {
    specifier: '@einfach-agent/subagents',
    sourcePrefix: 'packages/subagents/src/',
    binding: AGENT_STORE,
    // 整族一口咬定的依据：这些 atom 的**唯一写入面**是 runtime/commands/subagentViewCommands.ts，
    // 它每条命令都先取 activeSessionStore(core)（= getSessionStore(activeSessionId).store）再写。
    // 读的一侧必须落在同一个 store 上，否则命令写会话 store、组件读界面 store，永远读到默认值
    // ——SubagentSkillGovernancePanel.tsx 就是这么空了一整个面板的（该组件已随 A3 删除，a16f0e8）。
    reason: '视图 atom 整族住 agent store：subagentViewCommands.ts 的 activeSessionStore(core) 是唯一写入面',
  },
]

/**
 * atom 工厂：签名是 `(…) => Atom<…>` 的函数，`useAtomValue(factory(id))` 里出现的就是它的名字。
 *
 * 为什么要登记：这类名字在源码里是 `function foo(): Atom<…>`，不是 `const foo = atom(…)`，
 * 任何「抽 atom 声明」的枚举都抽不到它。但**登记与否不影响定罪**，只影响报错能不能说准 hook；
 * 没登记的工厂会拿到 UNKNOWN_STORE 的泛化文案，照样是 error。
 *
 * 每项的 reason 要指得出代码位置——指不出来的理由等于没核实过。
 */
export const ATOM_FACTORIES = [
  {
    name: 'sessionUndoAvailabilityAtom',
    binding: AGENT_STORE,
    reason:
      'runtime/commands/sessionScopeCommands.ts 返回 getSessionStore(id).history.undoAvailabilityAtom，'
      + '那是会话 store 里的派生 atom',
  },
]

/**
 * 豁免：从受治理的包导入、但用裸 hook 读是对的那些名字。**当前为空**。
 *
 * 唯一可能的正当形态是「core 交出一个供界面 store 使用的 atom 工厂」（返回的 atom 本来就该住
 * 环境 store）。真出现时按 `{ name, reason }` 登记，理由要指得出代码位置；空表也要留着，
 * 否则下一个人只能去改判定逻辑来放行一个合法例外。
 */
export const EXEMPT_HOOK_ARGUMENTS = []
