// 测试脚手架：一次性临时 workspace（外加一个「根外」的兄弟目录）
// ---------------------------------------------------------------------------
// 越界测试必须有真实的根外文件才有意义——只用字符串拼路径测不出 symlink 逃逸，因为词法上
// 它根本不越界。这里给的形状与 Rust 侧 `unique_workspace()` 一致：
//
//   base/                 ← 「根外」，放 secret.txt 之类
//     workspace/          ← workspace root
//
// base 先 realpath 一遍：macOS 的 `os.tmpdir()` 是 `/var/folders/...`，而 `/var` 是指向
// `/private/var` 的软链。不先解开的话，realpath 之后的真实路径与手里的 root 字符串对不上，
// 每条 confinement 断言都会因为这个与被测逻辑无关的理由「通过」或「失败」。

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempWorkspace {
  /** workspace root 的父目录——所有「根外」素材放这里。已 canonicalize。 */
  base: string
  /** workspace root，`<base>/workspace`。已 canonicalize。 */
  root: string
  /** 整棵临时树删掉。 */
  cleanup: () => Promise<void>
}

export async function createTempWorkspace(): Promise<TempWorkspace> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'host-node-ws-')))
  const root = join(base, 'workspace')
  await mkdir(root)
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) }
}
