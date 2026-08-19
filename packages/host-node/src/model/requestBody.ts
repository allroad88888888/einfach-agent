// 请求体的收窄与限额：这次请求允许携带什么、最多多大
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_proxy_body.rs（常量、判据、检查顺序逐条对齐）。
//
// 【这一层为什么必须存在】上面的白名单管「打到哪」，这一层管「带什么过去」。两件事都做不到位
// 时的后果不一样：白名单破了是开放代理，这一层破了是**用宿主的内存和用户的配额**——一个 500 MB
// 的 base64 附件在解码那一步就把进程撑爆，而调用方只花了一次 HTTP 请求。
//
// 【bodyKind 必须与端点匹配，不是「能装下就行」】`prepareProviderBody` 的第二个参数来自白名单
// 表。往 `/chat/completions` 发 multipart、往 `/files` 发 json 都是**格式无效**：端点的 body 形状
// 是策略的一部分，放宽它等于让调用方自己决定请求长什么样。
//
// 【检查顺序照搬，不"优化"】文本分片先累加再判、文件分片先按 base64 长度粗筛再解码——顺序变了
// 会改变「哪一条限额先触发」，而两个宿主对同一份越界输入必须给同一个答案（对拍口径）。

import { MODEL_ERROR } from './errors'
import { hasExactKeys, isJsonRecord } from './wireShape'
import type { ProviderBodyKind } from './providerRoute'

const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_MULTIPART_PARTS = 16
const MAX_MULTIPART_FILES = 8
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_FILE_BATCH_BYTES = 40 * 1024 * 1024
const MAX_TEXT_BYTES = 64 * 1024
const MAX_TEXT_BATCH_BYTES = 256 * 1024
const MAX_PART_NAME_BYTES = 64
const MAX_FILE_NAME_BYTES = 255
const MAX_CONTENT_TYPE_BYTES = 128

/** Rust `valid_part_name`：ASCII 字母数字与 `_` `-`。 */
const PART_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
/** Rust `valid_content_type`：恰好两段，每段非空且只含 ASCII 字母数字与 `!#$&^_.+-`。 */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/
/** 标准 base64（`base64::engine::general_purpose::STANDARD`）的字母表与补齐。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/** 线上形状（Rust `ProviderMultipartPart`，serde 内部 tag `kind`，字段 camelCase）。 */
export type ProviderWireMultipartPart =
  | { readonly kind: 'text'; readonly name: string; readonly value: string }
  | {
      readonly kind: 'file'
      readonly name: string
      readonly fileName: string
      readonly contentType: string
      readonly bytesBase64: string
    }

/** 线上形状（Rust `ProviderRequestBody`）。收窄之后才配得上这个类型。 */
export type ProviderWireRequestBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'json'; readonly json: string }
  | { readonly kind: 'multipart'; readonly parts: readonly ProviderWireMultipartPart[] }

/** 一个已经解码、校验完的分片。base64 在这一步就变成字节，不再往下传字符串。 */
export type PreparedMultipartPart =
  | { readonly kind: 'text'; readonly name: string; readonly value: string }
  | {
      readonly kind: 'file'
      readonly name: string
      readonly fileName: string
      readonly contentType: string
      readonly bytes: Uint8Array
    }

/** Rust `PreparedProviderBody`。 */
export type PreparedProviderBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'json'; readonly json: string }
  | { readonly kind: 'multipart'; readonly parts: readonly PreparedMultipartPart[] }

function invalidBody(): never {
  throw new Error(MODEL_ERROR.invalidRequest)
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** `deny_unknown_fields` 的等价物；判据住 wireShape.ts，本域三处收窄共用同一份。 */
function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!hasExactKeys(value, keys)) invalidBody()
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') invalidBody()
  return value
}

function validPartName(value: string): boolean {
  return PART_NAME_PATTERN.test(value) && byteLength(value) <= MAX_PART_NAME_BYTES
}

/**
 * Rust `valid_file_name`：非空、≤255 字节、无控制字符、不含 `/` 与 `\`。
 *
 * 控制字符的范围按 Rust `char::is_control()`（Unicode 类别 Cc）：C0 段 U+0000–U+001F 与
 * C1 段 U+007F–U+009F。只挡 C0 不够——文件名会原样进 multipart 的
 * `Content-Disposition` 头，C1 里的字符在某些解析器上同样能撕开头部。
 *
 * 正则里一律写 `\u` 转义而不放字面控制字符：后者会让整份源文件被 grep
 * 当成二进制文件（实测：本文件里的任何符号都搜不到）。
 */
const FILE_NAME_FORBIDDEN_PATTERN = /[\u0000-\u001f\u007f-\u009f/\\]/u

function validFileName(value: string): boolean {
  return (
    value.length > 0
    && byteLength(value) <= MAX_FILE_NAME_BYTES
    && !FILE_NAME_FORBIDDEN_PATTERN.test(value)
  )
}

function validContentType(value: string): boolean {
  return (
    value.length > 0
    && byteLength(value) <= MAX_CONTENT_TYPE_BYTES
    && CONTENT_TYPE_PATTERN.test(value)
  )
}

/**
 * 严格标准 base64 解码。
 *
 * `Buffer.from(value, 'base64')` **不能直接用**：它宽容到会跳过非字母表字符、接受缺失的补齐，
 * 于是 `"AQ ID!!"` 也能解出字节。Rust 的 STANDARD 引擎要求规范补齐、拒绝表外字符。这里先用
 * 字母表与长度判据粗筛，再用「重新编码必须逐字相等」兜住尾部冗余比特那一类非规范输入——
 * 那是唯一一种能通过前两道、Rust 却会拒的情况。
 */
function decodeStandardBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) invalidBody()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) invalidBody()
  return new Uint8Array(bytes)
}

function narrowMultipartPart(value: unknown): ProviderWireMultipartPart {
  if (!isJsonRecord(value)) invalidBody()
  if (value.kind === 'text') {
    requireExactKeys(value, ['kind', 'name', 'value'])
    return { kind: 'text', name: requireString(value.name), value: requireString(value.value) }
  }
  if (value.kind === 'file') {
    requireExactKeys(value, ['kind', 'name', 'fileName', 'contentType', 'bytesBase64'])
    return {
      kind: 'file',
      name: requireString(value.name),
      fileName: requireString(value.fileName),
      contentType: requireString(value.contentType),
      bytesBase64: requireString(value.bytesBase64),
    }
  }
  return invalidBody()
}

/** 把一袋外部输入收窄成线上形状。**只认形状**，限额在 `prepareProviderBody` 里判。 */
export function narrowProviderRequestBody(value: unknown): ProviderWireRequestBody {
  if (!isJsonRecord(value)) invalidBody()
  if (value.kind === 'none') {
    requireExactKeys(value, ['kind'])
    return { kind: 'none' }
  }
  if (value.kind === 'json') {
    requireExactKeys(value, ['kind', 'json'])
    return { kind: 'json', json: requireString(value.json) }
  }
  if (value.kind === 'multipart') {
    requireExactKeys(value, ['kind', 'parts'])
    if (!Array.isArray(value.parts)) invalidBody()
    return { kind: 'multipart', parts: value.parts.map(narrowMultipartPart) }
  }
  return invalidBody()
}

/** Rust `prepare_multipart`。累加与判定的顺序与 Rust 的 for 循环逐句一致。 */
function prepareMultipart(
  parts: readonly ProviderWireMultipartPart[],
): readonly PreparedMultipartPart[] {
  if (parts.length === 0 || parts.length > MAX_MULTIPART_PARTS) invalidBody()
  const prepared: PreparedMultipartPart[] = []
  let fileCount = 0
  let fileBytes = 0
  let textBytes = 0
  for (const part of parts) {
    if (part.kind === 'text') {
      const size = byteLength(part.value)
      textBytes += size
      if (!validPartName(part.name) || size > MAX_TEXT_BYTES || textBytes > MAX_TEXT_BATCH_BYTES) {
        invalidBody()
      }
      prepared.push(part)
      continue
    }
    // base64 长度粗筛在**解码之前**：这才是那道真正挡住内存放大的门，解码之后再判就晚了。
    if (
      !validPartName(part.name)
      || !validFileName(part.fileName)
      || !validContentType(part.contentType)
      || part.bytesBase64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)
    ) {
      invalidBody()
    }
    const bytes = decodeStandardBase64(part.bytesBase64)
    fileCount += 1
    fileBytes += bytes.byteLength
    if (
      bytes.byteLength === 0
      || bytes.byteLength > MAX_FILE_BYTES
      || fileCount > MAX_MULTIPART_FILES
      || fileBytes > MAX_FILE_BATCH_BYTES
    ) {
      invalidBody()
    }
    prepared.push({
      kind: 'file',
      name: part.name,
      fileName: part.fileName,
      contentType: part.contentType,
      bytes,
    })
  }
  return prepared
}

/**
 * Rust `prepare_provider_body`：先判 body 形状与端点要求是否一致，再判各自的限额。
 *
 * JSON 分支会**解析一遍**再原样透传字符串：解析只为拒绝非 JSON（一个不合法的 body 打到上游
 * 只会换回一条供应商的报错，白花一次往返），透传原文是为了不改动模型请求的逐字内容——
 * 重新序列化会动字段顺序与数字表示，而那份 body 是 adapter 精确构造的。
 */
export function prepareProviderBody(
  body: ProviderWireRequestBody,
  expected: ProviderBodyKind,
): PreparedProviderBody {
  if (body.kind !== expected) invalidBody()
  if (body.kind === 'none') return { kind: 'none' }
  if (body.kind === 'json') {
    if (byteLength(body.json) > MAX_JSON_BYTES) invalidBody()
    try {
      JSON.parse(body.json)
    } catch {
      invalidBody()
    }
    return { kind: 'json', json: body.json }
  }
  return { kind: 'multipart', parts: prepareMultipart(body.parts) }
}
