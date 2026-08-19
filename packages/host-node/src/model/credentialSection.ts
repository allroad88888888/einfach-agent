// `config.json` 的 `modelCredentials` 段视图
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_credential_config.rs 的 `ModelCredentialStore`。
//
// 分层与 mcp 段完全一样，理由也一样（见 config/mcpConfigSection.ts 的文件头）：底座
// （config/webAgentConfigStore.ts）只认「一份配置由若干具名段组成」，段视图只看得见自己那一段。
// **凭证边界就落在段名上**——`mcp_config_read` / `mcp_config_write` 请求的段名恒为 `mcp`，
// 所以前端经那两条命令既读不到也写不到模型 Key，不是靠某处过滤，是压根没请求。
//
// 【这一层是 Key 在 Node 侧的唯一读取点】除本文件外，全包不应再出现第二处读 `modelCredentials`
// 的代码。第二处读法一旦出现，「Key 从哪来」就有了两个权威，而两者对「空串算不算配置了」
// 「前后空白要不要 trim」这类小事的答案很容易分叉，症状是「明明配了却说没配」。

import { resolveConfigPathsFromOptions } from '../config/configPaths'
import { createWebAgentConfigStore } from '../config/webAgentConfigStore'
import { MODEL_ERROR } from './errors'
import type { NodeHostInvokeOptions } from '../hostOptions'

const MODEL_CREDENTIAL_SECTION = 'modelCredentials'

/**
 * 读一个凭证键。段不存在返回 `undefined`；段存在但不是「字符串到字符串」的映射是**受控失败**
 * （Rust 的 `BTreeMap<String, String>` 反序列化同样会拒），文案与 Rust 一致。
 *
 * ⚠️ 返回值是**明文 Key**。调用方只能把它放进 Authorization 头；它不许进日志、不许进返回体、
 * 不许拼进任何错误消息。
 */
export async function readModelCredentialKey(
  options: NodeHostInvokeOptions,
  configKey: string,
): Promise<string | undefined> {
  const store = createWebAgentConfigStore(await resolveConfigPathsFromOptions(options))
  const section = await store.readSection(MODEL_CREDENTIAL_SECTION)
  if (section === undefined) return undefined
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(MODEL_ERROR.invalidConfigFormat)
  }
  const entries = Object.entries(section as Record<string, unknown>)
  // 整段校验而不是只看要取的那个键：Rust 反序列化整张表，一条坏值就整段失败。只判目标键会让
  // 「配置文件被写坏了」在两个宿主上给出不同答案——一边报错，一边照常跑。
  if (entries.some(([, value]) => typeof value !== 'string')) {
    throw new Error(MODEL_ERROR.invalidConfigFormat)
  }
  const found = entries.find(([key]) => key === configKey)
  return found?.[1] as string | undefined
}
