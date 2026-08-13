import { configureObservability } from '@web-agent/core/observability'
import { configureCommands } from '@web-agent/core/runtime/commands'
import {
  configureDefaultDelegation,
  configureDefaultProjectSkillsProvider,
  configureDefaultSkillsRegistry,
  defaultCore,
} from '@web-agent/core/runtime/core/coreInstance'
import { configurePersistence } from '@web-agent/core/runtime/persistenceBridge'
import { createMemoryHistoryDriver } from '@web-agent/core/state/persistence'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { createDelegationAssembly } from '@web-agent/subagents'
import { registerStandardTools } from '@web-agent/tools'
import { createDefaultPlanRuntime } from '@web-agent/tools-planning'
import { builtInSkillsRegistry } from '@web-agent/tools-skills'
import {
  OPENAI_COMPAT_VENDOR_ID,
  createOpenAiCompatAdapter,
  defaultProviderRegistry,
} from '@web-agent/ai'
import { scanProjectSkills } from '../../../tools/skills/src/projectSkillsLoader'
import type { ResolvedCredentials } from './credentials'
import { createCliPerformanceDiagnosticSink } from './performance-output'
import { assembleCliPlugins } from './plugins'
import { buildNodeProjectSkillsBridge } from './workspace-files'

interface AssembleCliRuntimeOptions {
  credentials: ResolvedCredentials
  verbose: boolean
  workspaceRoot: string
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

// openai-compat 没有厂商官方接入点，CLI 把从环境变量/配置文件解析出的 baseUrl 直接烘焙进
// 一个新的 adapter 实例，覆盖 registerBuiltinProviders 装的零配置默认值（registry「重复注册
// 以最后一次为准」）。这条通路完全在 agent-ai + CLI 装配层内闭环：core 的 `modelCredentials`
// 只搬运 API Key，从不知道 baseUrl 这回事，因此不需要改 packages/agent-core 一行代码。
function configureOpenAiCompatBaseUrl(credentials: ResolvedCredentials): void {
  const baseUrl = credentials.modelBaseUrls[OPENAI_COMPAT_VENDOR_ID]
  if (!baseUrl) return
  defaultProviderRegistry.register(OPENAI_COMPAT_VENDOR_ID, createOpenAiCompatAdapter({ baseUrl }))
}

/** Assembles the CLI shell around the unchanged default core instance. */
export async function assembleCliRuntime(options: AssembleCliRuntimeOptions): Promise<void> {
  registerStandardTools(toolRegistry)
  configureDefaultSkillsRegistry(builtInSkillsRegistry)
  const bridge = buildNodeProjectSkillsBridge()
  configureDefaultProjectSkillsProvider((workspaceRoot) => scanProjectSkills(workspaceRoot, bridge))
  defaultCore.planRuntime = createDefaultPlanRuntime
  configureDefaultDelegation(createDelegationAssembly)
  configurePersistence({ history: createMemoryHistoryDriver() })
  configureTraceOutput(options.verbose)
  configureOpenAiCompatBaseUrl(options.credentials)
  configureCommands({
    modelCredentials: options.credentials.modelCredentials,
    fetchImpl: globalThis.fetch,
  })
  // 标准工具与命令先装好，插件的 install 才有一个稳定的 registry 可注册；扫描/加载失败
  // 不阻塞启动（assembleCliPlugins 自身兜底），因此放在装配的最后一步即可。
  await assembleCliPlugins(options.workspaceRoot, options.verbose)
}
