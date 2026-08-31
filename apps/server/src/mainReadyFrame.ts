export const SERVER_READY_KIND = 'einfach-agent-server-ready'
export const SERVER_READY_VERSION = 1

export interface ServerReadyFrame {
  readonly kind: typeof SERVER_READY_KIND
  readonly version: typeof SERVER_READY_VERSION
  readonly url: string
}

/** 将 server 就绪信息编码成供父进程读取的一帧单行 JSON。 */
export function formatServerReadyFrame(frame: ServerReadyFrame): string {
  return `${JSON.stringify(frame)}\n`
}
