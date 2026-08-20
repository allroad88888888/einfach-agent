// 规则 5 的自测 —— 用 fixture 把两种逃逸形状原样复刻回来，看门禁会不会红。
// ---------------------------------------------------------------------------
// 为什么直接驱动规则模块、而不是像 check-boundaries.test.js 那样跑 CLI：`check-state-invariants.js`
// 会把五条规则一起跑，而规则 1–4 读的是**写死路径的真实 core 源码**（sessionAtoms.ts、
// sessionSlots.ts…）。临时 root 里没有这些文件，脚本会先以 ENOENT 失败——那样测出来的红
// 与规则 5 无关。所以这里 repositoryRoot 传真实仓库（枚举面、登记表都是真的），
// 只把**被扫的文件**换成 fixture：真实文件一个都不动。
//
// 反向用例的取材是两个真实事故：
//   · UndoBar.tsx 曾是 `useAtomValue(sessionUndoAvailabilityAtom(id))`，撤销条从来没显示过（B1，9243a67）；
//   · SubagentSkillGovernancePanel.tsx 曾裸读 `@einfach-agent/subagents` 的会话 atom，面板恒空（A3 已删，a16f0e8）。
// 两处都已修好，所以 `pnpm check:state` 现在是绿的——绿证明不了判据真的扩到了这两种形状，
// 只有这些 fixture 能证明。
//
// 唯一没法用 fixture 覆盖的是「core 自己不进扫描面」：那条排除按**仓库相对路径前缀**判，而 fixture
// 住在临时目录里，相对真实仓库根算出来的路径永远是 `../…`，够不着 `packages/agent-core/src/`。
// 要覆盖它就得往真实 core 目录里丢文件，那与「不动真实文件」冲突，故留给真实门禁跑。

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it as test } from 'vitest'
import { agentStoreBindingRule } from './agentStoreBinding.js'

const repositoryRoot = process.cwd()
// 工厂登记表的陈旧条目检查要在受治理的包里见到 `function sessionUndoAvailabilityAtom` 才算数；
// 正常门禁下这个文件本来就在扫描面里，fixture 用例也得把它带上，否则每条用例都会多出一条陈旧账。
const FACTORY_SOURCE = 'packages/agent-core/src/runtime/commands/sessionScopeCommands.ts'

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'state-rule5-'))
  const paths = []
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
    paths.push(target)
  }
  return paths
}

async function runRule(paths, { withFactorySource = true } = {}) {
  const errors = []
  const observations = []
  const files = withFactorySource ? [...paths, resolve(repositoryRoot, FACTORY_SOURCE)] : paths
  await agentStoreBindingRule.run({ repositoryRoot, files, errors, observations })
  return { errors, observations }
}

test('atom 工厂调用：UndoBar 回退成裸 useAtomValue 时门禁必须红', async () => {
  const paths = await fixture({
    'apps/web/src/agentNew/ui/UndoBar.tsx': [
      "import { useAtomValue } from '@einfach/react'",
      "import { redoTurn, sessionUndoAvailabilityAtom, undoTurn } from '@einfach-agent/core'",
      'export function UndoBar({ sessionId }: { sessionId: string }) {',
      '  const availability = useAtomValue(sessionUndoAvailabilityAtom(sessionId))',
      '  return availability.canUndo ? <button onClick={() => undoTurn()}>撤销</button> : null',
      '}',
      '',
    ].join('\n'),
  })
  const { errors } = await runRule(paths)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/UndoBar\.tsx:4 useAtomValue\(sessionUndoAvailabilityAtom\(…\)\)/)
  expect(errors[0]).toMatch(/sessionUndoAvailabilityAtom 返回的 atom住core 的 per-session agent store/)
  expect(errors[0]).toMatch(/useAgentAtomValue/)
})

test('atom 工厂调用：改用 useAgentAtomValue 后不再报', async () => {
  const paths = await fixture({
    'apps/web/src/agentNew/ui/UndoBar.tsx': [
      "import { useAgentAtomValue } from '@einfach-agent/react-plugin'",
      "import { sessionUndoAvailabilityAtom } from '@einfach-agent/core'",
      'export function UndoBar({ sessionId }: { sessionId: string }) {',
      '  const availability = useAgentAtomValue(sessionUndoAvailabilityAtom(sessionId))',
      '  return availability.canUndo ? <button>撤销</button> : null',
      '}',
      '',
    ].join('\n'),
  })
  const { errors } = await runRule(paths)
  expect(errors).toEqual([])
})

test('subagents 包的会话 atom 裸读会红，并指向 agent store', async () => {
  const paths = await fixture({
    'apps/web/src/agentNew/ui/SubagentRunInline.tsx': [
      "import { useAtomValue } from '@einfach/react'",
      "import { subagentTreesAtom } from '@einfach-agent/subagents'",
      'export function SubagentRunInline() {',
      '  const trees = useAtomValue(subagentTreesAtom)',
      '  return <span>{trees.length}</span>',
      '}',
      '',
    ].join('\n'),
  })
  const { errors } = await runRule(paths)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/SubagentRunInline\.tsx:4 useAtomValue\(subagentTreesAtom\)/)
  expect(errors[0]).toMatch(/core 的 per-session agent store/)
  expect(errors[0]).toMatch(/useAgentAtomValue/)
})

test('subagents 包的会话 atom 走 useAgentAtomValue 就不报', async () => {
  const paths = await fixture({
    'apps/web/src/agentNew/ui/SubagentRunInline.tsx': [
      "import { useAgentAtomValue } from '@einfach-agent/react-plugin'",
      "import { subagentTreesAtom } from '@einfach-agent/subagents'",
      'export const SubagentRunInline = () => useAgentAtomValue(subagentTreesAtom).length',
      '',
    ].join('\n'),
  })
  const { errors } = await runRule(paths)
  expect(errors).toEqual([])
})

test('core 会话 atom 与跨会话 atom 各自指向不同的 hook', async () => {
  const paths = await fixture({
    'apps/web/src/agentNew/ui/Panel.tsx': [
      "import { useAtomValue, useSetAtom } from '@einfach/react'",
      "import { itemsAtom, workspacesAtom } from '@einfach-agent/core'",
      'export function Panel() {',
      '  const items = useAtomValue(itemsAtom)',
      '  const workspaces = useAtomValue(workspacesAtom)',
      '  const setItems = useSetAtom(itemsAtom)',
      '  return <span>{items.length + Object.keys(workspaces).length + Number(!setItems)}</span>',
      '}',
      '',
    ].join('\n'),
  })
  const { errors } = await runRule(paths)
  expect(errors).toHaveLength(3)
  expect(errors[0]).toMatch(/useAtomValue\(itemsAtom\).+useAgentAtomValue/)
  expect(errors[1]).toMatch(/useAtomValue\(workspacesAtom\).+core 的 root store.+useRootAtomValue/)
  expect(errors[2]).toMatch(/useSetAtom\(itemsAtom\)/)
})

test('没登记过的 core 导出照样定罪，只是文案退回泛化版', async () => {
  // 登记表只决定「该换哪个 hook」说不说得准；判据不依赖它，否则下一个新工厂又是一次静默漏判。
  const paths = await fixture({
    'apps/web/src/agentNew/ui/Future.tsx': [
      "import { useAtomValue } from '@einfach/react'",
      "import { sessionSomethingNewAtom } from '@einfach-agent/core'",
      'export const Future = ({ id }: { id: string }) => useAtomValue(sessionSomethingNewAtom(id))',
      '',
    ].join('\n'),
  })
  const { errors } = await runRule(paths)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/core 的某一个 store（不是环境 store）/)
  expect(errors[0]).toMatch(/不在 scripts\/state-invariants\/atomBindingTable\.js 的登记面里/)
})

test('换行写的裸 hook 同样被判', async () => {
  const paths = await fixture({
    'apps/web/src/agentNew/ui/Wrapped.tsx': [
      "import { useAtomValue } from '@einfach/react'",
      "import { itemsAtom } from '@einfach-agent/core'",
      'export const Wrapped = () => useAtomValue(',
      '  itemsAtom,',
      ')',
      '',
    ].join('\n'),
  })
  const { errors } = await runRule(paths)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/Wrapped\.tsx:3 useAtomValue\(itemsAtom\)/)
})

test('应用层自己的 atom family 与整行注释不误报', async () => {
  const paths = await fixture({
    'apps/web/src/agentNew/ui/ModelCredentialPanel.tsx': [
      "import { useAtomValue } from '@einfach/react'",
      "import { sendMessage } from '@einfach-agent/core'",
      "import { modelCredentialAtoms } from '../../modelCredentialAtoms'",
      '// const stale = useAtomValue(itemsAtom)',
      'export function ModelCredentialPanel() {',
      "  const kimi = useAtomValue(modelCredentialAtoms('kimi-cn').status)",
      '  return <button onClick={() => sendMessage(kimi)}>发送</button>',
      '}',
      '',
    ].join('\n'),
  })
  const { errors } = await runRule(paths)
  expect(errors).toEqual([])
})

test('登记表里的工厂在源码里消失时报陈旧条目', async () => {
  // 扫描面里没有那个 sessionScopeCommands.ts，等价于「工厂被删/改名后表没跟着改」。
  const paths = await fixture({
    'apps/web/src/agentNew/ui/Empty.tsx': 'export const Empty = () => null\n',
  })
  const { errors } = await runRule(paths, { withFactorySource: false })
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/ATOM_FACTORIES 里有 sessionUndoAvailabilityAtom，但 .+ 里已无此声明/)
})
