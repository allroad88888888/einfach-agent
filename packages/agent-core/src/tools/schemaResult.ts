import type { LoadedTool } from './types'
// 名字的真身在 tools/mcp，core 不能反向依赖它，所以两边靠 dangerousTools.ts 那一个常量对齐
// （见那里的说明与 tools/mcp 侧的锁定测试）。这里复用它而不是再抄一遍字面量：
// dangerousTools.ts 只 import 同层的 shellCommandRisk.ts（那个文件零 import），这条
// tools/ → runtime/ 的边因此不成环（tools/registry.ts 已有同向边）。
import { MCP_CONNECT_TOOL_NAME } from '../runtime/dangerousTools'

// request_tool_schema 的消息历史只保留一次加载确认与使用指南。
// 完整 inputSchema 会随下一轮请求的顶层 tools 字段发送，不在 role=tool 消息中重复。
export function toolSchemaLoadedResult(tool: LoadedTool): {
  loaded: true
  toolName: string
  guide: string
} {
  return {
    loaded: true,
    toolName: tool.name,
    guide: tool.guide,
  }
}

// 「直接调用未加载工具」被当作一次加载请求时的结果判别码。
// 恢复期（loadedToolNamesFromHistory）靠它把这类结果与普通工具结果区分开，
// 因此它是写进消息历史的稳定协议字节，不能随意改名。
export const TOOL_SCHEMA_AUTOLOADED_CODE = 'tool_schema_autoloaded'

// 简介：模型跳过 request_tool_schema、直接指名道姓调用未加载工具时的结果。
// 详情：这次调用本身就表达了「我要用它」，运行时据此走同一条 lazy 通道把 schema 装进下一轮
//   tools，而不是回一条纯拒绝让模型白烧一轮再来问一次。
//   ★ 两条不变量仍然成立 ★：
//     · 【不执行】——猜出来的参数一律不落地，executed:false 与 hint 都把这点写死；
//     · 【inputSchema 不进消息历史】——与 toolSchemaLoadedResult 同样只回加载确认与 guide，
//       完整 schema 只经下一轮请求的顶层 tools 字段下发。
export function toolSchemaAutoloadedResult(tool: LoadedTool): {
  loaded: true
  toolName: string
  guide: string
  code: typeof TOOL_SCHEMA_AUTOLOADED_CODE
  executed: false
  hint: string
} {
  return {
    ...toolSchemaLoadedResult(tool),
    code: TOOL_SCHEMA_AUTOLOADED_CODE,
    executed: false,
    hint: `本次调用未执行：${tool.name} 的参数 schema 此前未加载，已按 lazy-tool 协议为你加载。`
      + '完整 schema 随下一轮请求的 tools 一起下发并此后长期保留；请按它重新发起调用，'
      + '不要沿用本次猜测的参数。'
      // 每次工具集变化都会让 provider 的前缀缓存整体失效（contextCache 记一次 profile_changed）。
      // 一次性把接下来要用的都加载完，比用一次加载一个便宜得多，长会话尤其明显。
      + '若接下来还要用其它尚未加载的工具，请在同一轮用 request_tool_schema 一并加载，'
      + '避免反复改变工具集。',
  }
}

// 「这个工具名本 run 的工具目录里根本没有，但它出自某个已配置服务【上次已知】的工具清单」
// 的判别码。它和 toolLoading.ts 的 tool_provider_disconnected 是相邻的一对，语气不同：
//   · tool_provider_disconnected —— 连过、掉了，本轮没救，别再试；
//   · tool_provider_not_connected —— 压根还没连上，连上就能用，先去连。
// trace 与恢复期都靠 code 区分，属于稳定协议字节，不要改名。
export const TOOL_PROVIDER_NOT_CONNECTED_CODE = 'tool_provider_not_connected'

/**
 * 宿主对「这个 core 完全不认识的工具名出自哪个未连接服务」的回答。
 *
 * 【为什么是注入】工具名与服务的对应关系来自 app 层落磁盘的工具名缓存
 *   （apps/web/src/mcp/toolNameCache.ts），而 core 不碰磁盘、也不能反向依赖 tools-* 或 app。
 *   切法与 mcpConnectTarget（见 runtime/dangerousTools.ts）完全一致：core 定策略
 *   （名字彻底不认识 → 问一次宿主 → 有主就回「先连接」），宿主给事实，装配期接线。
 *   core 因此既不需要认识 `mcp__` 前缀，也不需要知道缓存长什么样。
 *
 * 【宿主必须遵守的一条】服务已经连上时不要回答。清单是「上次已知」不是当前事实，连上之后
 *   一律以真实清单为准；此时仍找不到的工具就是真的没有了，再回一句「请先连接」只会把模型
 *   推进「连接 → 还是没有 → 再连接」的死循环。
 */
export interface UnconnectedToolProvider {
  /** 已配置服务的 ID，可直接用作 connect_mcp_server 的入参。 */
  readonly serverId: string
  /** 这份清单被探测到的时刻（epoch 毫秒）。非法值按「时间未知」呈现，绝不编造新鲜度。 */
  readonly cachedAt: number
}

/** toolName → 未连接的提供方；答不上来返回 undefined（core 回落到未知工具的原有路径）。 */
export type UnconnectedToolProviderProbe = (toolName: string) => UnconnectedToolProvider | undefined

/** 「上次已知」的时刻文本。时间戳不可用时如实说时间未知，不猜、也不悄悄省掉这层限定。 */
function lastKnownAtText(cachedAt: number): string {
  if (!Number.isFinite(cachedAt)) return '时间未知'
  try {
    return new Date(cachedAt).toISOString()
  } catch {
    // 超出 Date 可表示范围时 toISOString 会抛 RangeError；探针是宿主代码，不能让它拖垮回执。
    return '时间未知'
  }
}

// 简介：模型照着某个未连接服务的缓存清单点名调用（或点名请求 schema）时的结构化回执。
// 详情：这条路径上模型没做错什么——它看到的清单是我们给的，只是那份清单是「上次已知」，
//   而工具真身要等服务连上才存在。所以回执要同时说清三件事：现在为什么不行、下一步做什么
//   （nextCall 直接给出可执行的连接调用）、以及连上之后为什么不能照抄这次的名字与参数。
export function toolProviderNotConnectedResult(
  toolName: string,
  provider: UnconnectedToolProvider,
): {
  error: string
  code: typeof TOOL_PROVIDER_NOT_CONNECTED_CODE
  executed: false
  retryable: false
  serverId: string
  lastKnownAt: string
  hint: string
  nextCall: { name: string; arguments: { serverId: string } }
} {
  const lastKnownAt = lastKnownAtText(provider.cachedAt)
  return {
    error: `工具 ${toolName} 所属的 MCP 服务 ${provider.serverId} 尚未连接，现在还不能调用它`,
    code: TOOL_PROVIDER_NOT_CONNECTED_CODE,
    executed: false,
    retryable: false,
    serverId: provider.serverId,
    lastKnownAt,
    hint: `本次调用未执行。这个工具名来自 ${provider.serverId}【上次已知】的工具清单`
      + `（探测于 ${lastKnownAt}），不是当前事实。`
      + `请先调用 ${MCP_CONNECT_TOOL_NAME} 连接该服务；原样重试这次调用不会有任何变化。`
      + '连接成功后一律以服务返回的真实清单为准——工具可能已改名、下线或换了参数，'
      + '确认它仍在清单里，再按当时的 schema 重新发起调用，不要沿用本次猜测的参数。',
    nextCall: {
      name: MCP_CONNECT_TOOL_NAME,
      arguments: { serverId: provider.serverId },
    },
  }
}
