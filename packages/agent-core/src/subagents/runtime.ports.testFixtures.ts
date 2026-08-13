// 把 core 内核测试的假端口装成一个可跑的委派运行时。
// ---------------------------------------------------------------------------
// 子 run 内核测试的标的是 core 自己的机制（子循环、预算与并发、档位路由、归档事件投影），
// 所以被测对象由 core 的 `createDelegationRuntime` + 本目录的假端口装出来，不再绕道
// `@web-agent/subagents` 的产品工厂——那会让 core 的内核测试反向依赖上层能力包。

import { DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL } from '@web-agent/ai'
import type {
  DelegationCapability,
  DelegationRuntime,
  DelegationRuntimeInput,
  SubagentScheduler,
} from '../runtime/delegationContract'
import type { ModelSettings } from '../state/core.type'
import { createDelegationRuntime } from './delegationRuntime'
import type { DelegationRuntimePorts } from './delegationRuntimePorts'
import { createTestArchive, testArchiveFormat } from './runtime.archive.testFixtures'
import { testSkillDistill } from './runtime.distill.testFixtures'
import { createTestScheduler } from './runtime.scheduler.testFixtures'
import type { SubagentTierRouting } from './tierRouting'

/** 测试档位表：与装配层默认表同构，让断言仍然读到真实的 Pro/Flash 模型名。 */
export const TEST_TIER_ROUTING: SubagentTierRouting = {
  vendor: 'deepseek',
  models: { pro: DEEPSEEK_PRO_MODEL, flash: DEEPSEEK_FLASH_MODEL },
}

/** 低价抽取的厂商设置：Kimi 的会话类型不携带 temperature/max_tokens，其余按 flash 档改写。 */
function testLowCostExtractionSettings(
  primary: ModelSettings,
  model: string,
  maxTokens: number,
): ModelSettings {
  if (primary.vendor === 'kimi') return { ...primary, model, thinking: false }
  return { ...primary, model, temperature: 0, thinking: false, max_tokens: maxTokens }
}

export interface TestDelegationRuntimeOptions extends DelegationRuntimeInput {
  /** 缺省时每个运行时自带独立调度器；需要共享树状态的测试传入同一个。 */
  scheduler?: SubagentScheduler
}

export function createTestDelegationRuntime(opts: TestDelegationRuntimeOptions): DelegationRuntime {
  const ports: DelegationRuntimePorts = {
    scheduler: opts.scheduler ?? createTestScheduler(),
    tierRouting: TEST_TIER_ROUTING,
    archive: createTestArchive({
      sessionId: opts.sessionId,
      runId: opts.runId,
      onTraceItem: opts.onTraceItem,
    }),
    archiveFormat: testArchiveFormat,
    skillDistill: testSkillDistill,
    lowCostExtractionSettings: testLowCostExtractionSettings,
  }
  return createDelegationRuntime(opts, ports)
}

/** `DelegationRuntimeFactory` 形状的测试委派能力：一颗调度器供本 Core 的所有子 run 共用。 */
export function createTestDelegationCapability(): DelegationCapability {
  const scheduler = createTestScheduler()
  return {
    scheduler,
    async createRuntime(input) {
      return createTestDelegationRuntime({ ...input, scheduler })
    },
  }
}
