// `model_endpoint_status` / `_set` / `_delete` 三条命令
// ---------------------------------------------------------------------------
// **无 Rust 出处**：桌面宿主只认三家有官方接入点的 provider，没有「登记一个接入点」这件事。
// 这三条是 openai-compat 进入受限传输的入口——用户在设置面板里登记一条 base URL，后端把它写进
// `~/.webAgent/config.json`，端点白名单此后只放行那一条（判据与理由见 openAiCompatBaseUrl.ts）。
//
// ═══ 为什么不并进 `model_credential_*` ═══
// 形状很像（同一个 provider/scope、同样的 status→set→重读），但两者是**两类东西**：
//   · 凭证是秘密：`model_credential_*` 的返回体恒不含 Key，那是它最重要的一条契约。
//   · 接入点不是秘密，而且必须**回显**——设置面板要显示「你现在登记的是哪个地址」，
//     没有回显用户就无从确认自己填对了。
// 把回显字段加进凭证命令的返回体，等于在那条「返回体只有 {configured, source}」的契约上开一个
// 口子，而那条契约的价值正在于它没有例外。两条命令线各自的返回体因此形状不同，也不该相同。
//
// 【入参收窄落在这里】与本域其余四处收窄同款（routeTable.ts 的既定契约：每个 handler 自己收窄），
// 失败一律用 `MODEL_ERROR.invalidRequest`，同一类错误在同一个域里只说一句话。
// 地址本身不合规则是另一句 `MODEL_ERROR.invalidBaseUrl`——那不是「你没按契约发」，
// 而是「你发的这个地址不被允许」，补救动作完全不同。

import {
  deleteRegisteredOpenAiCompatOrigin,
  readRegisteredOpenAiCompatOrigin,
  writeRegisteredOpenAiCompatOrigin,
} from './openAiCompatEndpoint'
import { modelRequestError } from './errors'
import { definedKeys, isJsonRecord } from './wireShape'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostCommandHandler } from '../routeTable'

/**
 * 三条命令共同的返回体。
 *
 * `baseUrl` 只在登记有效时出现，且**一定是归一化后的值**——用户填 `https://h/v1/` 存进去的是
 * `https://h/v1`，面板显示的也是后者。回显原文会让「我登记的和真正上行的是不是同一个」这件事
 * 在两个地方有两种写法。
 */
export interface ModelEndpointStatus {
  readonly configured: boolean
  readonly baseUrl?: string
}

/** `model_endpoint_set` 的 `input` 字段集合（同 `SetModelCredentialInput` 的 deny_unknown_fields 口径）。 */
const SET_INPUT_KEYS: readonly string[] = ['baseUrl']

function invalidRequest(): never {
  throw modelRequestError('invalidRequest')
}

/**
 * 收窄 `{ baseUrl }`。枚举键用 `definedKeys` 而不是裸 `Object.keys`，理由见 wireShape.ts：
 * 同一份入参走 HTTP（JSON，没有 undefined）与进程内注入（键存在且为 undefined）时答案不该不同。
 */
function narrowSetInput(value: unknown): string {
  if (!isJsonRecord(value)) invalidRequest()
  for (const key of definedKeys(value)) {
    if (!SET_INPUT_KEYS.includes(key)) invalidRequest()
  }
  if (typeof value.baseUrl !== 'string') invalidRequest()
  return value.baseUrl
}

/**
 * 现在登记的是哪一条。
 *
 * 状态一律从**配置文件重新读**得出（写入/删除之后也重读一次），所以它回答的是「文件里现在
 * 是什么」，不是「刚才那次调用的入参是什么」。手改配置文件塞进一条不合规的值时，这里回的是
 * 「没登记」——与端点白名单当时的判断逐字同源（两处调的是同一个 normalize）。
 */
async function readEndpointStatus(
  options: NodeHostInvokeOptions,
): Promise<ModelEndpointStatus> {
  const baseUrl = await readRegisteredOpenAiCompatOrigin(options)
  return baseUrl === undefined ? { configured: false } : { configured: true, baseUrl }
}

/** `model_endpoint_status()`。只读，不建配置文件。 */
export function createModelEndpointStatusHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async () => readEndpointStatus(options)
}

/**
 * `model_endpoint_set({ input: { baseUrl } })`。**先判据、后落盘**：不合规的地址一个字节都不写。
 *
 * 反过来先写再校验的话，一次失败的登记会把上一条能用的登记覆盖掉——用户改错一个字母，
 * 代价是原本跑得通的接入点没了。
 */
export function createModelEndpointSetHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => {
    await writeRegisteredOpenAiCompatOrigin(options, narrowSetInput(args.input))
    return readEndpointStatus(options)
  }
}

/** `model_endpoint_delete()`。撤销之后 openai-compat 立刻回到 fail closed。 */
export function createModelEndpointDeleteHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async () => {
    await deleteRegisteredOpenAiCompatOrigin(options)
    return readEndpointStatus(options)
  }
}
