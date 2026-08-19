// 读 stdout：字节 → 帧 → JSON → 分发，并在流走到头时报告传输关闭
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_protocol.rs（已随 T1 删除）的 `read_protocol_stream`。Rust 那边是一条专属线程
// 里的阻塞循环，Node 这边是三个事件回调——同一个状态机，只是驱动方式不同。
//
// 三条终止路径必须都接上，缺一条就是「连接其实已经死了，但在途请求要等到超时才知道」：
//   'end'   —— 对端关了 stdout（正常退出、或它自己 close 了管道）
//   'error' —— 读管道本身失败（EIO、fd 被抢走这类）
//   而**子进程退出**是第四条，不在这里——它由 childProcess.ts 的 'exit' 事件报，因为一个进程
//   可以先退出、stdout 却因为孙进程还握着写端而迟迟不 EOF。

import type { Readable } from 'node:stream'
import { dispatchProtocolValue, type DispatchContext } from './dispatch'
import { JsonRpcLineFramer } from './frames'
import { MAX_PROTOCOL_LINE_BYTES } from './limits'

export interface ProtocolReaderContext extends DispatchContext {
  /**
   * 传输走到头了。实现见 session.ts：置 transportClosed、让全部在途请求以此理由失败、
   * 发一次（且仅一次）close 事件。
   */
  onTransportClosed: (message: string) => void
}

/** 把一条 stdout 接上分发。返回后读取在后台进行，无需 await。 */
export function readProtocolStream(stdout: Readable, context: ProtocolReaderContext): void {
  const framer = new JsonRpcLineFramer()
  let finished = false

  const finish = (message: string): void => {
    // 'end' 与 'error' 可以先后都来（先 error 后 close）。终止只算一次，否则
    // `onTransportClosed` 里的 close 事件去重会被迫承担本该在这里挡掉的重复。
    if (finished) return
    finished = true
    context.onTransportClosed(message)
  }

  stdout.on('data', (chunk: Buffer) => {
    for (const frame of framer.push(chunk)) {
      if (frame.kind === 'oversized') {
        // **注意这里不关传输**（Rust 同样）。一条超大消息说明对端不守规矩，但管道还是好的；
        // 在途请求全部失败是因为「那条巨型响应里可能就有你等的答案，而它已经被丢了」——
        // 让它们挂到超时是最坏的选择。下一条消息照常处理。
        context.pending.failAll({
          kind: 'transport',
          message: `MCP server sent a message larger than ${MAX_PROTOCOL_LINE_BYTES} bytes`,
        })
        continue
      }
      handleLine(frame.bytes, context)
    }
  })

  stdout.on('end', () => {
    // EOF 之前可能还剩一行没有行尾换行的内容，先把它交出去再报关闭。
    for (const frame of framer.end()) {
      if (frame.kind === 'line') handleLine(frame.bytes, context)
    }
    finish('MCP server closed stdout')
  })

  stdout.on('error', (error: Error) => {
    finish(`failed to read MCP server stdout: ${error.message}`)
  })
}

/**
 * 一行 → 一条消息。
 *
 * 解析失败**静默丢弃**。Rust 那边是 `log::warn!`，而 host-node 全包没有 logger，本卡也不该
 * 顺手立一个（那是宿主装配层的决定，且一个能被对端随意刷屏的 log 出口本身要设计）。
 * 代价是诚实的：一台会往 stdout 里混打印日志的 MCP server，在 Node 宿主上不会留下任何痕迹。
 * 已作为移植发现记录在案。
 */
function handleLine(bytes: Buffer, context: DispatchContext): void {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return
  }
  dispatchProtocolValue(value, context)
}
