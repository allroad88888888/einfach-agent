import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { atom, createStore } from '@einfach/core'
import { Provider, useAtomValue } from '@einfach/react'
import {
  AgentStoreProvider,
  RootStoreProvider,
  useAgentAtomValue,
  useAgentStore,
  useRootAtomValue,
} from './coreStoreBindings'

const probeAtom = atom('默认值')

function Probe() {
  return <span data-testid="probe">{useAgentAtomValue(probeAtom)}</span>
}

afterEach(cleanup)

describe('core store 绑定', () => {
  it('读的是 AgentStoreProvider 给的 store，不是 einfach 的环境 store', () => {
    const uiStore = createStore()
    const agentStore = createStore()
    uiStore.setter(probeAtom, 'UI store 的值')
    agentStore.setter(probeAtom, 'agent store 的值')

    render(
      <Provider store={uiStore}>
        <AgentStoreProvider store={agentStore}>
          <Probe />
        </AgentStoreProvider>
      </Provider>,
    )

    // 两层同时在场时读的是 agent store —— 这就是整个拆分成立的前提。
    expect(screen.getByTestId('probe')).toHaveTextContent('agent store 的值')
  })

  it('没有 AgentStoreProvider 直接抛，不静默回退到环境 store', () => {
    // 回退才是危险的：读点会安静地落到 UI store 上、拿到 atom 默认值，组件照常渲染一份空状态。
    // 这里断言的是「响亮地失败」本身，删掉 useAgentStore 里的 throw 该用例立刻红。
    const uiStore = createStore()
    uiStore.setter(probeAtom, 'UI store 的值')
    // React 会把渲染期异常再抛一次给 window，jsdom 于是把整条栈打到 stderr；
    // 这里的抛是**预期结果**，压掉噪音免得下一个人以为用例出了问题。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const swallow = (event: ErrorEvent) => event.preventDefault()
    window.addEventListener('error', swallow)

    expect(() => render(<Provider store={uiStore}><Probe /></Provider>))
      .toThrow(/AgentStoreProvider/)

    window.removeEventListener('error', swallow)
    consoleError.mockRestore()
  })

  it('三层同时在场时各读各的：界面 / root / agent 互不串', () => {
    const uiStore = createStore()
    const rootStore = createStore()
    const agentStore = createStore()
    uiStore.setter(probeAtom, '界面 store 的值')
    rootStore.setter(probeAtom, 'root store 的值')
    agentStore.setter(probeAtom, 'agent store 的值')

    function ThreeWayProbe() {
      return (
        <>
          <span data-testid="ui">{useAtomValue(probeAtom)}</span>
          <span data-testid="root">{useRootAtomValue(probeAtom)}</span>
          <span data-testid="agent">{useAgentAtomValue(probeAtom)}</span>
        </>
      )
    }

    render(
      <Provider store={uiStore}>
        <RootStoreProvider store={rootStore}>
          <AgentStoreProvider store={agentStore}>
            <ThreeWayProbe />
          </AgentStoreProvider>
        </RootStoreProvider>
      </Provider>,
    )

    expect(screen.getByTestId('ui')).toHaveTextContent('界面 store 的值')
    expect(screen.getByTestId('root')).toHaveTextContent('root store 的值')
    expect(screen.getByTestId('agent')).toHaveTextContent('agent store 的值')
  })

  it('useAgentStore 交出的就是绑进去的那个实例', () => {
    const agentStore = createStore()
    let seen: unknown

    function StoreProbe() {
      seen = useAgentStore()
      return null
    }
    render(<AgentStoreProvider store={agentStore}><StoreProbe /></AgentStoreProvider>)

    expect(seen).toBe(agentStore)
  })
})
