import { describe, expect, it } from 'vitest'
import type { LoadedTool } from '../tools/types'
import { nextPlanPinnedTools, selectToolsWithinLimit } from './planToolPins'

function loaded(name: string): LoadedTool {
  return { name, description: name, guide: name, runtime: 'internal', inputSchema: { type: 'object' } } as LoadedTool
}

describe('selectToolsWithinLimit', () => {
  it('无 pin 时与旧行为一致:保留尾部 limit 个(LRU)', () => {
    const tools = ['a', 'b', 'c', 'd'].map(loaded)
    expect(selectToolsWithinLimit(tools, 2).map((tool) => tool.name)).toEqual(['c', 'd'])
    expect(selectToolsWithinLimit(tools, undefined)).toBe(tools)
    expect(selectToolsWithinLimit(tools, 0)).toEqual([])
  })

  it('pinned 优先于 LRU:老 pin 不被新工具挤掉,顺序保持原列表相对顺序', () => {
    const tools = ['pinned-old', 'b', 'c', 'd'].map(loaded)
    const kept = selectToolsWithinLimit(tools, 3, ['pinned-old'])
    expect(kept.map((tool) => tool.name)).toEqual(['pinned-old', 'c', 'd'])
  })

  it('pin 集合自身超限:按可见 LRU 保留最近的 limit 个 pin,淘汰最旧 pin', () => {
    const tools = ['p1', 'p2', 'p3'].map(loaded)
    const kept = selectToolsWithinLimit(tools, 2, ['p1', 'p2', 'p3'])
    expect(kept.map((tool) => tool.name)).toEqual(['p2', 'p3'])
  })

  it('回归(活锁):pin 满额时刚 ensure 的新工具必须进来,最旧 pin 让位', () => {
    // 计划期 pins 会长成 visible 全集;若满额分支只留 pin,新工具收到「schema 已加载」
    // 却永远不在下一轮 tools 里 → 加载→不可见→再加载 死循环。
    const tools = ['p1', 'p2', 'p3', 'newcomer'].map(loaded)
    const kept = selectToolsWithinLimit(tools, 3, ['p1', 'p2', 'p3'])
    expect(kept.map((tool) => tool.name)).toEqual(['p2', 'p3', 'newcomer'])
    // 被挤出的 p1 仍在 pins 里且未注销 → 下一轮 nextPlanPinnedTools 作为 evicted 上报。
    const next = nextPlanPinnedTools({
      planActive: true,
      pinned: ['p1', 'p2', 'p3'],
      visibleNames: kept.map((tool) => tool.name),
      isRegistered: () => true,
    })
    expect(next.evicted).toEqual(['p1'])
    expect(next.pinned).toEqual(['p2', 'p3', 'newcomer'])
  })
})

describe('nextPlanPinnedTools', () => {
  it('计划不在执行态 → pin 全清(覆盖完成/取消/revert)', () => {
    expect(nextPlanPinnedTools({
      planActive: false,
      pinned: ['a', 'b'],
      visibleNames: ['a', 'b'],
      isRegistered: () => true,
    })).toEqual({ pinned: [], evicted: [] })
  })

  it('执行态 → pin 并集当前可见工具,后续轮持续累积', () => {
    const first = nextPlanPinnedTools({
      planActive: true,
      pinned: [],
      visibleNames: ['a', 'b'],
      isRegistered: () => true,
    })
    expect(first.pinned).toEqual(['a', 'b'])
    const second = nextPlanPinnedTools({
      planActive: true,
      pinned: first.pinned,
      visibleNames: ['a', 'b', 'c'],
      isRegistered: () => true,
    })
    expect(second.pinned).toEqual(['a', 'b', 'c'])
    expect(second.evicted).toEqual([])
  })

  it('pin 消失时区分「被淘汰(仍注册,上报)」与「已注销(静默剪除)」', () => {
    const result = nextPlanPinnedTools({
      planActive: true,
      pinned: ['evicted-tool', 'unregistered-tool', 'kept'],
      visibleNames: ['kept'],
      isRegistered: (name) => name !== 'unregistered-tool',
    })
    expect(result.evicted).toEqual(['evicted-tool'])
    expect(result.pinned).toEqual(['kept'])
  })
})
