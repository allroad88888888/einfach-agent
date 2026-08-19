// `config.json` 的 `modelCredentials` 段视图
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_credential_config.rs 的 `ModelCredentialStore`。
//
// 分层与 mcp 段完全一样，理由也一样（见 config/mcpConfigSection.ts 的文件头）：底座
// （config/webAgentConfigStore.ts）只认「一份配置由若干具名段组成」，段视图只看得见自己那一段。
// **凭证边界就落在段名上**——`mcp_config_read` / `mcp_config_write` 请求的段名恒为 `mcp`，
// 所以前端经那两条命令既读不到也写不到模型 Key，不是靠某处过滤，是压根没请求。
//
// 【这一层是 Key 在 Node 侧的唯一读写点】除本文件外，全包不应再出现第二处读或写
// `modelCredentials` 的代码。第二处读法一旦出现，「Key 从哪来」就有了两个权威，而两者对
// 「空串算不算配置了」「前后空白要不要 trim」这类小事的答案很容易分叉，症状是「明明配了却说没配」。
// 写入同理：读与写共用下面同一个 `decodeCredentials`，所以「什么样的段算坏」两个方向答案一致
// ——只在读那头判的话，一份坏段会被一次写入**静默重写**成好段，用户丢的是自己那几把 Key。

import { resolveConfigPathsFromOptions } from '../config/configPaths'
import { createWebAgentConfigStore } from '../config/webAgentConfigStore'
import { modelRequestError } from './errors'
import type { NodeHostInvokeOptions } from '../hostOptions'

const MODEL_CREDENTIAL_SECTION = 'modelCredentials'

async function openStore(options: NodeHostInvokeOptions) {
  return createWebAgentConfigStore(await resolveConfigPathsFromOptions(options))
}

/**
 * Rust `decode_credentials`：整段必须是「字符串到字符串」的映射，否则**受控失败**（Rust 的
 * `BTreeMap<String, String>` 反序列化同样会拒），文案与 Rust 一致。段不存在 = 空表。
 *
 * 整段校验而不是只看要取的那个键：Rust 反序列化整张表，一条坏值就整段失败。只判目标键会让
 * 「配置文件被写坏了」在两个宿主上给出不同答案——一边报错，一边照常跑。
 */
function decodeCredentials(section: unknown): Map<string, string> {
  if (section === undefined) return new Map()
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw modelRequestError('invalidConfigFormat')
  }
  const entries = Object.entries(section as Record<string, unknown>)
  if (entries.some(([, value]) => typeof value !== 'string')) {
    throw modelRequestError('invalidConfigFormat')
  }
  return new Map(entries as [string, string][])
}

/**
 * 读一个凭证键（Rust `read_key`）。没有这一条时返回 `undefined`。
 *
 * ⚠️ 返回值是**明文 Key**。调用方只能把它放进 Authorization 头；它不许进日志、不许进返回体、
 * 不许拼进任何错误消息。
 */
export async function readModelCredentialKey(
  options: NodeHostInvokeOptions,
  configKey: string,
): Promise<string | undefined> {
  const store = await openStore(options)
  return decodeCredentials(await store.readSection(MODEL_CREDENTIAL_SECTION)).get(configKey)
}

/**
 * Rust `update_credentials`：**段更新**，不是整份覆盖。
 *
 * 读—改—写整体在底座的写入锁内完成（回调就是 `updateSection` 的那个 update），所以同一份
 * `config.json` 里的 `mcp` 段与任何未识别的顶层键都原样保留——抹掉用户的 MCP 配置只需要一次
 * 「读出 modelCredentials、写回整份文件」的天真实现，而那种损坏在写入的当下毫无症状。
 *
 * 回调抛错（段坏了）时底座**不写文件**，于是一份坏段不会被一次保存悄悄重写成好段。
 */
async function updateCredentials(
  options: NodeHostInvokeOptions,
  change: (credentials: Map<string, string>) => void,
): Promise<void> {
  const store = await openStore(options)
  await store.updateSection(MODEL_CREDENTIAL_SECTION, (current) => {
    const credentials = decodeCredentials(current)
    change(credentials)
    // 按键排序落盘，对齐 Rust 的 `BTreeMap`。理由同 webAgentConfigStore 的 serializeConfig：
    // 同一份文件被两个宿主轮流写，排序不一致时每次换宿主都会把整段重排一遍。
    // `Object.fromEntries` 而不是逐键赋值——`__proto__` 这个键名赋值会触发原型 setter 而静默丢失。
    return Object.fromEntries([...credentials].sort(([left], [right]) => (left < right ? -1 : 1)))
  })
}

/** 存一个凭证键（Rust `save_key`）。`apiKey` 必须是**已归一化**的值（见 credentials.ts）。 */
export async function writeModelCredentialKey(
  options: NodeHostInvokeOptions,
  configKey: string,
  apiKey: string,
): Promise<void> {
  await updateCredentials(options, (credentials) => {
    credentials.set(configKey, apiKey)
  })
}

/** 删一个凭证键（Rust `delete_key`）。本来就没有这一条时也照常写一次，与 Rust 同。 */
export async function deleteModelCredentialKey(
  options: NodeHostInvokeOptions,
  configKey: string,
): Promise<void> {
  await updateCredentials(options, (credentials) => {
    credentials.delete(configKey)
  })
}
