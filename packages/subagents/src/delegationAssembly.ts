import type { DelegationRuntimeFactory } from '@web-agent/core/subagents'
import { createDelegateAgentRuntime } from './runtime'
import { createSubagentScheduler } from './schedulerState'

/** Creates an independent product delegation capability for one Core instance. */
export const createDelegationAssembly: DelegationRuntimeFactory = () => {
  const scheduler = createSubagentScheduler()

  return {
    scheduler,
    async createRuntime(input) {
      return createDelegateAgentRuntime({ ...input, scheduler })
    },
  }
}
