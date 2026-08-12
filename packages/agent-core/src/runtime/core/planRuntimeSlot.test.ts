import { describe, expect, it } from 'vitest'
import { createDefaultPlanRuntime } from '../../planning/runtime'
import { createCore } from './createCore'
import { createCoreInstance, defaultCore } from './coreInstance'

describe('planRuntime 装配槽', () => {
  it('默认实例保留计划能力，显式 null 才禁用', () => {
    expect(defaultCore.planRuntime).toBe(createDefaultPlanRuntime)
    expect(createCoreInstance().planRuntime).toBe(createDefaultPlanRuntime)
    expect(createCoreInstance({ planRuntime: null }).planRuntime).toBeUndefined()
  })

  it('createCore 透传计划运行时工厂', () => {
    const core = createCore({ planRuntime: createDefaultPlanRuntime })

    expect(core.planRuntime).toBe(createDefaultPlanRuntime)
  })
})
