import { disabledProjectSkillsByWorkspaceAtom, workspacesAtom } from '../state/rootStore'
import { filterProjectSkillsSnapshot } from '../skills/projectSkillPreferences'
import { resolveSessionWorkspaceRoot, sessionDisabledProjectSkills } from '../state/workspaceState'
import type { SessionMeta } from '../state/core.type'
import type { SystemItem } from '@einfach-agent/ai'
import { hostPlatform } from './hostPlatform'
import { hasHostBridge } from './hostBridge'
import {
  buildCustomInstructionsItem,
  buildEnvironmentItem,
  buildSystemItem,
  buildToolManifestText,
} from './modelTurn'
import type { CoreInstance } from './core/coreInstance'
import type { ToolCatalog } from '../tools/toolCatalog'

export interface StableModelPrefix {
  items: SystemItem[]
  content: string
  system: SystemItem
  environment: SystemItem
  /** L1 skills 清单（只有元数据；正文与资源仍必须经 skill_read）。 */
  skillManifest: SystemItem
  toolManifest: SystemItem
  customInstructions?: SystemItem
  workspaceRoot?: string
  /**
   * 本轮宿主能不能执行 runtime='server' 的工具（文件 / shell / Git / rg）。
   *
   * 【H4b：字段为什么按能力措辞】它是整棵工具可见性树的总闸，此前取自一次宿主品牌探测，
   * 于是「有没有本机能力」被写死成了「是不是跑在 Tauri webview 里」；判据换成 `hasHostBridge()`
   * 之后名字必须跟着换，否则下游读到一个按品牌命名的字段却拿到别的语义。
   */
  hostHasLocalCapabilities: boolean
}

/**
 * Builds the cacheable request prefix for one session.
 *
 * This is intentionally the only assembly point for stable system items: the
 * resulting order is part of the provider prefix-cache contract.
 *
 * `toolCatalog` defaults to the live registry; a run passes its own tool epoch so
 * the injected manifest and the discovery pages served later describe one set.
 */
export async function buildStableModelPrefix(
  sessionMeta: SessionMeta,
  core: CoreInstance,
  toolCatalog: ToolCatalog = core.tools,
): Promise<StableModelPrefix> {
  const workspaceRoot = resolveSessionWorkspaceRoot(
    sessionMeta,
    core.rootStore.getter(workspacesAtom),
  )
  // 【H4b】总闸的源头。曾经是一次宿主品牌探测（读一个全局量），等于把「宿主能不能执行
  // runtime='server' 的工具」判成「是不是跑在 Tauri webview 里」。现在问的是宿主装配层有没有登记
  // 命令桥（hostBridge.ts）：桥背后是 Tauri invoke、本地 Node 后端还是别的什么，core 不关心，
  // 也正是这一行决定了浏览器接上本地后端之后模型能不能看见本机工具。
  // 两个消费方必须共用同一个值，缺一不可：
  //   · buildToolManifestText / buildTurnTools —— server 工具进不进清单与 tools 数组；
  //   · buildEnvironmentItem —— 运行环境那段是否对模型宣告「本机文件、shell 与 Git 工具不可用」。
  // 分开判会让模型同时收到「清单里有 shell」和「shell 在本环境不可用」两句互相打架的话。
  const hostHasLocalCapabilities = hasHostBridge()
  const system = buildSystemItem()
  const toolManifest: SystemItem = {
    role: 'system',
    content: buildToolManifestText(hostHasLocalCapabilities, { registry: toolCatalog }),
  }
  const customInstructions = buildCustomInstructionsItem(core.config.customInstructions)
  // 清单要能被模型看见就得先扫完：ensure 命中缓存时同步返回，同 workspace 的并发 run 共用一次扫描。
  // 扫不出来（无 provider / 扫描器崩了）也不阻断 run——那时快照为空，清单只剩内置段。
  const scannedSkills = workspaceRoot ? await core.projectSkills.ensure(workspaceRoot) : undefined
  const skillManifest: SystemItem = {
    role: 'system',
    content: core.skillRegistry.buildManifestText(filterProjectSkillsSnapshot(
      scannedSkills,
      sessionDisabledProjectSkills(sessionMeta, core.rootStore.getter(disabledProjectSkillsByWorkspaceAtom)),
    )),
  }
  const environment = buildEnvironmentItem({
    workspaceRoot,
    // 【B3】入参名与文案已随本机 Node 后端落地改成按能力措辞（曾经按宿主品牌命名、文案写死
    // 「宿主：Tauri 桌面端」）：同一个 true 现在可能来自桌面原生层，也可能来自浏览器接上的
    // 本地 Node 后端，报品牌就等于对其中一种宿主撒谎。详见 modelTurnSystemItems.ts。
    hostHasLocalCapabilities,
    // 【S5】消费者②。这里读的是**宿主登记桥时声明的平台**，不是本地探测——浏览器（macOS）连
    // Node server（Linux）时，本地探测会让模型按 macos 组命令、桥按 linux 拒绝。消费者①是
    // shell 桥的 platform 入参（tools/shell 的 run_verification_command），两边读同一个
    // hostPlatform()，而那个声明值除它之外没有第二条读出通路。
    platform: hostPlatform(),
  })
  // 【C7】各段按「变更频率」排：固定 system → 工具摘要 → 自定义指令这三段与 workspace 无关、
  // 所有会话逐字相同；skill 清单与运行环境都按 workspace 变，故一起垫底。清单排在环境之前：
  // 没有项目 skills 的两个 workspace 连清单也逐字相同，divergence 推迟到最后一段。
  // 清单必须待在这里而不是历史尾部：稳定前缀的字节变化被 contextCache 归因为 profile_changed
  // （换 epoch、一次性全量 miss），落在 append-only 历史尾巴上的东西则每轮被新历史顶位、持续 miss。
  const items: SystemItem[] = [
    system,
    toolManifest,
    ...(customInstructions ? [customInstructions] : []),
    skillManifest,
    environment,
  ]

  return {
    items,
    content: items.map((item) => item.content).join('\n'),
    system,
    environment,
    skillManifest,
    toolManifest,
    customInstructions,
    workspaceRoot,
    hostHasLocalCapabilities,
  }
}
