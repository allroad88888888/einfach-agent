// 从磁盘上那份条目 JSON 里读 status
// ---------------------------------------------------------------------------
// 补丁与批量回滚两个驱动器都要断言「跑完之后这条账停在什么状态」。**刻意不走本包的 `readEntry`**：
// 对拍要比的是两个宿主**落下来的产物**，借一侧的读取函数去解释它，等于让被测代码给自己判卷——
// 比如条目里少写了一个键，`readEntry` 的收窄可能补一个默认值，于是分岔被抹平。
// Rust 侧的驱动器同样直接 `serde_json::from_str` 读文件，不走 `read_entry`。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 条目不存在（或读不动）时返回 `null`——fixture 用 `null` 表达「这条账不该被记下来」。 */
export async function readJournalEntryStatus(
  journalDirectory: string,
  changeId: string,
): Promise<string | null> {
  try {
    const raw = await readFile(join(journalDirectory, `${changeId}.json`), 'utf8')
    return (JSON.parse(raw) as { status: string }).status
  } catch {
    return null
  }
}
