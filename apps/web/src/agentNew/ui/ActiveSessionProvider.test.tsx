import { describe, it, expect } from 'vitest'
import { act, screen } from '@testing-library/react'
import { useAtomValue } from '@einfach/react'
import { renderWithStore } from '../../test/renderWithStore'
import {
  rootStore,
  activeSessionIdAtom,
  defaultCore,
  itemsAtom,
  type ConversationItem,
} from '@web-agent/core'
import { ActiveSessionProvider } from './ActiveSessionProvider'

// RUI1 spike：验证「einfach <Provider> 嵌套 + key 切 store」这套地基是否工作。
// 关键断言：切根 rootStore 的 activeSessionIdAtom 后，右栏 Provider 换成新会话 store，
// 子组件（Probe，读 itemsAtom）读到的是「新会话 store 的值」——这就是整个 UI 层的地基。

// probe 子组件：读当前所在 Provider（会话 store）的 itemsAtom 长度。
function Probe() {
  const items = useAtomValue(itemsAtom)
  return <div data-testid="probe">{items.length}</div>
}

const oneItem: ConversationItem = {
  id: 'i',
  createdAt: 0,
  item: { role: 'user', content: 'x' },
}

describe('ActiveSessionProvider (RUI1)', () => {
  it('切 activeSessionId → key 切 store，子组件读到新会话 store 的值；无会话时空占位', () => {
    // 准备两个会话的独立 store，各写不同长度的 items。
    defaultCore.getSessionStore('a').store.setter(itemsAtom, [oneItem])
    defaultCore.getSessionStore('b').store.setter(itemsAtom, [oneItem, { ...oneItem, id: 'i2' }])
    rootStore.setter(activeSessionIdAtom, 'a')

    renderWithStore(
      <ActiveSessionProvider>
        <Probe />
      </ActiveSessionProvider>,
      { store: rootStore },
    )

    // 会话 a：itemsAtom 长度 1
    expect(screen.getByTestId('probe')).toHaveTextContent('1')

    // 切到会话 b → RUI1：key 切 store 生效，probe 读到 b 会话 store 的值（长度 2）
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
})
