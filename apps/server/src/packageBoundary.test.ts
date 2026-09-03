import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const require = createRequire(import.meta.url)
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(serverRoot, 'src')
const productionSourcePattern = /(?<!\.(?:test|testHarness|testFixtures))\.ts$/
const tsupManifestPath = require.resolve('tsup/package.json')
const tsupManifest = require(tsupManifestPath) as { bin?: string | Record<string, string> }
const tsupBin = typeof tsupManifest.bin === 'string' ? tsupManifest.bin : tsupManifest.bin?.tsup
if (!tsupBin) throw new Error('tsup package.json does not declare bin.tsup')
const tsupCli = resolve(dirname(tsupManifestPath), tsupBin)

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    return entry.isFile() && productionSourcePattern.test(entry.name) ? [path] : []
  }))
  return files.flat()
}

function workspacePackage(specifier: string): string | undefined {
  if (!specifier.startsWith('@einfach-agent/')) return undefined
  return specifier.split('/').slice(0, 2).join('/')
}

function isRuntimeImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly)
}

function isRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true
  return node.exportClause.elements.some((element) => !element.isTypeOnly)
}

function runtimeWorkspaceImports(source: string, path: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const packages = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isRuntimeImport(node)) {
      const packageName = workspacePackage(node.moduleSpecifier.text)
      if (packageName) packages.add(packageName)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) && isRuntimeExport(node)) {
      const packageName = workspacePackage(node.moduleSpecifier.text)
      if (packageName) packages.add(packageName)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && ts.isStringLiteral(argument)) {
        const packageName = workspacePackage(argument.text)
        if (packageName) packages.add(packageName)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...packages]
}

function externalImportPattern(packageName: string): RegExp {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:from\\s+|\\bimport\\s*(?:\\(\\s*)?)["']${escaped}(?:/[^"']*)?["']`)
}

it.each([
  ['named import', 'import { policy } from "@einfach-agent/ai"'],
  ['dynamic import', 'await import("@einfach-agent/ai/provider")'],
  ['side-effect import', 'import "@einfach-agent/ai/register"'],
])('external import matcher accepts %s', (_label, source) => {
  expect(source).toMatch(externalImportPattern('@einfach-agent/ai'))
})

it('external import matcher rejects a sibling package prefix', () => {
  expect('import "@einfach-agent/ai-extra"').not.toMatch(externalImportPattern('@einfach-agent/ai'))
})

it('运行时 workspace import 均声明为依赖并由 tsup externalize', async () => {
  const manifest = JSON.parse(await readFile(join(serverRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const imports = new Set<string>()
  for (const path of await productionSources(sourceRoot)) {
    for (const packageName of runtimeWorkspaceImports(await readFile(path, 'utf8'), path)) imports.add(packageName)
  }

  expect([...imports]).toContain('@einfach-agent/ai')
  expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(expect.arrayContaining([...imports].sort()))

  const outputDirectory = await mkdtemp(join(tmpdir(), 'einfach-server-boundary-'))
  try {
    await execFile(
      process.execPath,
      [tsupCli, '--config', 'tsup.config.ts', '--out-dir', outputDirectory, '--sourcemap', 'false'],
      { cwd: serverRoot, maxBuffer: 10 * 1024 * 1024 },
    )
    const bundle = await readFile(join(outputDirectory, 'main.js'), 'utf8')
    for (const packageName of imports) expect(bundle).toMatch(externalImportPattern(packageName))
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})
