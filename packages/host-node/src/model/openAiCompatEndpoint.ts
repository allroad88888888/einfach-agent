// openai-compat 的登记接入点在 `config.json` 里的那一条：读 / 写 / 删
// ---------------------------------------------------------------------------
// 判据本身在 openAiCompatBaseUrl.ts（纯函数，不碰文件），本文件只回答「登记的那条在哪、怎么
// 落盘」。分成两个文件是因为端点白名单（providerRoute.ts）要用判据但**不该碰文件系统**：
// 白名单必须是能在内存里穷举验证的纯查表，混进一次异步读盘之后它就不是了。
//
// ═══ 为什么复用 `modelCredentials` 段 ═══
// base URL 不是密钥，按理不属于凭证段。它仍然落在那里，是因为 **CLI 已经在读这个键**
// （`apps/cli/src/credentials.ts` 的 `openai-compat:default:baseUrl`）。同一台机器上 CLI 与本机
// Node 后端读同一份 `~/.webAgent/config.json`：换一个段名等于让「我的接入点登记在哪」有两个
// 答案，而两个答案不一致时两边都不报错——CLI 打得通、网页说没登记。
//
// 读写一律经 credentialSection.ts 的三个函数，不另开一处读这一段（那个文件的文件头写明了
// 「本层是 Key 在 Node 侧的唯一读写点，全包不应再出现第二处读或写 modelCredentials 的代码」）。
// 这也顺带保住了段级校验的一致性：整段坏掉时读和写给同一个答案。
//
// ═══ 读回来的值仍然要过判据 ═══
// `config.json` 是用户自己的文件，谁都能手改，它**不是可信输入**。写入那次的拒绝只挡得住经
// 面板/命令走的路径；真正给端点白名单当依据的是读取这一次的判定。判据不过 = 当没登记
// （`undefined`），于是 openai-compat 的请求落进「目标未获允许」，而不是带着一条畸形 URL 上行。

import {
  deleteModelCredentialKey,
  readModelCredentialKey,
  writeModelCredentialKey,
} from './credentialSection'
import { normalizeOpenAiCompatBaseUrl, requireOpenAiCompatBaseUrl } from './openAiCompatBaseUrl'
import type { NodeHostInvokeOptions } from '../hostOptions'

/**
 * 登记键。`<provider>:<scope>:baseUrl` 与凭证键 `<provider>:<scope>` 同源同形，且**与 CLI 逐字
 *相同**——见文件头。改这个字面量要同时改 `apps/cli/src/credentials.ts`，否则两个宿主各读各的。
 */
export const OPENAI_COMPAT_BASE_URL_CONFIG_KEY = 'openai-compat:default:baseUrl'

/**
 * 读登记的接入点。没登记、或登记的值过不了判据，都回 `undefined`——两者对调用方是同一件事
 * （openai-compat 不可用），而把「文件里有一条坏值」单独报成错误会让整条模型链路因为一条与
 * 本次请求无关的配置行而失败。
 */
export async function readRegisteredOpenAiCompatOrigin(
  options: NodeHostInvokeOptions,
): Promise<string | undefined> {
  const raw = await readModelCredentialKey(options, OPENAI_COMPAT_BASE_URL_CONFIG_KEY)
  if (raw === undefined) return undefined
  return normalizeOpenAiCompatBaseUrl(raw)
}

/**
 * 登记一个接入点。**先判据、后落盘**：不合规的值一个字节都不写出去。
 *
 * 落盘的是归一化后的形态，不是用户敲进来的原文（末尾斜杠等写法差异在这一步就消掉，
 * 否则「我登记的是不是同一个地址」这件事在配置文件里会有多种写法）。
 */
export async function writeRegisteredOpenAiCompatOrigin(
  options: NodeHostInvokeOptions,
  value: string,
): Promise<string> {
  const normalized = requireOpenAiCompatBaseUrl(value)
  await writeModelCredentialKey(options, OPENAI_COMPAT_BASE_URL_CONFIG_KEY, normalized)
  return normalized
}

/** 撤销登记。撤销之后 openai-compat 立刻回到 fail closed（没有登记 = 目标未获允许）。 */
export async function deleteRegisteredOpenAiCompatOrigin(
  options: NodeHostInvokeOptions,
): Promise<void> {
  await deleteModelCredentialKey(options, OPENAI_COMPAT_BASE_URL_CONFIG_KEY)
}
