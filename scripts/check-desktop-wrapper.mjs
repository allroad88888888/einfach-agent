import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const checks = [
  'apps/desktop/tests/threeModeSmoke.test.mjs',
  'apps/desktop/tests/desktopStaticGuard.test.mjs',
]
const taskFiles = [
  ...checks,
  'apps/desktop/tests/webCapabilityStaticAnalysis.mjs',
  'scripts/check-desktop-wrapper.mjs',
]

// Git cannot report ignored content changes. These are the generated inputs consumed by the smoke,
// plus the desktop runtime staging cache/output that must remain immutable while checks run.
const ignoredArtifactRoots = [
  'apps/desktop/.cache/node-runtime',
  'apps/desktop/binaries',
  'apps/desktop/target/aarch64-apple-darwin/release/einfach-agent-desktop',
  'apps/desktop/target/aarch64-apple-darwin/release/bundle/macos/Einfach Agent.app',
  'apps/server/dist',
  'apps/web/dist',
  'packages/host-node/dist',
]

async function gitPaths(argumentsList) {
  const { stdout } = await execFileAsync('git', argumentsList, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout.split('\0').filter(Boolean)
}

async function hashEntry(relative) {
  const absolute = path.join(repositoryRoot, relative)
  const metadata = await lstat(absolute)
  const hash = createHash('sha256')
  let kind = 'other'
  if (metadata.isSymbolicLink()) {
    kind = 'link'
    hash.update(await readlink(absolute))
  } else if (metadata.isFile()) {
    kind = 'file'
    for await (const chunk of createReadStream(absolute)) hash.update(chunk)
  }
  return [relative, kind, metadata.mode & 0o777, metadata.size, hash.digest('hex')].join('\0')
}

async function workspaceContentSnapshot() {
  const ignoredArtifacts = await gitPaths([
    'ls-files', '-oi', '--exclude-standard', '-z', '--', ...ignoredArtifactRoots,
  ])
  const files = [...new Set([...taskFiles, ...ignoredArtifacts])].sort()
  const manifestHash = createHash('sha256')
  for (let index = 0; index < files.length; index += 32) {
    const entries = await Promise.all(files.slice(index, index + 32).map(hashEntry))
    for (const entry of entries) manifestHash.update(entry).update('\0')
  }
  return manifestHash.digest('hex')
}

function containsSensitiveOutput(output) {
  return /(?:[?&]token=|einfach-agent-server-ready)/i.test(output)
}

async function runCheck(file) {
  await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(repositoryRoot, file)],
      { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error || containsSensitiveOutput(stdout) || containsSensitiveOutput(stderr)) {
          reject(new Error(`${file} failed; captured output redacted`))
          return
        }
        process.stdout.write(stdout)
        process.stderr.write(stderr)
        resolve()
      },
    )
    child.once('error', () => reject(new Error(`${file} could not start; output redacted`)))
  })
}

async function main() {
  const before = await workspaceContentSnapshot()
  let checkFailed = false
  try {
    for (const check of checks) await runCheck(check)
  } catch {
    checkFailed = true
  }
  const after = await workspaceContentSnapshot()
  if (after !== before) throw new Error('workspace content changed')
  if (checkFailed) throw new Error('desktop wrapper check failed')
  console.log('desktop wrapper checks passed; task files and declared ignored artifacts are unchanged')
}

main().catch(() => {
  console.error('desktop wrapper checks failed; captured output redacted')
  process.exitCode = 1
})
