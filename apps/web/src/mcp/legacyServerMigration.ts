import { stripMcpCredentialFields } from './credentialFields'
import { MCP_SETTINGS_STORAGE_KEY, parsePersistedMcpServers } from './persistence'
import type { PersistedMcpServerConfig } from './types'

// 把浏览器 localStorage 里的存量 MCP 服务配置一次性搬进桌面配置文件（B2）。
//
// 【口径沿用模型凭据的目录迁移】（docs/config-directory-override.md）：目标位置还没有数据
// 时才复制，旧数据原样保留，此后新位置优先。放在这里而不是装配点，是因为「该不该迁移」的
// 唯一判据是配置文件里到底有没有 servers 键，而只有读配置文件的那条路径知道答案。
//
// 【为什么不清空 localStorage】迁移只复制。浏览器宿主（pnpm dev、静态产物）读的仍是同一把
// 键，清掉等于顺手删掉另一个宿主的配置；留着的那份此后不会再被桌面端读取（配置文件有了
// servers 键就不再迁移），代价只是几 KB。
//
// 【WEB_AGENT_CONFIG_DIR 覆盖目录也照样迁移】web 层看不出当前配置目录是否被环境变量覆盖过
// （isTauri / invoke 都不暴露这件事），为了少搬一次配置而新增一个 IPC 不划算。取舍成立的
// 理由：搬过去的这份配置不含任何凭据——启动参数里疑似 token 的内容在 sanitize 阶段就被拒
// （见 config.ts），headers / env 由迁移自己剥掉（见下）——所以把它复制进某个实例目录不放大
// 凭据风险。用户不想要的话在设置面板删掉即可：删除会写回配置文件，servers 键随即存在，不会
// 再被迁移覆盖。
//
// 【为什么迁移要显式剥凭据】（C1）headers / env 现在是白名单里的合法字段，配置文件存它们是
// 本分；但迁移的**来源**是 localStorage，那里按设计一个凭据都不该有（persistence.ts 读写两端
// 都剥）。所以此刻在 localStorage 里出现的凭据只可能是手工塞的或被注入的，搬它就是替一个
// 不可信来源背书。起进程确认的指纹自 C2a 起已把 env 盖进去（补 env 会让确认作废、重新询问），
// 但那是最后一道闸，不是放行的理由——迁移只搬「配置」，凭据要用户在桌面端自己填。

/**
 * 只读地取出 localStorage 里的存量配置。
 *
 * 任何读不出、解析不出的情况都当作「没有存量」返回空数组：迁移是一次锦上添花的搬运，
 * 不是冷启动的前置条件。
 */
export function readLegacyMcpServerConfigs(): readonly PersistedMcpServerConfig[] {
  let raw: string | null
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    raw = window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)
  } catch {
    // 沙箱浏览器可能暴露 localStorage 却在访问时抛错（同 persistence.ts 里的处理）。
    return []
  }
  if (!raw) return []
  try {
    // 净化在这一步就发生：parsePersistedMcpServers 内部走 sanitizeConfigs，因此后面写进
    // 配置文件的只可能是过了白名单/上限/去重的结果，与 localStorage 宿主读到的完全一致——
    // 包括「不含凭据字段」这一条，所以这里补一次剥离（理由见文件头）。
    return parsePersistedMcpServers(raw).map(stripMcpCredentialFields)
  } catch {
    // 存量本身坏了（JSON 非法、ID 重复、超过上限）就跳过迁移：这种数据在浏览器宿主里同样
    // 读不出来，搬进配置文件只会把一份坏清单变成桌面端每次冷启动都失败的理由。
    return []
  }
}

export type LegacyMcpServerMigration = () => Promise<readonly PersistedMcpServerConfig[]>

/**
 * 造一个「只跑一次」的迁移动作，返回本次应当生效的服务清单（没有存量时是空数组）。
 *
 * `writeServers` 由调用方注入（配置文件的写通道），迁移本身不认识 Tauri。
 */
export function createLegacyMcpServerMigration(
  writeServers: (configs: readonly PersistedMcpServerConfig[]) => Promise<void>,
): LegacyMcpServerMigration {
  // 同一个 storage 实例内只跑一次：load() 会被重复调用（service.ts 的 hydrate 失败后可以
  // 再来一轮），并发调用时两次读都会看到「还没有 servers 键」。共享同一个 promise 才能保证
  // 只写一次、且两个调用者拿到同一份结果。跨进程的幂等不靠这个变量，靠「写成功后配置文件
  // 就有了 servers 键」——下次冷启动根本走不到迁移分支。
  let pending: Promise<readonly PersistedMcpServerConfig[]> | undefined
  return () => (pending ??= migrateLegacyServers(writeServers))
}

async function migrateLegacyServers(
  writeServers: (configs: readonly PersistedMcpServerConfig[]) => Promise<void>,
): Promise<readonly PersistedMcpServerConfig[]> {
  const legacy = readLegacyMcpServerConfigs()
  // 没有存量就不写：空数组照样能建出 servers 键，那等于凭空替用户宣布「配置文件已是权威」，
  // 而下一次启动时真正的存量（比如用户刚在另一个宿主里配好）就再也搬不进来了。
  if (legacy.length === 0) return []
  try {
    await writeServers(legacy)
  } catch {
    // 迁移写入失败【不】让 load 失败：这一轮照常用存量把界面点亮，用户此后任何一次保存都会
    // 把清单正常写进配置文件；即便一次都没保存，下次启动配置文件里仍然没有 servers 键，
    // 迁移会原样重来（幂等）。反过来把写入错误抛出去，只会把一个本可以正常工作的冷启动
    // 变成「无法读取 MCP 设置」——存量明明已经读出来了。
  }
  return legacy
}
