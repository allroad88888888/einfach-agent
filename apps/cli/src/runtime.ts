import { homedir } from 'node:os'
import { configureObservability } from '@web-agent/core/observability'
import {
  configureCommands,
  configureDefaultDelegation,
  configureDefaultProjectSkillsProvider,
  configureDefaultSkillsRegistry,
  configureHostInvoke,
  configurePersistence,
  defaultCore,
} from '@web-agent/core'
import { createNodeHostInvoke } from '@web-agent/host-node'
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

/**
 * 把 Node 侧的进程内命令桥交给 core。
 *
 * 【补的是什么缺口】本函数出现之前 CLI 一直没有桥：Node 里没有 `globalThis.isTauri`，H 线换
 * 判据之前 `isTauriHost()` 在这里恒为 false，core 那 13 个 runtime 模块一律早退——CLI 的文件 /
 * shell / git / rg 能力对模型从来不可见。这不是回归，是一直存在的缺口，这里才把它补上。
 *
 * 【为什么放在 registerStandardTools 之后、其余装配之前】
 *   · 它必须早于**任何工具可能执行**的时点，而 `assembleCliRuntime` 在最后那句
 *     `await assembleCliPlugins(...)` 之前全程同步，所以放进第一个装配块就先于所有异步续段：
 *     先于插件的 install()（插件可以往 registry 里装工具，也可以在 install 期间就调桥），
 *     更先于 bootstrap.ts 里随后的 newSession() / sendMessage()——那才是模型真正可能发起
 *     工具调用的时点。
 *   · 与 registerStandardTools 之间**没有依赖**：工具可见性由 modelTurnPrefix 每轮现算
 *     `hasHostBridge()`，不是注册时定死的。排在它后面是为了与 apps/web/src/main.tsx 的同一处
 *     装配块逐行对读（那边同样是 registerStandardTools → configureHostInvoke）。
 *
 * 【为什么不像桌面那样带宿主判断】桌面那处包在 `if (tauriHost)` 里，因为浏览器预览没有后端，
 * 登记等于骗 core 说有本机能力。CLI 上这件事无条件成立：它本来就跑在 Node 里，桥背后是真的
 * 系统调用。
 *
 * 【路由表当前只有 5 个域】workspace 的 read/write/patch/change/delete/pathOps 尚未落地（W 线），
 * 调它们会拿到 `NodeHostCommandError`（reason: 'unimplemented'，文案「Node 宿主尚未实现命令…」）。
 * 那与登记桥之前的「当前宿主未提供命令桥」是两回事：桥接上了，只是某些域还没填；后者从此不会
 * 再出现在 CLI 上。
 */
function configureCliHostBridge(homeDir: string): void {
  // 表在 create 时就定死（装配槽被闭包捕获），登记的却是 loader——core 的 hostBridge 收 loader
  // 是为了让登记同步生效，不留「已 configure 但 hasHostBridge() 还答 false」的窗口。
  // homeDir 传空串等同于不传（hostOptions 的语义）：那时桥自己回落 os.homedir()，若仍解析不出
  // 主目录就在第一次调用时明确失败，而不是把空串当路径根拼下去。
  const invoke = createNodeHostInvoke({ homeDir })
  configureHostInvoke(() => Promise.resolve(invoke))
}

/** Assembles the CLI shell around the unchanged default core instance. */
export async function assembleCliRuntime(options: AssembleCliRuntimeOptions): Promise<void> {
  registerStandardTools(defaultCore.tools)
  // CLI 自己就是那台机器，主目录在本进程内**只解析一次**：同一个值既注入命令桥（它据此答
  // `get_user_home_dir`、并解析 `~/.webAgent/config.json` 的位置），也直接当用户级 skills 的
  // 扫描根。两处各调一次 homedir() 不会报错，漂移时的症状是「skills 扫不到 / 配置读到另一个
  // 文件」——hostOptions.ts 的 homeDir 槽位正是为消掉这第二个权威而存在的。
  const homeDir = homedir().trim()
  configureCliHostBridge(homeDir)
  configureDefaultSkillsRegistry(builtInSkillsRegistry)
  const bridge = buildNodeProjectSkillsBridge()
  // 主目录直接从 node:os 取，不走 core 的 resolveUserSkillsRoot——但**理由已经不是**
  // 「那条是 Tauri 专用通路」了：H4d-2 之后它走的是宿主桥的 `get_user_home_dir`，任何登记过桥
  // 的宿主都成立，CLI 现在也登记了。现在的理由是方向：主目录这个事实由 CLI 产出、经 homeDir
  // 槽位注入给桥，反过来向桥要等于绕一圈问自己，还凭空多出一个会漂移的权威。
  const userSkillsRoot = homeDir || undefined
  configureDefaultProjectSkillsProvider(
    (workspaceRoot) => scanProjectSkills(workspaceRoot, bridge, { userSkillsRoot }),
  )
  defaultCore.planRuntime = createDefaultPlanRuntime
  configureDefaultDelegation(createDelegationAssembly)
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
