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
  const coreFiles = await typescriptFiles(resolve(repositoryRoot, 'packages/agent-core/src'))
  const capabilityFiles = (await Promise.all(capabilityPackages.map((name) => (
    typescriptFiles(resolve(repositoryRoot, `packages/${name}/src`))
  )))).flat()
  const errors = []
  const observations = []
  await checkFiles(coreFiles, coreRules, errors, observations)
  await checkFiles(capabilityFiles, [capabilityRule], errors, observations)
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
  console.log(`边界检查通过（扫描 ${scanned} 个非测试 TS/TSX 文件，生效 ${coreRules.length + 1} 条规则）。`)
  console.log('说明：仅跳过以 // 或 * 开头的整行注释；不解析行内注释或跨行语句。')
}

main().catch((error) => {
  console.error(`边界检查失败：${error.message}`)
  process.exitCode = 1
})
