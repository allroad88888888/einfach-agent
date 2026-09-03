// Node HTTP 请求体的有界 JSON 读取原语。
//
// 超限后继续排空流但停止累积，避免 destroy IncomingMessage 时连带关闭响应 socket。

import type { IncomingMessage } from 'node:http'

export type BoundedJsonBodyResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'invalid-json' }

/** 按实际收到的字节数限制 body，并在完整接收后解析 JSON。 */
export function readBoundedJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<BoundedJsonBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let oversized = false
    let settled = false

    const cleanup = () => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
    }
    const finish = (result: BoundedJsonBodyResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onData = (chunk: Buffer) => {
      if (oversized) return
      total += chunk.byteLength
      if (total > maxBytes) {
        oversized = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (oversized) return finish({ kind: 'too-large' })
      if (total === 0) return finish({ kind: 'empty' })
      try {
        finish({ kind: 'json', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ kind: 'invalid-json' })
      }
    }
    const onError = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}
