import { describe, expect, it } from 'vitest'
import type { PlanRuntimeFactory } from '../../planning/runtime'
import { createCore } from './createCore'
import { createCoreInstance, defaultCore } from './coreInstance'

describe('planRuntime 装配槽', () => {
  it('默认实例不内置计划能力，装配层可显式注入', () => {
    expect(defaultCore.planRuntime).toBeUndefined()
    expect(createCoreInstance().planRuntime).toBeUndefined()
    expect(createCoreInstance({ planRuntime: null }).planRuntime).toBeUndefined()
  })

  it('createCore 透传计划运行时工厂', () => {
    const planRuntime = (() => ({})) as unknown as PlanRuntimeFactory
    const core = createCore({ planRuntime })

    expect(core.planRuntime).toBe(planRuntime)
  })
})
