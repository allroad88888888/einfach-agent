#!/usr/bin/env node
// 给声明产物（dist/**/*.d.ts）里的**相对**模块说明符补上 `.js` 扩展名。
// ---------------------------------------------------------------------------
// 为什么需要：`tsc --emitDeclarationOnly` 原样保留源码里的无扩展名说明符
// （源码按 moduleResolution: bundler 写，`export * from './modelApi'` 合法），
// 但发布物的消费方若用 `moduleResolution: node16/nodenext`，解析这些说明符会直接报
// TS2834「Relative import paths need explicit file extensions」，barrel 上的 re-export
// 随之全灭（消费方只会看到一串 TS2305 has no exported member）。
//
// 为什么用后处理而不是改源码：把全仓源码的相对 import 改写成 `./x.js` 才是 TS 官方口径，
// 但那是几百个文件的改动面、且会和 Vite/Vitest 的 bundler 解析口径纠缠；后处理只作用于
// 发布物，源码与开发期解析口径不受影响。取舍记录见 docs/launch/npm-publish-plan.md。
//
// 硬约束：
// - 只动**相对**说明符（`.` 开头）。裸包名（`react`、`@einfach-agent/ai`）一律不碰。
// - 补什么扩展名**按 dist 实际文件系统判断**，不做字符串拼接：
//   `./x` 有同名 `x.d.ts` → `./x.js`；只有目录 `x/index.d.ts` → `./x/index.js`。
//   （多层包如 agent-core 会出现目录形态，扁平包如 agent-ai 只有文件形态。）
// - 幂等：已带 JS 类扩展名的说明符直接跳过，连跑两次 build 产物一致。
// - 解析不到的相对说明符 = 声明产物有洞，直接以非零码失败，不静默放过。
// - 零第三方依赖（纯 Node），不进 lockfile。
//
// 用法：node scripts/fix-dts-specifiers.mjs <distDir> [更多 distDir...]
// 包内接线：`"build": "tsup && tsc -p tsconfig.build.json && node ../../scripts/fix-dts-specifiers.mjs dist"`

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** 需要处理的声明文件后缀。仓库全量 ESM，实际只会出现 .d.ts，.d.mts 一并兜住。 */
const DECLARATION_SUFFIXES = ['.d.ts', '.d.mts']

/**
 * 已经带这些扩展名的说明符视为「写全了」，跳过——这是幂等性的唯一依据。
 * 注意不含 `.ts`：声明产物里不该出现指向 `.ts` 的说明符，出现了就该按解析失败暴露。
 */
const RESOLVED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.node']

/**
 * 待补扩展名的候选：按「先文件、后目录 index」的顺序试，命中即停。
 * 顺序对应 Node CJS / bundler 解析的优先级：`./x` 同时存在 x.d.ts 与 x/index.d.ts 时取前者。
 * declarationSuffix 是 dist 里实际存在的文件后缀，specifierSuffix 是写进说明符的运行时后缀
 * （类型解析时 TS 会自己把 `./x.js` 映射回 `./x.d.ts`，所以 dist 里没有同名 .js 也不影响；
 *  tsup 把 JS 打成单个 bundle，本来就不会有 modelApi.js 这种同名产物）。
 */
const SPECIFIER_CANDIDATES = [
  { declarationSuffix: '.d.ts', specifierSuffix: '.js' },
  { declarationSuffix: '.d.mts', specifierSuffix: '.mjs' },
  { declarationSuffix: '/index.d.ts', specifierSuffix: '/index.js' },
  { declarationSuffix: '/index.d.mts', specifierSuffix: '/index.mjs' },
]

/**
 * 覆盖声明产物里会出现的全部相对说明符形态。每条正则都锚定在语法关键字上，
 * 避免误伤恰好长得像路径的字符串字面量类型。
 * 捕获组固定为：1 = 关键字前缀，2 = 引号，3 = 说明符。
 */
const SPECIFIER_PATTERNS = [
  // `export * from './x'` / `export { A } from './x'` / `export type { A } from './x'`
  // / `export * as ns from './x'` / `import ... from './x'` / `import type ... from './x'`
  // 多行 import 也命中：`from './x'` 一定在同一行。
  /(\bfrom\s*)(['"])(\.[^'"]*)\2/g,
  // `import('./x').Foo` —— 类型位置的动态 import 引用。
  /(\bimport\s*\(\s*)(['"])(\.[^'"]*)\2/g,
  // `import './x';` —— 无绑定的副作用式导入。
  /(\bimport\s+)(['"])(\.[^'"]*)\2/g,
]

/** 递归收集目录下的声明文件绝对路径。 */
function collectDeclarationFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectDeclarationFiles(entryPath))
    } else if (DECLARATION_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      found.push(entryPath)
    }
  }
  return found
}

function isExistingFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 把一个相对说明符解析成带扩展名的形态。
 * @returns 补好扩展名的说明符；已带扩展名或解析不到时返回 null（调用方区分处理）。
 */
function resolveSpecifier(specifier, fromDir) {
  if (RESOLVED_EXTENSIONS.some((ext) => specifier.endsWith(ext))) return null
  for (const { declarationSuffix, specifierSuffix } of SPECIFIER_CANDIDATES) {
    if (isExistingFile(resolve(fromDir, specifier + declarationSuffix))) {
      return specifier + specifierSuffix
    }
  }
  return null
}

/**
 * 重写单个声明文件的内容。
 * @returns { content, rewrites, unresolved }
 */
function rewriteDeclaration(source, fromDir) {
  let rewrites = 0
  const unresolved = []
  let content = source
  for (const pattern of SPECIFIER_PATTERNS) {
    content = content.replace(pattern, (match, prefix, quote, specifier) => {
      if (RESOLVED_EXTENSIONS.some((ext) => specifier.endsWith(ext))) return match
      const resolved = resolveSpecifier(specifier, fromDir)
      if (!resolved) {
        unresolved.push(specifier)
        return match
      }
      rewrites += 1
      return `${prefix}${quote}${resolved}${quote}`
    })
  }
  return { content, rewrites, unresolved }
}

function processDist(distDir) {
  const absoluteDist = resolve(process.cwd(), distDir)
  if (!statSync(absoluteDist).isDirectory()) {
    throw new Error(`不是目录：${absoluteDist}`)
  }
  const files = collectDeclarationFiles(absoluteDist)
  let changedFiles = 0
  let totalRewrites = 0
  const failures = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const { content, rewrites, unresolved } = rewriteDeclaration(source, dirname(file))
    if (unresolved.length > 0) {
      failures.push({ file: relative(absoluteDist, file), specifiers: [...new Set(unresolved)] })
    }
    if (rewrites > 0) {
      writeFileSync(file, content)
      changedFiles += 1
      totalRewrites += rewrites
    }
  }

  return { distDir: absoluteDist, fileCount: files.length, changedFiles, totalRewrites, failures }
}

function main() {
  const distDirs = process.argv.slice(2)
  if (distDirs.length === 0) {
    console.error('用法：node scripts/fix-dts-specifiers.mjs <distDir> [更多 distDir...]')
    process.exit(2)
  }

  let failed = false
  for (const distDir of distDirs) {
    const result = processDist(distDir)
    const label = relative(process.cwd(), result.distDir) || result.distDir
    console.log(
      `[fix-dts-specifiers] ${label}: 扫描 ${result.fileCount} 个声明文件，` +
        `改写 ${result.changedFiles} 个文件 / ${result.totalRewrites} 处说明符`,
    )
    for (const failure of result.failures) {
      failed = true
      console.error(
        `[fix-dts-specifiers] 无法解析的相对说明符 ${label}/${failure.file}: ` +
          failure.specifiers.join(', '),
      )
    }
  }

  if (failed) {
    console.error(
      '[fix-dts-specifiers] 声明产物里存在解析不到目标的相对说明符，' +
        'node16/nodenext 消费方会直接报错——先修产物，不要跳过本步。',
    )
    process.exit(1)
  }
}

main()
