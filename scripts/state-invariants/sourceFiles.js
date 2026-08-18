// 本门禁的源文件口径 —— 哪些文件算生产源码、它们的路径按什么写法示人。
// ---------------------------------------------------------------------------
// 三条规则都在同一份文件清单上跑，口径只在这里定义一次；改「测试脚手架算不算源码」这类判据
// 只需要动这一个文件。

import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

const sourceFilePattern = /\.(?:ts|tsx)$/
// 与 check-boundaries 同口径：测试脚手架不是生产代码。
const testFilePattern = /\.(?:test|testHarness|testFixtures|fixtures)\.(?:ts|tsx)$/

export async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
    .catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await typescriptFiles(path))
    else if (entry.isFile() && sourceFilePattern.test(entry.name) && !testFilePattern.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

export function relativePath(repositoryRoot, path) {
  return relative(repositoryRoot, path).split(sep).join('/')
}
