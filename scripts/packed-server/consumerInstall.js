// 把仓库里的发布闭包变成「仓库外一个装好的 npm 消费方目录」
// ---------------------------------------------------------------------------
// 这个文件只负责一件事：**产出真实用户会拿到的那份东西，并把它装到仓库以外**。
// 起不起服务、验什么，都不在这里（见 serverProcess.js 与 check-packed-server.js）。
//
// 【为什么必须是 pnpm pack，不能是 npm pack】
// `npm pack` 把 `workspace:*` **原样**留在 dependencies 里，那不是合法 semver，装不上
// （D2 实测）。`pnpm pack` 会改写成真实版本号。`scripts/check-dist.js` 走的是另一条路
// （npm pack 之后自己改写 manifest 再 repack），那是因为它要顺带做「导出面」的负向实验；
// 这条门禁要的是**发布路径原样**，所以直接用发布流水线用的那一个命令。
//
// 【为什么用 npm install 而不是 pnpm install】
// pnpm 的工作区符号链接会让「装上去能跑」在还没离开仓库时就成立，验不出真实用户那条路径。
// 同 `.github/workflows/release-npm.yml` 里那段 smoke 的理由。
//
// 【为什么闭包不手抄包名】
// `@einfach-agent/server...` 让 pnpm 自己算递归依赖，加删依赖时不会漂移。当前它算出四个：
// `@einfach-agent/{server,core,ai,host-node}`。

import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const execFile = promisify(execFileCallback)

/** 发布闭包的过滤器。与 `.github/workflows/release-npm.yml` 的 `RELEASE_FILTER` 逐字相同。 */
export const RELEASE_FILTER = '@einfach-agent/server...'

/** tarball 的文件名规则（npm/pnpm 共用）：`@scope/name` + version → `scope-name-version.tgz`。 */
function tarballName(name, version) {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
}

async function run(file, args, cwd) {
  return execFile(file, args, { cwd, maxBuffer: 64 * 1024 * 1024 })
}

/** 跑一步并记一笔耗时。耗时是本卡的交付物之一（放 CI 哪一环要靠它判断）。 */
async function step(timings, label, body) {
  const startedAt = Date.now()
  process.stdout.write(`· ${label} …\n`)
  const value = await body()
  const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1))
  timings.push({ label, seconds })
  process.stdout.write(`  ${label}：${seconds}s\n`)
  return value
}

/**
 * `pnpm build` → `pnpm -r build`。
 *
 * **顺序不能倒**：`apps/server` 的 build 末尾要把 `apps/web/dist` 嵌进自己的 `dist/public`，
 * 那份前端产物由 `pnpm build` 里的 `vite build` 产出；反过来先跑 `pnpm -r build`，
 * 在全新 checkout 上直接失败（D3 实测）。
 */
async function buildReleaseArtifacts(repositoryRoot, timings) {
  await step(timings, 'pnpm build', () => run('pnpm', ['build'], repositoryRoot))
  await step(timings, 'pnpm -r build', () => run('pnpm', ['-r', 'build'], repositoryRoot))
}

/** 跳过构建时至少确认产物在——否则「装上去能跑」验的是一份可能根本不存在的产物。 */
function assertBuiltArtifactsExist(repositoryRoot) {
  const entry = join(repositoryRoot, 'apps/server/dist/main.js')
  if (existsSync(entry)) return
  throw new Error(
    `跳过了构建，但 ${entry} 不存在。这条门禁验的是打包产物，没有产物就没有可验的东西：` +
      '先跑 `pnpm build && pnpm -r build`，或者不要设 PACKED_SERVER_SKIP_BUILD=1。',
  )
}

/** 问 pnpm 要发布闭包（名字、版本、目录）。 */
async function resolveReleaseClosure(repositoryRoot) {
  const { stdout } = await run(
    'pnpm',
    ['-r', '--filter', RELEASE_FILTER, 'list', '--depth', '-1', '--json'],
    repositoryRoot,
  )
  const closure = JSON.parse(stdout)
  if (!Array.isArray(closure) || closure.length === 0) {
    throw new Error(`发布闭包解析为空，过滤器：${RELEASE_FILTER}`)
  }
  return closure
}

/** 逐个 `pnpm pack` 到同一个目录，返回 `{ name, tarball }`。 */
async function packReleaseClosure(closure, tarballDirectory) {
  await mkdir(tarballDirectory, { recursive: true })
  const packed = []
  for (const item of closure) {
    await run('pnpm', ['pack', '--pack-destination', tarballDirectory], item.path)
    const tarball = join(tarballDirectory, tarballName(item.name, item.version))
    if (!existsSync(tarball)) throw new Error(`pnpm pack 没有产出预期的 tarball：${tarball}`)
    packed.push({ name: item.name, tarball })
  }
  return packed
}

/**
 * 在**仓库外**建一个消费方目录并 `npm install` 那几个 tarball。
 *
 * `--ignore-scripts`：闭包里没有安装脚本，关掉它顺带保证「装的过程不会偷偷编译点什么」。
 */
async function installConsumer(packed, consumerDirectory) {
  await mkdir(consumerDirectory, { recursive: true })
  const dependencies = Object.fromEntries(packed.map((item) => [item.name, `file:${item.tarball}`]))
  const manifest = {
    name: 'packed-server-gate-consumer',
    private: true,
    version: '0.0.0',
    dependencies,
  }
  await writeFile(join(consumerDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'],
    consumerDirectory,
  )
  const binary = join(consumerDirectory, 'node_modules/.bin/einfach-agent')
  if (!existsSync(binary)) {
    throw new Error(`装完之后没有可执行入口：${binary}（apps/server 的 bin 字段坏了？）`)
  }
  return binary
}

/** 一次跑完：构建（可跳过）→ pack 闭包 → 仓库外 npm install。返回可执行入口与分步耗时。 */
export async function prepareConsumer({ repositoryRoot, temporaryRoot, build }) {
  const timings = []
  if (build) await buildReleaseArtifacts(repositoryRoot, timings)
  else assertBuiltArtifactsExist(repositoryRoot)

  const closure = await step(timings, '解析发布闭包', () => resolveReleaseClosure(repositoryRoot))
  process.stdout.write(`  闭包：${closure.map((item) => item.name).join(', ')}\n`)

  const tarballDirectory = join(temporaryRoot, 'tarballs')
  const packed = await step(timings, 'pnpm pack 发布闭包', () =>
    packReleaseClosure(closure, tarballDirectory))

  const consumerDirectory = join(temporaryRoot, 'consumer')
  const binary = await step(timings, '仓库外 npm install', () =>
    installConsumer(packed, consumerDirectory))

  return { binary, consumerDirectory, closure, timings }
}
