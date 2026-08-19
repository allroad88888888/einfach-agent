import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoots = ['packages', 'tools']
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies']

function packageDirectory(name) {
  return join('node_modules', ...name.split('/'))
}

function packageId(name) {
  return name.replace('@einfach-agent/', '').replaceAll('/', '-')
}

async function command(file, args, cwd) {
  return execFile(file, args, { cwd, maxBuffer: 10 * 1024 * 1024 })
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function releasePackages() {
  const manifests = []
  for (const root of packageRoots) {
    const entries = await readdir(join(repositoryRoot, root), {
      withFileTypes: true,
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = join(repositoryRoot, root, entry.name)
      const manifestPath = join(directory, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = await readJson(manifestPath)
      if (manifest.files?.includes('dist') && manifest.scripts?.build) {
        if (!existsSync(join(directory, 'dist'))) {
          throw new Error(`${manifest.name} is missing dist; run its build before check:dist`)
        }
        manifests.push({ directory, manifest })
      }
    }
  }
  return manifests.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
}

async function unpackPackages(packages, temporaryRoot) {
  const tarballs = join(temporaryRoot, 'tarballs')
  const stagedRoot = join(temporaryRoot, 'packages')
  await Promise.all([mkdir(tarballs), mkdir(stagedRoot)])

  const stagedPackages = []
  for (const item of packages) {
    const { stdout } = await command('npm', ['pack', '--json', '--pack-destination', tarballs], item.directory)
    const [{ filename }] = JSON.parse(stdout)
    const unpackRoot = join(temporaryRoot, 'unpacked', packageId(item.manifest.name))
    await mkdir(unpackRoot, { recursive: true })
    await command('tar', ['-xzf', join(tarballs, filename), '-C', unpackRoot], repositoryRoot)
    const directory = join(stagedRoot, packageId(item.manifest.name))
    await rename(join(unpackRoot, 'package'), directory)
    stagedPackages.push({ ...item, directory })
  }
  return stagedPackages
}

async function rewriteWorkspaceDependencies(packages) {
  const byName = new Map(packages.map((item) => [item.manifest.name, item]))
  for (const item of packages) {
    const manifestPath = join(item.directory, 'package.json')
    const manifest = await readJson(manifestPath)
    for (const field of dependencyFields) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (typeof version !== 'string' || !version.startsWith('workspace:')) continue
        const dependency = byName.get(name)
        if (!dependency) throw new Error(`${manifest.name} references unpacked workspace dependency ${name}`)
        const workspaceRange = version.slice('workspace:'.length)
        manifest[field][name] = workspaceRange === '*' ? dependency.manifest.version : `${workspaceRange}${dependency.manifest.version}`
      }
    }
    await writeJson(manifestPath, manifest)
  }
}

async function repackPackages(packages, temporaryRoot) {
  const tarballs = join(temporaryRoot, 'repacked')
  await mkdir(tarballs)
  const repackedPackages = []
  for (const item of packages) {
    const { stdout } = await command('npm', ['pack', '--json', '--pack-destination', tarballs], item.directory)
    const [{ filename }] = JSON.parse(stdout)
    repackedPackages.push({ ...item, tarball: join(tarballs, filename) })
  }
  return repackedPackages
}

function exportedSpecifiers(packages) {
  return packages.flatMap(({ manifest }) => Object.keys(manifest.exports ?? {})
    .filter((entry) => entry !== './package.json' && !entry.includes('*'))
    .map((entry) => entry === '.' ? manifest.name : `${manifest.name}/${entry.slice(2)}`))
}

async function installConsumer(packages, temporaryRoot) {
  const directory = join(temporaryRoot, 'consumer')
  await mkdir(directory)
  await writeJson(join(directory, 'package.json'), {
    name: 'web-agent-dist-smoke-consumer',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(packages.map((item) => [
      item.manifest.name,
      `file:${relative(directory, item.tarball)}`,
    ])),
  })
  await command('npm', ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', '--omit=optional'], directory)
  return directory
}

async function verifyRuntimeImports(consumerDirectory, specifiers) {
  const script = `for (const specifier of JSON.parse(process.argv[1])) await import(specifier)`
  await command(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify(specifiers)], consumerDirectory)
}

async function verifyNodeNextDeclarations(consumerDirectory, specifiers) {
  await writeFile(join(consumerDirectory, 'imports.ts'), `${specifiers.map((specifier) => `import '${specifier}'`).join('\n')}\n`)
  await writeJson(join(consumerDirectory, 'tsconfig.json'), {
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      skipLibCheck: true,
    },
    files: ['imports.ts'],
  })
  await command(process.execPath, [join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], consumerDirectory)
}

async function verifyBrokenExportIsRejected(consumerDirectory, packageName) {
  const manifestPath = join(consumerDirectory, packageDirectory(packageName), 'package.json')
  const manifest = await readJson(manifestPath)
  const originalExports = manifest.exports
  manifest.exports = {}
  await writeJson(manifestPath, manifest)
  try {
    const script = `import(${JSON.stringify(packageName)}).then(() => process.exitCode = 1).catch((error) => { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error })`
    await command(process.execPath, ['--input-type=module', '--eval', script], consumerDirectory)
  } finally {
    manifest.exports = originalExports
    await writeJson(manifestPath, manifest)
  }
}

async function verifyUnlistedCoreSubpathIsRejected(consumerDirectory, packages) {
  const corePackage = packages.find((item) => item.manifest.name === '@einfach-agent/core')
  if (!corePackage) throw new Error('check:dist requires @einfach-agent/core')

  const specifier = `${corePackage.manifest.name}/__not_exported__`
  const script = `import(${JSON.stringify(specifier)}).then(() => process.exitCode = 1).catch((error) => { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error })`
  await command(process.execPath, ['--input-type=module', '--eval', script], consumerDirectory)
}

async function main() {
  const packages = await releasePackages()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'web-agent-dist-'))
  try {
    const stagedPackages = await unpackPackages(packages, temporaryRoot)
    await rewriteWorkspaceDependencies(stagedPackages)
    const repackedPackages = await repackPackages(stagedPackages, temporaryRoot)
    const consumerDirectory = await installConsumer(repackedPackages, temporaryRoot)
    const specifiers = exportedSpecifiers(repackedPackages)
    await verifyRuntimeImports(consumerDirectory, specifiers)
    await verifyNodeNextDeclarations(consumerDirectory, specifiers)
    await verifyBrokenExportIsRejected(consumerDirectory, repackedPackages[0].manifest.name)
    await verifyUnlistedCoreSubpathIsRejected(consumerDirectory, repackedPackages)
    console.log(`check-dist passed: ${repackedPackages.length} packed packages, ${specifiers.length} public ESM entry points, NodeNext declarations, and negative exports checks`)
  } finally {
    if (process.env.KEEP_DIST_CHECK !== '1') await rm(temporaryRoot, { recursive: true, force: true })
    else console.log(`check-dist temporary files kept at ${temporaryRoot}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
