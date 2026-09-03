// 宿主文件系统中跟随符号链接的存在性探针。

import { stat } from 'node:fs/promises'

/** 等价 `Path::exists()`：跟随符号链接，任何错误都算不存在。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
