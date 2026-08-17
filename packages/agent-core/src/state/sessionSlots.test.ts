import { describe, expect, it } from 'vitest'
import { atom, createStore, isSourceAtom } from '@einfach/core'
import { applyRecoverySnapshot, clearRecoveryProjection } from './recoveryProjection'
import { capture, seedDurableState } from './recoveryProjection.fixtures'
import {
  SESSION_SLOTS,
  SESSION_SLOT_KEYS,
  findNonSourceSessionSlots,
} from './sessionSlots'

describe('SESSION_SLOTS', () => {
  it('holds only source atoms, so a historical value can always be written back', () => {
    expect(findNonSourceSessionSlots()).toEqual([])
  })

  it('rejects the two atom kinds that cannot take a historical value', () => {
    // 这条不是重复上一条：上一条断言「今天的表是干净的」，这条断言「这道校验真的能分辨」。
    // 少了它，isSourceAtom 若哪天恒为 true，上一条会继续绿。
    expect(isSourceAtom(atom((get) => get(SESSION_SLOTS.items.atom)))).toBe(false)
    expect(isSourceAtom(atom(null, () => {}))).toBe(false)
    expect(isSourceAtom(SESSION_SLOTS.items.atom)).toBe(true)
  })

  it('exposes every key in a stable order', () => {
    expect(SESSION_SLOT_KEYS).toEqual([...SESSION_SLOT_KEYS].sort())
    expect(new Set(SESSION_SLOT_KEYS).size).toBe(SESSION_SLOT_KEYS.length)
    expect(SESSION_SLOT_KEYS).toEqual(Object.keys(SESSION_SLOTS).sort())
  })

  it("clears every slot back to its atom's own default", () => {
    const store = createStore()
    seedDurableState(store)
    // 参照 store 从未被写过，每个 atom 都停在自己声明的初始值上。
    const pristine = createStore()

    clearRecoveryProjection(store)

    // 逐槽位对比，而不是列举 11 个断言：新增槽位若忘了给 clear 一个正确的默认值，
    // 或者槽位的 cleared 与 atom 自己的初始值不一致（hydrate 复用 Core 时会分叉），这里必红。
    for (const key of SESSION_SLOT_KEYS) {
      const slotAtom = SESSION_SLOTS[key].atom
      expect(store.getter(slotAtom), `slot ${key} was not cleared to its default`)
        .toEqual(pristine.getter(slotAtom))
    }
  })

  it('populates every slot when a v1 snapshot is applied', () => {
    const source = createStore()
    seedDurableState(source)
    const snapshot = capture(source)
    const target = createStore()
    const pristine = createStore()

    applyRecoverySnapshot(target, snapshot)

    // 种子给每个槽位都写了非默认值，所以「应用后仍等于默认值」= 这个槽位没被投影覆盖。
    // 加了槽位却忘了接 apply 路径，这里必红。
    for (const key of SESSION_SLOT_KEYS) {
      const slotAtom = SESSION_SLOTS[key].atom
      expect(target.getter(slotAtom), `slot ${key} was not applied from the snapshot`)
        .not.toEqual(pristine.getter(slotAtom))
      // run 是唯一不逐字往返的槽位，见下一条用例。
      if (key === 'run') continue
      expect(target.getter(slotAtom), `slot ${key} did not round-trip through the snapshot`)
        .toEqual(source.getter(slotAtom))
    }
  })

  it('drops the process-local execution handle out of the run slot', () => {
    const source = createStore()
    seedDurableState(source)
    const target = createStore()

    applyRecoverySnapshot(target, capture(source))

    // pendingExecutionId 指向本进程里的一个在飞 execution，跨重启没有对应物；让它活下来
    // 会让恢复出来的 run 指向一个不存在的句柄。这是 run 槽位唯一不逐字往返的字段。
    const sourceRun = source.getter(SESSION_SLOTS.run.atom) as Record<string, unknown>
    const targetRun = target.getter(SESSION_SLOTS.run.atom) as Record<string, unknown>
    expect(sourceRun.pendingExecutionId).toBe('process-only-handle')
    expect(targetRun).not.toHaveProperty('pendingExecutionId')
    const { pendingExecutionId: _dropped, ...rest } = sourceRun
    expect(targetRun).toEqual(rest)
  })
})
