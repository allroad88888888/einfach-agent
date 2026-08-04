// D-3b · 下线模型名迁移表 —— 持久化恢复路径上的模型名兼容层。
// ---------------------------------------------------------------------------
// 背景：SessionMeta.settings.model 是**持久化**字段（sessionsPersistence 把整个 SessionMeta
//   存进 IndexedDB / SQLite）。新会话由 commands.newSession 用 DEFAULT_DEEPSEEK_MODEL 创建，
//   永远是当下有效的模型名；但**存量会话**恢复出来时 model 仍是当初存下的值 —— 一旦 provider
//   下线该模型名，老会话一发请求就撞 400，用户看到的只是一句 provider 原文，无从下手。
//   恢复路径（hydrate）是唯一能一次性覆盖全部存量会话的位置，故兼容层落在这里。
//
// 维护方式：**只往 DEPRECATED_MODEL_MIGRATIONS 里加一行**，不要在别处散写 if。
//   每行必须注明 source（官方公告 URL）与 deprecatedAt（官方给的下线时刻），
//   便于日后判断某行是否已经可以删除（存量会话都迁完之后这张表的行才是死代码）。

import { DEEPSEEK_FLASH_MODEL } from '@web-agent/ai'
import type { DeepSeekReasoningEffort } from '@web-agent/ai'
import type { DeepSeekSettings, ModelSettings } from '../core.type'

// 简介：把持久化数据中的 DeepSeek reasoning_effort 收口到 V4 的 high|max。
// 详情：V4 会把旧 SDK/旧 UI 的 low、medium 都视为 high，把 xhigh 视为 max。持久化 JSON
//   没有运行时类型保证，故这里接 unknown；其它非法值直接丢弃，让 Provider 使用安全默认值，
//   不能原样透传成 400。这个归一化只属于 DeepSeek，不改变 GLM 的 low|medium|high|max 域。
export function normalizeDeepSeekReasoningEffort(
  value: unknown,
): DeepSeekReasoningEffort | undefined {
  if (value === 'high' || value === 'max') return value
  if (value === 'low' || value === 'medium') return 'high'
  if (value === 'xhigh') return 'max'
  return undefined
}

function normalizeDeepSeekSettings(settings: ModelSettings): ModelSettings {
  if (settings.vendor !== 'deepseek') return settings

  // loadSessions() 的静态返回类型是 SessionMeta[]，但底层来自 JSON/SQLite，历史字段在运行时仍可能
  // 超出当前 DeepSeekSettings 类型域；必须先按 unknown 读取再归一化。
  const raw = (settings as DeepSeekSettings & { reasoning_effort?: unknown }).reasoning_effort
  const normalized = normalizeDeepSeekReasoningEffort(raw)
  if (raw === normalized) return settings

  if (normalized === undefined) {
    const {
      reasoning_effort: _discarded,
      ...safeSettings
    } = settings as DeepSeekSettings & { reasoning_effort?: unknown }
    return safeSettings as DeepSeekSettings
  }
  return { ...settings, reasoning_effort: normalized }
}

// 简介：一条「旧模型名 → 继任模型名」的迁移规则。
// 详情：vendor 参与匹配 —— 模型名只在自家 vendor 命名空间内唯一，跨 vendor 撞名不该误迁。
//   impliedThinking 表达「旧名本身编码了思考模式」这件事（见下方 deepseek 两行）：
//   旧名被拆成「新模型 + 模式开关」时，只改 model 会**静默改变行为**，故需要连带补上模式；
//   为 undefined 表示该旧名不隐含任何模式，迁移不得触碰 settings.thinking。
export interface DeprecatedModelMigration {
  vendor: ModelSettings['vendor']
  /** 下线的旧模型名（精确匹配 settings.model）。 */
  from: string
  /** 官方指定的继任模型名。 */
  to: string
  /** 旧名隐含的思考模式；undefined = 不隐含，迁移不动 thinking。 */
  impliedThinking?: boolean
  /** 官方公告的下线时刻（原文照抄，便于核对）。 */
  deprecatedAt: string
  /** 官方公告出处。 */
  source: string
}

// 简介：全部已知的下线模型名迁移规则。
// 详情：DeepSeek 官方定价页脚注 1 原文 ——
//   "The model names deepseek-chat and deepseek-reasoner will be deprecated on 2026/07/24 15:59 UTC.
//    For compatibility, they correspond to the non-thinking mode and thinking mode of
//    deepseek-v4-flash, respectively."
//   即两个旧名指向**同一个新模型的两种模式**；本仓库里模式是 settings.thinking 这个独立字段，
//   所以迁移要「改 model + 按旧名补 thinking」两步才等价。
export const DEPRECATED_MODEL_MIGRATIONS: readonly DeprecatedModelMigration[] = [
  {
    vendor: 'deepseek',
    from: 'deepseek-chat',
    to: DEEPSEEK_FLASH_MODEL,
    impliedThinking: false, // 旧 deepseek-chat = v4-flash 的非思考模式
    deprecatedAt: '2026/07/24 15:59 UTC',
    source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  },
  {
    vendor: 'deepseek',
    from: 'deepseek-reasoner',
    to: DEEPSEEK_FLASH_MODEL,
    impliedThinking: true, // 旧 deepseek-reasoner = v4-flash 的思考模式
    deprecatedAt: '2026/07/24 15:59 UTC',
    source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  },
]

// 简介：把一份会话设置里的下线模型名迁移到继任者；无需迁移时**原样返回同一引用**。
// 详情：三条不变量 ——
//   · 幂等：继任者本身不在表的 from 列里，故迁移结果再迁一次必定命中不到规则、原样返回；
//   · 不误伤：未知模型名（用户显式设的自定义 model）与已是新名的会话都走「返回同一引用」分支，
//     绝不武断改写；同一引用也让调用方能用 `!==` 廉价判断「这轮到底改没改」；
//   · 不覆盖用户的显式选择：thinking 只在 undefined（= 用户从没表过态，modelRun 据此不发该字段）
//     时才按旧名补上。用户若显式设过 true/false，那是他对模式的主动选择，比旧名的隐含语义优先。
export function migrateModelSettings(settings: ModelSettings): ModelSettings {
  const normalized = normalizeDeepSeekSettings(settings)
  const rule = DEPRECATED_MODEL_MIGRATIONS.find(
    (r) => r.vendor === normalized.vendor && r.from === normalized.model,
  )
  if (!rule) return normalized

  const migrated: ModelSettings = { ...normalized, model: rule.to }
  if (rule.impliedThinking !== undefined && normalized.thinking === undefined) {
    return { ...migrated, thinking: rule.impliedThinking }
  }
  return migrated
}

// 简介：兼容主 Agent 中已下线的模型别名。
// 详情：只迁移已下线的别名；仍可用的 Flash、Pro、自定义模型和其它 vendor 都按用户保存值原样保留。
export function normalizePrimaryAgentSettings(settings: ModelSettings): ModelSettings {
  return migrateModelSettings(settings)
}

// 简介：迁移一个 SessionMeta 的 settings；
// 无需变更时**原样返回同一引用**。
// 详情：只碰 settings，其余字段（含 updatedAt）一概不动 —— 兼容迁移不是「用户改了会话」，
//   不该顶掉 updatedAt（那是 hydrate 选 active 会话的排序依据，改了会把 active 挪到老会话上）。
export function migrateSessionMeta<T extends { settings: ModelSettings }>(session: T): T {
  const settings = normalizePrimaryAgentSettings(session.settings)
  return settings === session.settings ? session : { ...session, settings }
}
