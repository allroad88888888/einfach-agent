// tools/mcp/src/connect-mcp-server/connectSkill.ts —— 连接工具的 skill（manifest 摘要 + guide 正文）
// 的组装。措辞与上限在 lastKnownToolsText.ts，采集在 lastKnownTools.ts，本文件只负责【把这一刻的
// 状态拼成一份 skill】。
//
// 【为什么必须每次现算，不能注册时算一次】ToolRegistry.list() 每次都重读 tool.skill.description
//   （见 agent-core 的 toolCatalog.toolSummaryOf），所以 skill 做成 getter 就能让 manifest 始终
//   反映此刻的服务状态。若在 createMcpConnectTool 里算成常量：用户刚在设置里装好的服务，要等到
//   下一次 registerMcpTools 才会出现在描述里；而刚刚连上的服务会在描述里继续以「未连接」的身份
//   重复它的历史清单，诱导模型再连一次。
import type { ToolSkill } from '@web-agent/core/tools/types'
import guide from './connect-mcp-server.md?raw'
import {
  collectLastKnownDigest,
  type McpConfiguredServerState,
  type McpLastKnownToolsProbe,
} from './lastKnownTools'
import { buildLastKnownGuideSection, buildLastKnownManifestNote } from './lastKnownToolsText'

/** 组装 skill 只需要登记表这一项能力。 */
export interface McpConnectSkillSource {
  list(): readonly McpConfiguredServerState[]
}

const BASE_DESCRIPTION =
  '按需连接一个【已配置】的 MCP 服务；连上之后该服务的工具才会出现在工具清单里。只接受服务 ID，不接受 URL 或命令行。'

const TRIGGERS: readonly string[] = ['mcp', '连接 mcp', 'mcp 服务', 'connect mcp']

/**
 * 造这一刻的 skill。
 *
 * 探针未接线（probe 为 undefined）或宿主调用即抛时，两段清单都是空串，skill 退回 F1/F5 的原样——
 * 优雅降级的判据是「不编造」：宁可让模型少看到一段提示，也不能凭空断言某个服务有/没有某些工具。
 */
export function buildConnectSkill(
  servers: McpConnectSkillSource,
  lastKnownTools: McpLastKnownToolsProbe | undefined,
): ToolSkill {
  const digest = collectLastKnownDigest(lastKnownTools, () => servers.list())
  return {
    description: `${BASE_DESCRIPTION}${buildLastKnownManifestNote(digest)}`,
    triggers: [...TRIGGERS],
    content: `${guide}${buildLastKnownGuideSection(digest)}`,
  }
}
