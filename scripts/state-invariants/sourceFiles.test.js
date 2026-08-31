// 扫描面的自测 —— 收窄扫描面必须是「少扫编译产物」，不能顺手少扫真源码。
// ---------------------------------------------------------------------------
// 为什么值得一个测试文件：五条规则（derivedPurity / writeChokepoint / slotJournalShape /
// atomDisposition / agentStoreBinding）共用这一份文件清单，**少扫一批文件时它们只是判得更少，
// 门禁照样绿**。所以「扫描面变窄」这件事本身没有症状，只能靠断言来拦。
//
// 本卡就现场翻过一次车：第一版把「分组成员」判成「有 package.json 的目录」，而 `apps/web`
// 没有 package.json（它是 Vite 的 app root，包身份挂在仓库根），165 个 UI 文件 —— 包括规则 5
// 的头号案发现场 UndoBar.tsx —— 一声不响地掉出扫描面，`pnpm check:state` 依旧全绿。
// 下面第一组用例就是为这次翻车立的。

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it as test } from 'vitest'
import { governedSourceFiles, relativePath, sourceRoots } from './sourceFiles.js'
import { SOURCE_DIRECTORY, SOURCE_ROOTS_WITHOUT_TYPESCRIPT, WORKSPACE_GROUPS } from './sourceScopeTable.js'

const repositoryRoot = process.cwd()

async function scan() {
  const { files, roots } = await governedSourceFiles(repositoryRoot)
  return { paths: files.map((file) => relativePath(repositoryRoot, file)), roots }
}

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'state-scan-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

// —— 仍然扫得到：收窄之后真源码一个都不能少 ——————————————————————————————

test('关键文件仍在扫描面里（掉出去 = 对应规则静默失效）', async () => {
  const { paths } = await scan()
  // MessageList 读取多个会话 atom，能证明没有 package.json 的 apps/web 仍在 agent-store 规则扫描面内。
  expect(paths).toContain('apps/web/src/agentNew/ui/MessageList.tsx')
  // sessionSlots.ts：规则 3 拿它核对「登记为增量的槽位真的传了 registrar」。
  expect(paths).toContain('packages/agent-core/src/state/sessionSlots.ts')
  // 规则 4 的枚举面本体。
  expect(paths).toContain('packages/agent-core/src/state/sessionAtoms.ts')
})

test('三个分组各自都有文件进扫描面', async () => {
  const { paths } = await scan()
  for (const group of WORKSPACE_GROUPS) {
    expect(paths.some((path) => path.startsWith(`${group}/`))).toBe(true)
  }
})

test('每个带 src/ 的分组成员都进了白名单，且各自至少扫到一个文件', async () => {
  const { paths, roots } = await scan()
  expect(Object.keys(SOURCE_ROOTS_WITHOUT_TYPESCRIPT)).toEqual(['apps/desktop/src'])
  // 独立重算一遍「该扫哪些根」：不复用被测模块的枚举，否则它漏了谁这里也跟着漏。
  const { readdir, stat } = await import('node:fs/promises')
  const expected = []
  for (const group of WORKSPACE_GROUPS) {
    const entries = await readdir(resolve(repositoryRoot, group), { withFileTypes: true })
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = `${group}/${entry.name}/${SOURCE_DIRECTORY}`
      const found = await stat(resolve(repositoryRoot, source)).then(() => true, () => false)
      if (found && !Object.hasOwn(SOURCE_ROOTS_WITHOUT_TYPESCRIPT, source)) expected.push(source)
    }
  }
  expect(roots).toEqual(expected)
  for (const root of roots) expect(paths.some((path) => path.startsWith(`${root}/`))).toBe(true)
})

// —— 不再扫：编译产物与非源码 ——————————————————————————————————————————

test('编译产物与非源码不进扫描面', async () => {
  const { paths } = await scan()
  // dist/：跑过 pnpm build 才存在，扫它等于让门禁结论取决于本地有没有 build 过。
  expect(paths.filter((path) => path.includes('/dist/'))).toEqual([])
  expect(paths.filter((path) => path.includes('/node_modules/'))).toEqual([])
  // .d.ts：没有可执行代码，承载不了任何一条判据。
  expect(paths.filter((path) => path.endsWith('.d.ts'))).toEqual([])
  // 测试脚手架仍按老口径排除。
  expect(paths.filter((path) => /\.(?:test|testHarness|testFixtures|fixtures)\.tsx?$/.test(path))).toEqual([])
  // 白名单是 `<成员>/src`，别的位置（tsup.config.ts 之类）不该混进来。
  expect(paths.every((path) => /^[^/]+\/[^/]+\/src\//.test(path))).toBe(true)
})

// —— 两道闸：白名单写漏了要响亮地失败 ————————————————————————————————

test('源文件落在白名单之外时必须抛错，而不是静默少扫', async () => {
  const root = await fixture({
    'packages/kept/src/index.ts': 'export const kept = 1\n',
    'apps/stray/lib/stray.ts': 'export const stray = 1\n',
  })
  await expect(governedSourceFiles(root)).rejects.toThrow(/扫描白名单之外/)
})

test('登记过的白名单外文件名（tsup.config.ts）不算漏', async () => {
  const root = await fixture({
    'packages/kept/src/index.ts': 'export const kept = 1\n',
    'packages/kept/tsup.config.ts': 'export default {}\n',
  })
  const { files } = await governedSourceFiles(root)
  expect(files.map((file) => relativePath(root, file))).toEqual(['packages/kept/src/index.ts'])
})

test('工作区成员没有 src/ 时必须抛错', async () => {
  const root = await fixture({
    'packages/odd/package.json': '{"name":"odd"}\n',
    'packages/odd/lib/index.js': 'module.exports = {}\n',
  })
  await expect(sourceRoots(root)).rejects.toThrow(/没有 src\//)
})

test('没有 package.json 也没有 src/ 的目录不算成员，但它下面的源码仍会被第一道闸抓住', async () => {
  const quiet = await fixture({ 'apps/assets/readme.md': '# 不是包\n' })
  await expect(sourceRoots(quiet)).resolves.toEqual([])
  const loud = await fixture({ 'apps/assets/thing.ts': 'export const thing = 1\n' })
  await expect(governedSourceFiles(loud)).rejects.toThrow(/扫描白名单之外/)
})

test('dist 与 node_modules 即便嵌在 src/ 里也被剪掉', async () => {
  const root = await fixture({
    'packages/kept/src/index.ts': 'export const kept = 1\n',
    'packages/kept/src/dist/generated.ts': 'export const generated = 1\n',
    'packages/kept/src/node_modules/dep/index.ts': 'export const dep = 1\n',
  })
  const { files } = await governedSourceFiles(root)
  expect(files.map((file) => relativePath(root, file))).toEqual(['packages/kept/src/index.ts'])
})
