// 请求信封：`{ target, body, requestId }` 的收窄与整体大小上限
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_proxy_envelope.rs。
//
// 【为什么在解码 body 之前先量整份信封】base64 的膨胀率是 4/3，但真正危险的不是膨胀——是**分片
// 数 × 单片上限**这个乘积：单看每条限额都合规的一份请求，加起来可以远超任何一条。所以先给整个
// 信封一个 56 MiB 的硬顶，再往下走各分片的校验，顺序不能反。
//
// 【Node 侧的量法与 Rust 不同、结论相同】Rust 用一个计数 writer 边序列化边扣额度，一个字节都不
// 落地；Node 这边 `JSON.stringify` 会真的拼出那个字符串。差别是内存峰值，不是判据——而这一路上
// 载荷本来就已经在内存里（HTTP 那条路上 M2 得先把请求体读完才能解析 JSON），所以没有「本来可以
// 不落地」的字节。**M2 仍应在读请求体时先按同一个上限截断**：那才是能真正省下内存的地方，本函数
// 是进程内注入（CLI / sidecar）那条路上的最后一道。
//
// 【键序刻意与 Rust 结构体一致】`target → body → requestId`、target 内 `provider → scope →
// method → path`。JSON.stringify 按插入序输出，于是同一份请求在两个宿主里量出来的字节数一致
// （前端 providerWireEnvelope.ts 量的也是 JSON.stringify 的结果，本来就是这一套）。

import { MODEL_ERROR } from './errors'
import { narrowProviderRequestBody, type ProviderWireRequestBody } from './requestBody'
import { narrowProviderTarget, type ProviderTarget } from './providerRoute'
import { validateModelRequestId } from './requestRegistry'
import { definedKeys, isJsonRecord } from './wireShape'

/** Rust `MAX_PROVIDER_WIRE_REQUEST_BYTES`。 */
const MAX_WIRE_REQUEST_BYTES = 56 * 1024 * 1024

/** Rust `ModelProviderRequestInput`（serde camelCase + deny_unknown_fields）。 */
export interface ProviderRequestEnvelope {
  readonly target: ProviderTarget
  readonly body: ProviderWireRequestBody
  readonly requestId: string
}

const ENVELOPE_KEYS: readonly string[] = ['target', 'body', 'requestId']

/**
 * 把一袋外部输入收窄成信封，并施加整体大小上限。
 *
 * `maxBytes` 可注入只为测试能在小尺寸上验证边界（Rust 的
 * `validate_provider_request_envelope_with_limit` 同款）；生产路径永远用默认值。
 */
export function narrowProviderRequestEnvelope(
  value: unknown,
  maxBytes: number = MAX_WIRE_REQUEST_BYTES,
): ProviderRequestEnvelope {
  if (!isJsonRecord(value)) throw new Error(MODEL_ERROR.invalidRequest)
  const raw = value
  for (const key of definedKeys(raw)) {
    if (!ENVELOPE_KEYS.includes(key)) throw new Error(MODEL_ERROR.invalidRequest)
  }
  // requestId 先判：它的错（`模型请求 ID 无效`）比「格式无效」具体，先量大小会把一个拼错的 ID
  // 说成整份请求格式有问题。Rust 的 validate 也是先 ID 后大小。
  const requestId = validateModelRequestId(raw.requestId)
  const envelope: ProviderRequestEnvelope = {
    target: narrowProviderTarget(raw.target),
    body: narrowProviderRequestBody(raw.body),
    requestId,
  }
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > maxBytes) {
    throw new Error(MODEL_ERROR.invalidRequest)
  }
  return envelope
}
