import { describe, it, expect } from 'vitest'
import { act, screen } from '@testing-library/react'
import { atom } from '@einfach/core'
import { useAtom } from '@einfach/react'
import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import { renderWithStore } from '../../test/renderWithStore'
import {
  rootStore,
  activeSessionIdAtom,
  defaultCore,
  itemsAtom,
  sessionsAtom,
  type ConversationItem,
} from '@einfach-agent/core'
import { ActiveSessionProvider } from './ActiveSessionProvider'
import { composerDraftAtom } from './composerDraftState'

// RUI1 spike：验证「界面一个 store + agent store 按会话切」这套地基是否工作。
// 关键断言三条：
//   · 切根 rootStore 的 activeSessionIdAtom 后，agent store 换成新会话的，子组件读到新值；
//   · 渲染态写在界面 store 里，**不会**落进 agent store —— 这是拆分的全部意义所在，
//     而它错了不报错（只是某个 atom 悄悄多存了一份），所以必须有一条测试钉住；
//   · 界面 store 不按会话分桶，所以「正在输入的东西」必须在切会话时被显式清掉。

// probe 子组件：读当前会话 agent store 的 itemsAtom 长度。
function Probe() {
  const items = useAgentAtomValue(itemsAtom)
  return <div data-testid="probe">{items.length}</div>
}

// 一个纯渲染态 atom：挂载即可写，用来验证它落在界面 store 而不是 agent store。
const viewProbeAtom = atom('未写入')

function ViewProbe() {
  const [value, setValue] = useAtom(viewProbeAtom)
  return (
    <button type="button" data-testid="view-probe" onClick={() => setValue('渲染态')}>
      {value}
    </button>
  )
}

const oneItem: ConversationItem = {
  id: 'i',
  createdAt: 0,
  item: { role: 'user', content: 'x' },
}

describe('ActiveSessionProvider (RUI1)', () => {
  it('把完整会话 ModelSettings 原样提供给子树', () => {
    rootStore.setter(sessionsAtom, {
      a: {
        id: 'a', title: 'A', createdAt: 1, updatedAt: 1,
        settings: {
          vendor: 'openai-compat', model: 'reasoner', thinking: true, temperature: 0.4,
          vendorSettings: { connectionId: 'profile-a', reasoning_effort: 'max', opaque: 'keep' },
        },
      },
    })
    rootStore.setter(activeSessionIdAtom, 'a')

    renderWithStore(
      <ActiveSessionProvider>{(session) => (
        <output data-testid="settings">{JSON.stringify(session.settings)}</output>
      )}</ActiveSessionProvider>,
    )

    expect(JSON.parse(screen.getByTestId('settings').textContent ?? '')).toEqual({
      vendor: 'openai-compat', model: 'reasoner', thinking: true, temperature: 0.4,
      vendorSettings: { connectionId: 'profile-a', reasoning_effort: 'max', opaque: 'keep' },
    })
  })

  it('切 activeSessionId → 换 agent store，子组件读到新会话的值；无会话时空占位', () => {
    // 准备两个会话的独立 store，各写不同长度的 items。
    defaultCore.getSessionStore('a').store.setter(itemsAtom, [oneItem])
    defaultCore.getSessionStore('b').store.setter(itemsAtom, [oneItem, { ...oneItem, id: 'i2' }])
    rootStore.setter(activeSessionIdAtom, 'a')

    renderWithStore(
      <ActiveSessionProvider>
        <Probe />
      </ActiveSessionProvider>,
    )

    // 会话 a：itemsAtom 长度 1
    expect(screen.getByTestId('probe')).toHaveTextContent('1')

    // 切到会话 b → key 切 store 生效，probe 读到 b 会话的值（长度 2）
    act(() => {
      rootStore.setter(activeSessionIdAtom, 'b')
    })
    expect(screen.getByTestId('probe')).toHaveTextContent('2')

    // 切到无会话（空串）→ 渲染 empty 占位，probe 不再存在
    act(() => {
      rootStore.setter(activeSessionIdAtom, '')
    })
    expect(screen.queryByTestId('probe')).toBeNull()
    expect(screen.getByText(/还没有会话/)).toBeInTheDocument()
  })

  it('渲染态写进界面 store，agent store 一个字都不多存', () => {
    rootStore.setter(activeSessionIdAtom, 'a')

    const { store } = renderWithStore(
      <ActiveSessionProvider>
        <ViewProbe />
      </ActiveSessionProvider>,
    )

    act(() => {
      screen.getByTestId('view-probe').click()
    })

    expect(store.getter(viewProbeAtom)).toBe('渲染态')
    // 拆分前这一行会是 '渲染态' —— 渲染层随手 useAtom 的东西物理上就落在会话 store 里。
    expect(defaultCore.getSessionStore('a').store.getter(viewProbeAtom)).toBe('未写入')
  })

  it('切会话清掉「正在输入的东西」—— 界面只有一个 store，不清就会串到下一个会话', () => {
    rootStore.setter(activeSessionIdAtom, 'a')
    const { store } = renderWithStore(
      <ActiveSessionProvider>
        <Probe />
      </ActiveSessionProvider>,
    )
    act(() => {
      store.setter(composerDraftAtom, '在会话 a 打了一半的字')
    })

    act(() => {
      rootStore.setter(activeSessionIdAtom, 'b')
    })

    expect(store.getter(composerDraftAtom)).toBe('')
  })
})
