import { beforeEach, describe, expect, it } from 'vitest'

import { itemsAtom } from '../../state/sessionAtoms'
import { createCoreInstance, type CoreInstance } from '../core/coreInstance'
import { createSessionScopeCommands } from './sessionScopeCommands'

let core: CoreInstance
let commands: ReturnType<typeof createSessionScopeCommands>

beforeEach(() => {
  core = createCoreInstance()
  commands = createSessionScopeCommands(core)
})

describe('sessionScopeCommands', () => {
  it('同一会话拿到同一个 store 实例，不同会话彼此隔离', () => {
    const a = commands.sessionAtomScope('a')
    const b = commands.sessionAtomScope('b')

    expect(commands.sessionAtomScope('a')).toBe(a)
    expect(b).not.toBe(a)

    a.setter(itemsAtom, [{ id: 'i', createdAt: 0, item: { role: 'user', content: 'x' } }])
    expect(a.getter(itemsAtom)).toHaveLength(1)
    expect(b.getter(itemsAtom)).toHaveLength(0)
  })

  it('绑定的是本 core 的会话 store，与 defaultCore 不串', () => {
    expect(commands.sessionAtomScope('a')).toBe(core.getSessionStore('a').store)
  })

  it('会话 store 被丢弃后重取，拿到的是新实例（不缓存失效实例）', () => {
    const before = commands.sessionAtomScope('a')
    core.dropSessionStore('a')

    expect(commands.sessionAtomScope('a')).not.toBe(before)
  })
})
