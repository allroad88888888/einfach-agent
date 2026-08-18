// 按限额做的判定：写多大算太大、写完还算不算可逆
// ---------------------------------------------------------------------------
// 对齐三处 Rust：`workspace_write_options.rs` 的 `normalize_max_bytes`、
// `workspace_write_pipeline.rs` 里紧跟着 payload 的那段大小检查、`workspace_write_before.rs`
// 与 pipeline 尾部两处「不可逆理由」的判定。
//
// 【判定时机：写之前按**实测**字节数拒，不是按声明的大小，也不是边写边数】
// Rust 侧顺序是固定的：先把 `content` 变成**完整的字节数组**（utf8 直接取字节，base64 先解码），
// 再 `bytes = payload.len()` 与上限比，超了就在**碰文件系统之前**返回结构化失败。所以：
//   · 调用方没法谎报大小——`maxBytes` 只是调用方给自己设的更严的上限，被拒与否看的是实际字节数；
//   · 也不存在「写了一半发现超了」的半截文件，超限的写入根本不会打开文件；
//   · 代价是整份内容必须先进内存，这正是 MAX_BYTES 只有 8 MiB 的原因。
// Node 侧照搬这个顺序：**别改成流式边写边数**，那会把「超限时磁盘上什么都不留」这条性质弄丢。
//
// 【字节，不是字符】
// Rust 的 `String::len()` 与 `metadata.len()` 都是**字节**。JS 的 `string.length` 是 UTF-16 码元
// 数，对中文会少算到只有实际字节数的 1/3——直译成 `.length` 会让一份 2.4 MB 的中文正文被判成
// 「没超 1 MiB，可逆」，然后把它整份塞进变更日志。所以这里一律走 `Buffer.byteLength`。

import { Buffer } from 'node:buffer'
import { MAX_BYTES, REVERSIBLE_MAX_BYTES } from './limits'

/**
 * 把入参里的 `max_bytes` 收窄成本次写入的实际上限。
 * 对齐 Rust：`Some(value) if value > 0 => value.min(MAX_BYTES)`，其余（含 0 与未传）一律 MAX_BYTES。
 *
 * Rust 的 `Option<usize>` 在 deserialize 阶段就挡掉了负数与小数，Node 侧 handler 拿到的是未经
 * 校验的 `unknown`，没有那道关卡。这里补一条**没有 Rust 对应物**的兜底：非有限、非整数、负数
 * 一律当「没传」处理（回退到硬上限），而不是让整次写入失败——`maxBytes` 不是模型可见参数，
 * 为一个畸形的调用方自设上限而拒掉一次合法写入，代价大于收益。硬上限本身一步都没让。
 */
export function normalizeMaxBytes(rawMaxBytes: unknown): number {
  const isUsableNumber =
    typeof rawMaxBytes === 'number' && Number.isFinite(rawMaxBytes) && Number.isInteger(rawMaxBytes)
  if (!isUsableNumber || rawMaxBytes <= 0) return MAX_BYTES
  return Math.min(rawMaxBytes, MAX_BYTES)
}

/**
 * payload 是否超出本次写入的上限；超了给出与 Rust 逐字一致的失败文案，没超给 `undefined`。
 *
 * `bytes` 必须是**解码后 payload 的字节数**（base64 时是解码结果的长度，不是 base64 文本的长度）。
 * 边界是 `>`：恰好等于上限的写入是允许的。
 */
export function contentTooLargeMessage(bytes: number, maxBytes: number): string | undefined {
  if (bytes <= maxBytes) return undefined
  return `content is too large: ${bytes} bytes exceeds limit ${maxBytes}`
}

/**
 * 磁盘上的**旧**内容是否大到不值得留回滚记录。判据是 `MAX_BYTES`（不是 REVERSIBLE_MAX_BYTES）——
 * 文案里那句 "reversible" 与常量对不上是 Rust 侧原样，照搬不改：两个宿主对同一个文件必须说
 * 同一句话，改文案就是制造分叉。
 *
 * 返回的是**不可逆的理由**而不是失败：超限的旧文件照样可以被覆盖，只是这次写入不进变更日志。
 */
export function beforeExceedsReversibleBudget(fileSizeBytes: number): string | undefined {
  if (fileSizeBytes <= MAX_BYTES) return undefined
  return `existing file exceeds reversible ${MAX_BYTES} byte limit`
}

/**
 * 写完之后的**完整**内容是否超出可逆预算（append 时是「旧内容 + 追加内容」，不是只看追加的那段）。
 * 同样只影响 `reversible`，不影响写入本身。
 */
export function afterExceedsReversibleBudget(afterText: string): string | undefined {
  if (Buffer.byteLength(afterText, 'utf8') <= REVERSIBLE_MAX_BYTES) return undefined
  return `resulting file exceeds the reversible ${REVERSIBLE_MAX_BYTES} byte limit`
}
