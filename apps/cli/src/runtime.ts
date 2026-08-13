import { configureObservability } from '@web-agent/core/observability/trace'
import { configureCommands } from '@web-agent/core/runtime/commands'
import {
  configureDefaultDelegation,
  configureDefaultProjectSkillsProvider,
  configureDefaultSkillsRegistry,
  defaultCore,
} from '@web-agent/core/runtime/core/coreInstance'
import { configurePersistence } from '@web-agent/core/runtime/persistenceBridge'
import { createMemoryHistoryDriver } from '@web-agent/core/state/persistence/memoryHistoryDriver'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { createDelegationAssembly } from '@web-agent/subagents'
import { registerStandardTools } from '@web-agent/tools'
import { createDefaultPlanRuntime } from '@web-agent/tools-planning'
import { builtInSkillsRegistry } from '@web-agent/tools-skills'
import { scanProjectSkills } from '../../../tools/skills/src/projectSkillsLoader'
import type { ResolvedCredentials } from './credentials'
import { createCliPerformanceDiagnosticSink } from './performance-output'
import { buildNodeProjectSkillsBridge } from './workspace-files'

interface AssembleCliRuntimeOptions {
  credentials: ResolvedCredentials
  verbose: boolean
}

function configureTraceOutput(verbose: boolean): void {
  configureObservability({
    performanceDiagnosticSink: createCliPerformanceDiagnosticSink(verbose),
    ...(verbose
      ? {
          driver: {
            async writeSpan(span) {
              process.stderr.write(`[trace] ${span.name}\n`)
            },
            async writeEvent(event) {
              process.stderr.write(`[trace] ${event.name}\n`)
            },
          },
        }
      : {}),
  })
}

/** Assembles the CLI shell around the unchanged default core instance. */
export function assembleCliRuntime(options: AssembleCliRuntimeOptions): void {
  registerStandardTools(toolRegistry)
  configureDefaultSkillsRegistry(builtInSkillsRegistry)
  const bridge = buildNodeProjectSkillsBridge()
  configureDefaultProjectSkillsProvider((workspaceRoot) => scanProjectSkills(workspaceRoot, bridge))
  defaultCore.planRuntime = createDefaultPlanRuntime
  configureDefaultDelegation(createDelegationAssembly)
  configurePersistence({ history: createMemoryHistoryDriver() })
  configureTraceOutput(options.verbose)
  configureCommands({
    modelCredentials: options.credentials.modelCredentials,
    fetchImpl: globalThis.fetch,
  })
}
