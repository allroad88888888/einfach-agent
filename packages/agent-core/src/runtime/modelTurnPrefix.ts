import { workspacesAtom } from '../state/rootStore'
import { resolveSessionWorkspaceRoot } from '../state/workspaceState'
import type { SessionMeta } from '../state/core.type'
import type { SystemItem } from '@web-agent/ai'
import { detectHostPlatform } from './hostPlatform'
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
  toolManifest: SystemItem
  customInstructions?: SystemItem
  workspaceRoot?: string
  /**
   * 本轮宿主能不能执行 runtime='server' 的工具（文件 / shell / Git / rg）。
   *
   * 【H4b：字段为什么不再叫 isTauri】它是整棵工具可见性树的总闸，此前取自 `isTauriHost()`，
   * 于是「有没有本机能力」被写死成了「是不是跑在 Tauri webview 里」；判据换成 `hasHostBridge()`
   * 之后名字必须跟着换，否则下游读到一个叫 isTauri 的字段却拿到别的语义。
   *
   * 下游 `ToolLoopBase.runtimeIsTauri` 与 `SubagentRuntimeOpts.runtimeIsTauri` 仍是旧名字，
   * 值就是本字段（`toolLoopBootstrap.ts` 两处赋值）。那一层的改名波及十余个文件与其测试，留给
   * 后续单独一卡；在此之前请按本字段的语义理解那两个名字。
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
  // 【H4b】总闸的源头。曾经是 `isTauriHost()`——读 globalThis.isTauri，等于把「宿主能不能执行
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
  const environment = buildEnvironmentItem({
    workspaceRoot,
    // buildEnvironmentItem 的入参名与其文案（「宿主：Tauri 桌面端」）仍写死 Tauri：在只有
    // Tauri 一种 server 宿主的今天它逐字成立，等 B 线的本地 Node 后端落地，那段文案要改成按
    // 能力而非按宿主品牌措辞。改的是 modelTurnSystemItems.ts，不在本卡改动面。
    isTauri: hostHasLocalCapabilities,
    platform: detectHostPlatform(),
  })
  const items: SystemItem[] = [
    system,
    toolManifest,
    ...(customInstructions ? [customInstructions] : []),
    environment,
  ]

  return {
    items,
    content: items.map((item) => item.content).join('\n'),
    system,
    environment,
    toolManifest,
    customInstructions,
    workspaceRoot,
    hostHasLocalCapabilities,
  }
}
