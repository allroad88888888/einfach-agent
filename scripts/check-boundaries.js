#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootArgument = process.argv.indexOf('--root')
const repositoryRoot = rootArgument === -1 ? defaultRoot : resolve(process.argv[rootArgument + 1] ?? '')
const sourceFilePattern = /\.(?:ts|tsx)$/
const testFilePattern = /\.test\.(?:ts|tsx)$/
const importPatterns = [
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]
const coreRules = [
  { name: 'core 禁入 React', packages: ['react', '@einfach/react'] },
  { name: 'core 禁入工具域', matches: (value) => value === '@web-agent/tools' || value.startsWith('@web-agent/tools-') },
  {
    name: 'core 禁入能力包',
    packages: [
      '@web-agent/subagents', '@web-agent/persistence-idb', '@web-agent/persistence-sqlite',
      '@web-agent/observability-idb', '@web-agent/observability-sqlite',
    ],
  },
  { name: 'core 禁入 Tauri SQL 插件', packages: ['@tauri-apps/plugin-sql'] },
]
const capabilityRule = {
  name: '能力包禁入工具域',
  matches: (value) => value === '@web-agent/tools' || value.startsWith('@web-agent/tools-'),
}
const dialogObservation = { name: '观察项：core 使用 Tauri dialog 插件', packages: ['@tauri-apps/plugin-dialog'] }
const capabilityPackages = ['subagents', 'persistence-idb', 'persistence-sqlite', 'observability-idb', 'observability-sqlite']

// M4：core 厂商名红线，对齐 einfach-agent-rust 红线 12（core 零厂商判断）。与上面的 import 扫描不同，
// 这条规则扫的是整行文本字面量（含注释），因为「注释里顺嘴提厂商名」同样是本卡要收敛的对象。
const vendorNameRuleName = 'core 厂商名红线'
const vendorNames = ['deepseek', 'glm', 'kimi', 'moonshot', 'zhipu', 'openai', 'anthropic', 'gemini']
const vendorNamePattern = new RegExp(`\\b(${vendorNames.join('|')})\\b`, 'i')
const coreSourceDirectory = 'packages/agent-core/src'
// 豁免清单：路径相对 packages/agent-core/src；命中时降级为观察项而不是 fail。每项必须写明原因，
// 不允许空口白牌。前 6 项是 M4 卡判据里明确点名的既定豁免；其余是本卡实现时跑一遍脚本、
// 人工核实后新增的既有命中（详情见对应 issue 卡与提交说明）。
const vendorNameExemptions = [
  { path: 'state/persistence/modelMigration.ts', reason: '历史迁移必须认识旧厂商模型名' },
  { path: 'subagents/modelSelection.ts', reason: '子 agent 档位路由，待 M6a/M6b 迁出为可注入档位表' },
  { path: 'subagents/childModelClient.ts', reason: '子 agent 档位路由，待 M6a/M6b 迁出为可注入档位表' },
  { path: 'subagents/defaultTierRouting.ts', reason: 'M6a 落地的默认档位路由表常量；文件自身注明这是 core 内唯一厂商模型名，待 M6b 整体搬到装配层' },
  { path: 'runtime/core/runtimeConfig.ts', reason: 'deepseekUserId 字段，待 M7 去专名化' },
  { path: 'runtime/delegationContract.ts', reason: 'deepseekUserId 字段，待 M7 去专名化' },
  { path: 'runtime/core/delegateModelIdentity.ts', reason: 'deepseekUserId 字段，待 M7 去专名化' },
  { path: 'subagents/runtimeState.ts', reason: 'deepseekUserId 字段，待 M7 去专名化（M4 卡原始豁免清单遗漏，本次核实后补齐）' },
  {
    path: 'state/core.type.ts',
    reason: 'ModelVendor/ModelSettings 是按厂商判别的闭合 union，是 core 内厂商名的根源；M 线暂无对应卡号收敛，本次核实新发现，建议后续开新卡',
  },
  { path: 'runtime/modelSettingsProjection.ts', reason: '按 core.type.ts 的 vendor 判别式收窄采样参数支持面；根因同上，暂无对应卡号' },
  { path: 'runtime/contextDistillation.ts', reason: '摘要请求按 vendor 判别式跳过 kimi 的 temperature；根因同上，暂无对应卡号' },
  { path: 'runtime/commands/sessionCommands.ts', reason: '新会话缺省 vendor 硬编码为 deepseek；根因同上，暂无对应卡号' },
  { path: 'runtime/contextCache.testFixtures.ts', reason: '测试夹具需要具体 vendor 字面量才能构造合法 ModelSettings；根因同上' },
  { path: 'runtime/toolAvailability.testFixtures.ts', reason: '测试夹具需要具体 vendor 字面量才能构造合法 ModelSettings；根因同上' },
  { path: 'runtime/toolCallBatch.authorization.testFixtures.ts', reason: '测试夹具需要具体 vendor 字面量才能构造合法 ModelSettings；根因同上' },
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

async function main() {
  const coreFiles = await typescriptFiles(resolve(repositoryRoot, coreSourceDirectory))
  const capabilityFiles = (await Promise.all(capabilityPackages.map((name) => (
    typescriptFiles(resolve(repositoryRoot, `packages/${name}/src`))
  )))).flat()
  const errors = []
  const observations = []
  await checkFiles(coreFiles, coreRules, errors, observations)
  await checkFiles(capabilityFiles, [capabilityRule], errors, observations)
  await checkVendorNames(coreFiles, errors, observations)
  const scanned = coreFiles.length + capabilityFiles.length
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
  console.log(`边界检查通过（扫描 ${scanned} 个非测试 TS/TSX 文件，生效 ${coreRules.length + 2} 条规则）。`)
  console.log('说明：import 类规则仅跳过以 // 或 * 开头的整行注释，不解析行内注释或跨行语句；')
  console.log('厂商名红线逐行做字面量扫描，含注释在内，因为注释里的厂商名同样是本规则要收敛的对象。')
}

main().catch((error) => {
  console.error(`边界检查失败：${error.message}`)
  process.exitCode = 1
})
