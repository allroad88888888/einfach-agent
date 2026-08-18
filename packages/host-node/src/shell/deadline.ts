// 「等这件事，但最多等这么久」——shell 域里三处等待共用的那一小段
// ---------------------------------------------------------------------------
// Rust 侧对应的是各处循环里的 `start.elapsed() >= timeout`：它靠轮询，所以到点判断天然
// 分散在每个循环里；Node 这边等的是事件，唯一的写法就是跟一个定时器竞速，于是这段逻辑
// 反而成了实体，值得只写一遍。
//
// 定时器**必须清掉**：Node 的 event loop 会一直活到最后一个未触发的定时器为止。留着它，
// 一条 30ms 就跑完的命令会让 CLI 宿主在退出前多挂 30 秒，而且这种延迟不指向任何病因。

/** 等 `work` 或等到点，返回是否**到点了**（true = 超时，false = work 先完成）。 */
export async function raceDeadline(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs)
  })
  try {
    return await Promise.race([work.then(() => false), deadline])
  } finally {
    clearTimeout(timer)
  }
}
