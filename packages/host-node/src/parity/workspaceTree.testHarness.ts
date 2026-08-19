// 带 IO 的对拍用例共用的「初始文件树 → 跑一次 → 读回整棵树」
// ---------------------------------------------------------------------------
// fixture 只描述「初始文件树 + 操作 + 期望结果」，临时目录本身不进 fixture（见
// ../../fixtures/README.md）。这里是 TS 侧建树与读树的那两下，Rust 侧有一份同语义的实现。
//
// **读回来的是穷举**：跑完之后 workspace 里多一个文件或少一个文件都要能看出来，所以递归枚举
// 全部普通文件而不是按 fixture 里列的键去逐个查。按键去查的话，「本该被删掉的文件其实还在」
// 这种分岔会静默通过——而那正是补丁与回滚最该被盯住的一类错。
//
// 目录本身不进结果：两个宿主对「删完文件后空目录留不留」没有共同承诺（`delete_file` 只删文件），
// 把空目录纳入比对等于凭空造一条两边都没写过的契约。

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** 相对路径（正斜杠） → 文件内容。fixture 的 `initialFiles` / `expected.files` 就是这个形状。 */
export type WorkspaceTree = Record<string, string>

/** 按 fixture 的 `initialFiles` 铺好初始树。父目录按需创建。 */
export async function seedWorkspaceTree(root: string, tree: WorkspaceTree): Promise<void> {
  for (const [relativePath, content] of Object.entries(tree)) {
    const absolute = join(root, relativePath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }
}

/** 递归读回 workspace 里的**全部**普通文件。符号链接与目录不进结果。 */
export async function readWorkspaceTree(root: string): Promise<WorkspaceTree> {
  const tree: WorkspaceTree = {}
  await collect(root, root, tree)
  return tree
}

async function collect(root: string, directory: string, tree: WorkspaceTree): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collect(root, absolute, tree)
    } else if (entry.isFile()) {
      tree[relative(root, absolute).split(sep).join('/')] = await readFile(absolute, 'utf8')
    }
  }
}
