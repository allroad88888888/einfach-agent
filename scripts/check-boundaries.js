#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootArgument = process.argv.indexOf('--root')
const repositoryRoot = rootArgument === -1 ? defaultRoot : resolve(process.argv[rootArgument + 1] ?? '')
const sourceFilePattern = /\.(?:ts|tsx)$/
// 测试脚手架同 .test.ts 一样不属于生产代码：testHarness/testFixtures 只被测试文件 import，
// 里面的能力包引用与厂商名是测试夹具语义，不构成 core 的运行时依赖承诺。
const testFilePattern = /\.(?:test|testHarness|testFixtures)\.(?:ts|tsx)$/
const importPatterns = [
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // 跨行 import/export 的收尾行（`} from '...'`）——整条语句里唯一带说明符的那一行，上面三条
  // 单行正则都够不着它。少了这条，任何写成多行花括号的深导入都能绕过 S9 的公开面白名单门禁
  // （实测 core 之外的 `@web-agent/core/*` 深导入有近半是这种写法）。
  /^\s*\}\s*from\s+['"]([^'"]+)['"]/g,
]
const coreRules = [
  { name: 'core 禁入 React', packages: ['react', '@einfach/react'] },
  { name: 'core 禁入工具域', matches: (value) => value === '@web-agent/tools' || value.startsWith('@web-agent/tools-') },
  {
    name: 'core 禁入能力包',
    packages: [
      '@web-agent/subagents', '@web-agent/persistence-idb', '@web-agent/persistence-sqlite',
      '@web-agent/observability-idb', '@web-agent/observability-sqlite',
      // host-node 是 core 命令桥的一种实现。core 反过来引它 = 把「宿主是什么」重新焊回 core，
      // 正是 H 线（configureHostInvoke）拆掉的那件事。
      '@web-agent/host-node',
    ],
  },
  { name: 'core 禁入 Tauri SQL 插件', packages: ['@tauri-apps/plugin-sql'] },
]
const capabilityRule = {
  name: '能力包禁入工具域',
  matches: (value) => value === '@web-agent/tools' || value.startsWith('@web-agent/tools-'),
}
const dialogObservation = { name: '观察项：core 使用 Tauri dialog 插件', packages: ['@tauri-apps/plugin-dialog'] }
const capabilityPackages = ['subagents', 'persistence-idb', 'persistence-sqlite', 'observability-idb', 'observability-sqlite', 'host-node']
const workspaceGroups = ['apps', 'packages', 'tools']

// M4：core 厂商名红线，对齐 einfach-agent-rust 红线 12（core 零厂商判断）。与上面的 import 扫描不同，
// 这条规则扫的是整行文本字面量（含注释），因为「注释里顺嘴提厂商名」同样是本卡要收敛的对象。
const vendorNameRuleName = 'core 厂商名红线'
const vendorNames = ['deepseek', 'glm', 'kimi', 'moonshot', 'zhipu', 'openai', 'anthropic', 'gemini']
// `\b` 词边界把 `_` 算作单词字符，snake_case 里内嵌的厂商名（如 `non_deepseek_provider`）因此
// 逃过匹配——`deepseek` 两侧都挨着 `_`，判定成"词中间"而不是"词边界"。改用手写环视：前后不允许
// 紧跟字母或数字（不含下划线），`_deepseek_`／`deepseekClient` 都会命中，只有真正被字母数字
// 直接拼接的情况（如子串 `deepseeker`）才继续放行。
const vendorNamePattern = new RegExp(`(?<![A-Za-z0-9])(${vendorNames.join('|')})(?![A-Za-z0-9])`, 'i')
const coreSourceDirectory = 'packages/agent-core/src'
// 豁免清单：路径相对 packages/agent-core/src；命中时降级为观察项而不是 fail。每项必须写明原因，
// 不允许空口白牌。前 6 项是 M4 卡判据里明确点名的既定豁免；其余是本卡实现时跑一遍脚本、
// 人工核实后新增的既有命中（详情见对应 issue 卡与提交说明）。
const vendorNameExemptions = [
  { path: 'state/persistence/modelMigration.ts', reason: '历史迁移必须认识旧厂商模型名' },
  // M9 落地后删除的 7 项：`state/core.type.ts` 的闭合 union 换成「不透明 vendor id + 供应商
  // 附加设置袋」，按它派生的 4 处收窄分支与 3 份测试夹具随之不再需要厂商名。
  // M7 落地后删除的 5 项：运行时调用方标识改名为中立的 `modelUserId`（`runtime/core/
  // runtimeConfig.ts`、`runtime/delegationContract.ts`、`subagents/runtimeState.ts`、
  // `subagents/childModelClient.ts`），只做名字转接的 `runtime/core/delegateModelIdentity.ts`
  // 随之删除。
]

// S9：core 公开面白名单门禁。core 之外的包与 apps 只能经这九条入口进 core——根 barrel
// `@web-agent/core` 本身（下面用 `subpath === ''` 表示）加八条 subpath。判据与逐条归属见
// docs/core-public-surface-audit.md §4，落地状态见 docs/core-surface-issues.md 的 S1–S8 卡。
// **精确匹配，不是段前缀**：段前缀会让 `tools/registry`、`subagents/childAgentLoop` 这类深路径
// 借白名单第一段蒙混过关，而它们恰恰是本规则要收敛的对象（前者已在本卡消掉，后者留豁免待 S11）。
const corePackageName = '@web-agent/core'
const coreSubpathRuleName = 'core 公开面白名单'
const coreSubpathAllowList = [
  '', 'plugin', 'timeline', 'tools', 'subagents', 'state/persistence', 'observability', 'skills', 'planning',
]
// 白名单外的既有命中：命中时降级为观察项而不是 fail。每条写明原因与归属卡，`consumers` 是
// 消费方路径前缀（仓库相对、`/` 分隔）——豁免按「哪条 subpath × 谁在用」发放，换个消费方仍会红。
const coreSubpathExemptions = [
  {
    subpaths: ['runtime/workspaceRead'],
    consumers: ['apps/web/src/plugins/'],
    reason: 'desktopImportModule 测试的精确 vi.mock 目标；改成 barrel 会使该局部 mock 失效，生产读取面不借此深路径',
  },
  {
    subpaths: ['runtime/core/coreInstance', 'state/rootStore'],
    consumers: ['apps/web/src/test/setup.ts'],
    reason: 'vitest setupFile 不能走根 barrel——barrel 会在各测试文件 vi.mock 提升前把 runtime/commands 整条静态导链灌进模块缓存（S5b 记档，文件内有【setupFile 纪律】注释）',
  },
]

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await typescriptFiles(path))
    else if (entry.isFile() && sourceFilePattern.test(entry.name) && !testFilePattern.test(entry.name)) files.push(path)
  }
  return files
}

function importsInLine(line) {
  if (/^\s*(?:\/\/|\*)/.test(line)) return []
  const imports = []
  for (const pattern of importPatterns) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) imports.push(match[1])
  }
  return imports
}

function matches(rule, packageName) {
  return rule.packages?.includes(packageName) ?? rule.matches(packageName)
}

function relativePath(path) {
  return relative(repositoryRoot, path).split(sep).join('/')
}

function vendorNameExemptionFor(relativeCorePath) {
  return vendorNameExemptions.find((item) => item.path === relativeCorePath)
}

async function checkVendorNames(files, errors, observations) {
  const coreRoot = resolve(repositoryRoot, coreSourceDirectory)
  for (const path of files) {
    const exemption = vendorNameExemptionFor(relative(coreRoot, path).split(sep).join('/'))
    const lines = (await readFile(path, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      const match = vendorNamePattern.exec(line)
      if (!match) continue
      const location = `${relativePath(path)}:${index + 1}`
      if (exemption) observations.push(`${location} 观察项：${vendorNameRuleName}（${match[1]}）—— 豁免原因：${exemption.reason}`)
      else errors.push(`${location} ${vendorNameRuleName}（${match[1]}）`)
    }
  }
}

function coreSubpathOf(specifier) {
  if (specifier === corePackageName) return ''
  return specifier.startsWith(`${corePackageName}/`) ? specifier.slice(corePackageName.length + 1) : undefined
}

function coreSubpathExemptionFor(subpath, relativeFilePath) {
  return coreSubpathExemptions.find((item) => (
    item.subpaths.includes(subpath) && item.consumers.some((prefix) => relativeFilePath.startsWith(prefix))
  ))
}

async function checkCoreSubpaths(files, errors, observations) {
  for (const path of files) {
    const file = relativePath(path)
    const lines = (await readFile(path, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      for (const specifier of importsInLine(line)) {
        const subpath = coreSubpathOf(specifier)
        if (subpath === undefined || coreSubpathAllowList.includes(subpath)) continue
        const location = `${file}:${index + 1}`
        const exemption = coreSubpathExemptionFor(subpath, file)
        if (exemption) observations.push(`${location} 观察项：${coreSubpathRuleName}（${specifier}）—— 豁免原因：${exemption.reason}`)
        else errors.push(`${location} ${coreSubpathRuleName}（${specifier} 不在白名单九条内）`)
      }
    }
  }
}

async function checkFiles(files, rules, errors, observations) {
  for (const path of files) {
    const lines = (await readFile(path, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      for (const packageName of importsInLine(line)) {
        for (const rule of rules) {
          if (matches(rule, packageName)) errors.push(`${relativePath(path)}:${index + 1} ${rule.name}`)
        }
        if (matches(dialogObservation, packageName)) observations.push(`${relativePath(path)}:${index + 1} ${dialogObservation.name}`)
      }
    }
  }
}

// 白名单门禁的扫描面：`apps/*/src`、`packages/*/src`、`tools/*/src` 里除 core 自己以外的全部
// 非测试源码——文件枚举沿用 typescriptFiles()，测试与 testHarness/testFixtures 脚手架已被它跳过。
async function outsideCoreFiles() {
  const files = []
  for (const group of workspaceGroups) {
    const entries = await readdir(resolve(repositoryRoot, group), { withFileTypes: true })
      .catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sourceDirectory = `${group}/${entry.name}/src`
      if (sourceDirectory === coreSourceDirectory) continue
      files.push(...await typescriptFiles(resolve(repositoryRoot, sourceDirectory)))
    }
  }
  return files
}

async function main() {
  const coreFiles = await typescriptFiles(resolve(repositoryRoot, coreSourceDirectory))
  const capabilityFiles = (await Promise.all(capabilityPackages.map((name) => (
    typescriptFiles(resolve(repositoryRoot, `packages/${name}/src`))
  )))).flat()
  const consumerFiles = await outsideCoreFiles()
  const errors = []
  const observations = []
  await checkFiles(coreFiles, coreRules, errors, observations)
  await checkFiles(capabilityFiles, [capabilityRule], errors, observations)
  await checkVendorNames(coreFiles, errors, observations)
  await checkCoreSubpaths(consumerFiles, errors, observations)
  const scanned = new Set([...coreFiles, ...capabilityFiles, ...consumerFiles]).size
  if (observations.length > 0) {
    console.log('边界观察项：')
    for (const observation of observations) console.log(`- ${observation}`)
  }
  if (errors.length > 0) {
    console.error('边界检查失败：')
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`边界检查通过（扫描 ${scanned} 个非测试 TS/TSX 文件，生效 ${coreRules.length + 3} 条规则）。`)
  console.log('说明：import 类规则仅跳过以 // 或 * 开头的整行注释，不解析行内注释；跨行语句只认 `} from \'…\'` 收尾行；')
  console.log('厂商名红线逐行做字面量扫描，含注释在内，因为注释里的厂商名同样是本规则要收敛的对象；')
  console.log('公开面白名单对 @web-agent/core 的 subpath 做精确匹配，白名单外只有豁免表里的既有命中会降级为观察项。')
}

main().catch((error) => {
  console.error(`边界检查失败：${error.message}`)
  process.exitCode = 1
})
