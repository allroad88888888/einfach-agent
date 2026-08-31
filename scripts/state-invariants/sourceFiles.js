// 本门禁的源文件口径 —— 哪些文件算生产源码、它们的路径按什么写法示人。
// ---------------------------------------------------------------------------
// 五条规则都在同一份文件清单上跑，口径只在这里定义一次；改「测试脚手架算不算源码」这类判据
// 只需要动这一个文件（具体的根与排除项在 sourceScopeTable.js，表与判定分家）。
//
// 扫描面是**白名单**：`<分组>/<成员>/src`，分组见表里的 WORKSPACE_GROUPS。黑名单（dist /
// node_modules / .d.ts）只是兜底。收窄之前这里扫的是 `packages` / `tools` / `apps` **整棵树**，
// 于是本地跑过 `pnpm build` 之后 `packages/*/dist/**` 里 600 多个编译产物 `.d.ts` 也在扫描面里；
// CI 因为门禁排在 build 之前恰好扫不到，所以一直没有症状 —— 但「门禁扫什么」取决于本地有没有
// build 过，本身就是错的。
//
// **漏判会怎样**：五条规则共用这份清单，少扫一批文件时它们只是判得更少，门禁**照样绿**。
// 所以这里把「少扫」全部做成响亮的失败，两道闸：
//   1. 分组树里出现在白名单之外的非测试源文件 → 抛错（未登记时）。白名单写漏一个根，
//      由「有源文件没人扫」当场喊出来，不指望人记得。第一版把成员判成「有 package.json 的
//      目录」，`apps/web` 没有 package.json，165 个 UI 文件（含 UndoBar.tsx）静默出局；
//      有这道闸就不会只靠人工数文件才发现。
//   2. 有 package.json 却没有 src/ 的成员 → 抛错（未登记时）。
// 两道闸都经 check-state-invariants.js 的 catch 变成非零退出；根的**条数**也回给入口打印，
// 掉了一个根在门禁输出里就是可见的。

import { readdir, stat } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import {
  EXCLUDED_DIRECTORY_NAMES,
  EXCLUDED_FILE_SUFFIXES,
  MEMBERS_WITHOUT_SOURCE_DIRECTORY,
  SOURCE_DIRECTORY,
  SOURCE_ROOTS_WITHOUT_TYPESCRIPT,
  SOURCE_FILE_BASENAMES_OUTSIDE_ROOTS,
  SOURCE_FILE_PATTERN,
  TEST_FILE_PATTERN,
  WORKSPACE_GROUPS,
} from './sourceScopeTable.js'

async function directoryEntries(directory) {
  return readdir(directory, { withFileTypes: true })
    .catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
}

async function pathExists(path) {
  return stat(path).then(() => true, (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)))
}

function isSourceFile(name) {
  if (!SOURCE_FILE_PATTERN.test(name) || TEST_FILE_PATTERN.test(name)) return false
  return !EXCLUDED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

// 黑名单目录名在这里剪枝；返回该子树下所有非测试 TS/TSX 源文件。
async function typescriptFiles(directory) {
  const entries = await directoryEntries(directory)
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.includes(entry.name)) continue
      files.push(...await typescriptFiles(path))
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      files.push(path)
    }
  }
  return files
}

async function memberDirectories(repositoryRoot, group) {
  const entries = await directoryEntries(resolve(repositoryRoot, group))
  return entries
    .filter((entry) => entry.isDirectory() && !EXCLUDED_DIRECTORY_NAMES.includes(entry.name))
    .map((entry) => `${group}/${entry.name}`)
    .sort()
}

// 白名单：每个分组成员的 `src/`。返回仓库相对路径，顺序稳定（分组顺序 × 目录名字典序）。
export async function sourceRoots(repositoryRoot) {
  const roots = []
  const missing = []
  for (const group of WORKSPACE_GROUPS) {
    for (const member of await memberDirectories(repositoryRoot, group)) {
      const sourceRoot = `${member}/${SOURCE_DIRECTORY}`
      if (await pathExists(resolve(repositoryRoot, sourceRoot))) {
        if (!Object.hasOwn(SOURCE_ROOTS_WITHOUT_TYPESCRIPT, sourceRoot)) roots.push(sourceRoot)
        continue
      }
      // 没有 src/ 又没有 package.json 的目录不是包（散放的资源、产物目录），不算漏；
      // 真有源码住在里面时会被第 1 道闸抓住。
      if (!await pathExists(resolve(repositoryRoot, member, 'package.json'))) continue
      if (!MEMBERS_WITHOUT_SOURCE_DIRECTORY.includes(member)) missing.push(member)
    }
  }
  if (missing.length > 0) {
    // 静默跳过等于「这个包没有源码」，五条规则会少判一整个包却依旧绿。
    throw new Error(
      `工作区成员没有 ${SOURCE_DIRECTORY}/，扫描面无法确定：${missing.join('、')}`
      + `（源码若确实不在 ${SOURCE_DIRECTORY}/ 下，登记进 sourceScopeTable.js 的`
      + ' MEMBERS_WITHOUT_SOURCE_DIRECTORY 并写明理由）',
    )
  }
  return roots
}

function assertNoSourceOutsideRoots(repositoryRoot, roots, candidates) {
  const strays = candidates
    .map((path) => relativePath(repositoryRoot, path))
    .filter((path) => !roots.some((root) => path.startsWith(`${root}/`)))
    .filter((path) => !SOURCE_FILE_BASENAMES_OUTSIDE_ROOTS.includes(basename(path)))
  if (strays.length === 0) return
  // 白名单漏了一个根时，症状就是「这些文件没人扫」——不喊出来就没有任何症状。
  throw new Error(
    `有源文件落在扫描白名单之外（共 ${strays.length} 个）：${strays.slice(0, 5).join('、')}`
    + `${strays.length > 5 ? ' …' : ''}（要么它所在的根该进白名单，要么把文件名登记进`
    + ' sourceScopeTable.js 的 SOURCE_FILE_BASENAMES_OUTSIDE_ROOTS 并写明理由）',
  )
}

// 门禁的完整扫描面。`roots` 一并回给调用方，好让「扫了几个根」出现在门禁输出里。
export async function governedSourceFiles(repositoryRoot) {
  const roots = await sourceRoots(repositoryRoot)
  // 分组树只走一遍：白名单内的进扫描面，白名单外的交给第 1 道闸定罪。
  const candidates = (await Promise.all(
    WORKSPACE_GROUPS.map((group) => typescriptFiles(resolve(repositoryRoot, group))),
  )).flat()
  assertNoSourceOutsideRoots(repositoryRoot, roots, candidates)
  const rootPrefixes = roots.map((root) => resolve(repositoryRoot, root) + sep)
  const files = candidates.filter((path) => rootPrefixes.some((prefix) => path.startsWith(prefix)))
  return { files, roots }
}

export function relativePath(repositoryRoot, path) {
  return relative(repositoryRoot, path).split(sep).join('/')
}
