// tools/mcp/src/connect-mcp-server/connectInputSchema.ts —— serverId 的【可取值面】：什么形状的
// 字符串算服务 ID，以及此刻的 inputSchema 长什么样（enum = 已配置服务）。
//
// 【这是新增的第一道闸，不是唯一一道】把 serverId 从自由字符串收窄成已配置服务 ID 的 enum 之后，
//   registry.run 在 schema 校验阶段就能挡掉 URL、命令行和未登记 id，模型也不必猜有哪些服务可选。
//   但 schema 是可以被绕过的（宿主自带 registry、调用方直接 execute、未来别的调用面），所以
//   connect-mcp-server.ts 里「只认 manager.get() 登记表」的运行期准入必须原样保留 —— 那才是最后
//   防线。本文件只做「让模型少走弯路」，不承担安全兜底。
//
// 【为什么必须每次现算】服务会在会话中被添加/删除。ToolRegistry 在【调用当刻】才读
//   tool.inputSchema —— loadSchema 经 toolCatalog.toolSnapshotOf 合成快照时读一次，run() 在
//   validateAgainstSchema 之前再读一次 —— 所以把 inputSchema 做成 getter，enum 就永远等于此刻的
//   登记表。做成注册期常量则会两头错：用户刚添加的服务被工具自己的 schema 判为非法值，刚删掉的
//   服务却继续出现在可选项里。同一手法见 connectSkill.ts（skill 也是 getter）。

/** 遍历登记表只需要 id；用结构类型而不是 McpServerSnapshot，测试里造替身更省事。 */
export interface McpConnectSchemaServer {
  readonly id: string
}

export interface McpConnectSchemaSource {
  list(): readonly McpConnectSchemaServer[]
}

/** 超过这个长度的入参一定不是服务 ID，直接拒，不进任何查表或文案。 */
export const MCP_CONNECT_SERVER_ID_MAX_CHARS = 512

/** enum 与拒绝提示里最多列多少个服务 ID。 */
export const MCP_CONNECT_MAX_LISTED_SERVER_IDS = 50

const BASE_DESCRIPTION =
  '要连接的【已配置】MCP 服务 ID。只接受服务 ID；URL、命令行等连接目标一律拒绝。'
const ENUM_NOTE = '取值必须是 enum 里列出的服务之一，照抄，不要改写。'
const NO_SERVER_NOTE =
  '当前没有任何已配置的 MCP 服务，此刻无服务可连；请如实告诉用户去设置里添加，不要自己拼连接目标。'
const OVERFLOW_NOTE =
  `当前已配置的服务超过 ${MCP_CONNECT_MAX_LISTED_SERVER_IDS} 个，未在此逐一列出；`
  + '照抄工具清单或上一次结果里给出的服务 ID。'

/**
 * 「这个字符串有资格当服务 ID 吗」。与 parseServerId 的运行期规则同源：
 * 非空、不超长、且首尾无空白（execute 会 trim，带空白的 id 连 manager.get 都命不中）。
 * 不合格的登记项不进 enum —— 列出一个本工具无论如何都接受不了的取值，只会浪费模型一轮往返。
 */
export function isAcceptableServerId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MCP_CONNECT_SERVER_ID_MAX_CHARS
    && value.trim() === value
}

type ServerIdOptions =
  | { readonly known: false }
  | { readonly known: true; readonly ids: string[] }

/**
 * 读登记表。宿主接线坏掉（list 抛错或返回非数组）时返回 known:false，而不是「空列表」——
 * 这两件事必须分开：前者是「不知道有哪些服务」，后者是「确定一个都没有」，对模型说的话不一样。
 */
function readServerIds(source: McpConnectSchemaSource): ServerIdOptions {
  let servers: readonly McpConnectSchemaServer[]
  try {
    servers = source.list() ?? []
  } catch {
    return { known: false }
  }
  if (!Array.isArray(servers)) return { known: false }

  const ids: string[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    const id = server?.id
    if (!isAcceptableServerId(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return { known: true, ids }
}

/** 此刻【本工具真的能接受】的服务 ID：按用户配置顺序、去重、不截断。 */
export function connectableServerIds(source: McpConnectSchemaSource): string[] {
  const options = readServerIds(source)
  return options.known ? options.ids : []
}

function serverIdSchema(description: string, choices?: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      serverId: {
        type: 'string',
        description,
        ...(choices ? { enum: [...choices] } : {}),
      },
    },
    required: ['serverId'],
    additionalProperties: false,
  }
}

/**
 * 造这一刻的 inputSchema。三种情况【故意不写 enum】，都不是偷懒：
 *
 *   · 一个服务都没配置 —— 空 enum 是不可满足的 schema：校验器会对任何取值都回一句
 *     「期望取值为  之一」（候选为空，连主语都没有），模型只看得出"我错了"，看不出"为什么、
 *     下一步做什么"。改成不带 enum + 描述里把事实说清楚，模型可以直接告诉用户去设置里添加，
 *     调用真的发生时也还能走到 execute，拿到带 hint 的 MCP_SERVER_NOT_CONFIGURED。
 *   · 服务数超过上限 —— 这里【不能截断】：截断会让第 51 个【真实存在】的服务被工具自己的 schema
 *     判为非法，一个配置正确的服务因此永远连不上。摘掉 enum 只是退回自由字符串，运行期登记表
 *     准入分毫未动。
 *   · 读不出登记表（宿主接线坏了）—— 不知道有哪些服务时就不下断言，绝不编造一份可选清单。
 */
export function buildConnectInputSchema(source: McpConnectSchemaSource): Record<string, unknown> {
  const options = readServerIds(source)
  if (!options.known) return serverIdSchema(BASE_DESCRIPTION)
  if (options.ids.length === 0) return serverIdSchema(`${BASE_DESCRIPTION}${NO_SERVER_NOTE}`)
  if (options.ids.length > MCP_CONNECT_MAX_LISTED_SERVER_IDS) {
    return serverIdSchema(`${BASE_DESCRIPTION}${OVERFLOW_NOTE}`)
  }
  return serverIdSchema(`${BASE_DESCRIPTION}${ENUM_NOTE}`, options.ids)
}
