// `model_credential_status` / `_set` / `_delete` 三条命令
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_credentials.rs 的**写入半边**与那三个 `#[tauri::command]`。
// 读取半边（绑定表、归一化、「配置里有没有」）在 credentials.ts，本文件**复用**它导出的
// `credentialConfigKey` / `normalizeApiKey` / `readConfiguredModelCredential`：
// 「(供应商,作用域) → 配置键」这张表全包只有那一份。各写一份必然分叉，而分叉的症状是
// 「存进去了但读不出来」——存用一个键名、读用另一个，两条路各自都不报错。
//
// ═══ 返回体只有 `{ configured, source }` ═══
// 这三条命令的返回值**恒不含 Key**，任何路径都是：成功、失败、以及每一条错误消息。
// 状态是从**落盘之后**重新读一次得出的（Rust 的 set/delete 同样在写完之后调 `status`），
// 所以它回答的是「文件里现在有没有」，不是「刚才那次写入的入参长什么样」——后者才是把 Key
// 顺手回显出去的那条路。判「有没有」用的是一个**表达式**而不是一个具名局部变量
// （`readConfiguredModelCredential(...) !== undefined`），明文 Key 在本文件里连个名字都没有。
//
// 【与 Rust 的一处**有意**差异】Rust 的 `ModelCredentialStatus` 还回显 `provider` 与 `scope`
// 两个字段（就是调用方自己传进来的那两个）。这里只回 `configured` 与 `source`，对齐前端
// `apps/web/src/settings/modelCredentialHost.ts` 的 `ModelCredentialStatus` 类型——那是这三条
// 命令唯一的消费者，它只读这两个字段（全仓没有任何 TS 代码读回显的 provider/scope）。
// 这条链路会经 `POST /api/invoke/:command` 暴露成 HTTP 响应，返回体就是线上可见的东西，
// 能不出去的字段就不出去。
//
// 【入参收窄为什么落在这里】Rust 那三条命令的入参由 Tauri 的命令参数反序列化把关（provider
// 是闭合枚举、`SetModelCredentialInput` 带 `deny_unknown_fields`）。Node 这条路上没有那一层，
// 每个 handler 自己收窄（routeTable.ts 的既定契约）。收窄失败一律用
// `MODEL_ERROR.invalidRequest`，与本域另外三处收窄（信封 / target / body）同一句话——
// 同一类错误在同一个域里说两句话，排查时会以为它们是两回事。

import { deleteModelCredentialKey, writeModelCredentialKey } from './credentialSection'
import { credentialConfigKey, normalizeApiKey, readConfiguredModelCredential } from './credentials'
import { modelRequestError } from './errors'
import { isModelProviderName, narrowProviderScope } from './provider'
import { definedKeys, isJsonRecord } from './wireShape'
import type { ModelProviderName, ProviderScope } from './provider'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostCommandHandler } from '../routeTable'

/** Rust `CredentialSource`，serde `rename_all = "lowercase"`。 */
export type CredentialSource = 'config' | 'missing'

/** 三条命令共同的返回体。**永远不含 Key**——见文件头。 */
export interface ModelCredentialStatus {
  readonly configured: boolean
  readonly source: CredentialSource
}

/** 一次凭证操作指向哪一条凭证。 */
interface CredentialTarget {
  readonly provider: ModelProviderName
  readonly scope: ProviderScope
}

/** Rust `SetModelCredentialInput` 的字段集合（`deny_unknown_fields` 的判据）。 */
const SET_INPUT_KEYS: readonly string[] = ['provider', 'scope', 'apiKey']

function invalidRequest(): never {
  throw modelRequestError('invalidRequest')
}

/**
 * 收窄 `{ provider, scope? }`。`scope` 缺席按 Rust 的 `#[serde(default)]` 当 `default`
 * （`narrowProviderScope` 是本域唯一的作用域收窄口）。
 *
 * **多余的顶层键不构成另一种行为**：Tauri 按参数名逐个反序列化，命令签名之外的键它本来就不看，
 * 这里同样只读自己认识的两个。`deny_unknown_fields` 在 Rust 侧只加在 `set` 的 `input` 结构体上，
 * 所以那一处（且只有那一处）真的枚举键。
 *
 * 【一处有意的收窄】Rust 那三条命令的 `scope` 是 `Option<ProviderScope>`，显式的 `null` 会被
 * 当成缺席；这里 `null` 是格式无效。缺席只认 `undefined`（同 mcpConfigCommands 的判缺席口径），
 * 而 `narrowProviderScope` 是本域唯一的作用域收窄口，为这三条命令另开一条「null 也算缺席」的
 * 支路等于给作用域判定开第二个权威。前端三个调用点传的都是具体值，没有 `null` 这条路。
 */
function narrowCredentialTarget(value: unknown): CredentialTarget {
  if (!isJsonRecord(value)) invalidRequest()
  if (!isModelProviderName(value.provider)) invalidRequest()
  return { provider: value.provider, scope: narrowProviderScope(value.scope) }
}

/**
 * 收窄 `model_credential_set` 的 `input`（Rust `SetModelCredentialInput`）。
 *
 * 枚举键用 `definedKeys` 而不是裸 `Object.keys`，理由见 wireShape.ts：同一份入参走 HTTP
 * （JSON，没有 undefined）与进程内注入（键存在且为 undefined）时答案不该不同。
 *
 * ⚠️ 返回值里带**明文 Key**，仅供紧接着的归一化与落盘使用。
 */
function narrowSetInput(value: unknown): CredentialTarget & { apiKey: string } {
  if (!isJsonRecord(value)) invalidRequest()
  for (const key of definedKeys(value)) {
    if (!SET_INPUT_KEYS.includes(key)) invalidRequest()
  }
  if (typeof value.apiKey !== 'string') invalidRequest()
  return { ...narrowCredentialTarget(value), apiKey: value.apiKey }
}

/**
 * Rust 的 `status()`：配置里有一条归一化之后还在的值就算配置了。
 *
 * 作用域不成立时在 `credentialConfigKey` 那里就是受控失败（`readConfiguredModelCredential`
 * 内部先查绑定表），所以「kimi + default」拿到的是「作用域未获允许」，不是一个说「没配置」的
 * 假答案——后者会让用户以为自己该去存一把根本存不进去的 Key。
 */
async function readCredentialStatus(
  options: NodeHostInvokeOptions,
  { provider, scope }: CredentialTarget,
): Promise<ModelCredentialStatus> {
  // 刻意不把返回值绑到局部变量上：这里要的只是「有没有」，明文 Key 不需要在本文件里存在。
  const configured = (await readConfiguredModelCredential(options, provider, scope)) !== undefined
  return { configured, source: configured ? 'config' : 'missing' }
}

/** `model_credential_status(provider, scope?)`。只读，不建配置文件。 */
export function createModelCredentialStatusHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => readCredentialStatus(options, narrowCredentialTarget(args))
}

/**
 * `model_credential_set({ input })`。顺序与 Rust 逐条一致：**先查绑定表，再归一化，最后落盘**。
 *
 * 顺序不是随意的：作用域不成立时一个字节都不该写出去。反过来先归一化的话，「kimi + default」
 * 会先拿到「API Key 格式无效」——一句指向用户输入的错误，而真正的问题是这个组合不存在。
 */
export function createModelCredentialSetHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => {
    const { provider, scope, apiKey } = narrowSetInput(args.input)
    const configKey = credentialConfigKey(provider, scope)
    const normalized = normalizeApiKey(apiKey)
    if (normalized === undefined) throw modelRequestError('invalidApiKey')
    await writeModelCredentialKey(options, configKey, normalized)
    return readCredentialStatus(options, { provider, scope })
  }
}

/** `model_credential_delete(provider, scope?)`。删完同样重读一次状态。 */
export function createModelCredentialDeleteHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => {
    const target = narrowCredentialTarget(args)
    await deleteModelCredentialKey(options, credentialConfigKey(target.provider, target.scope))
    return readCredentialStatus(options, target)
  }
}
