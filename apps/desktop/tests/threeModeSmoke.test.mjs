import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const bundleContents = path.join(
  repositoryRoot,
  'apps/desktop/target/aarch64-apple-darwin/release/bundle/macos/Einfach Agent.app/Contents',
)
const bundledNode = path.join(bundleContents, 'MacOS/einfach-agent-node')
const bundledServer = path.join(bundleContents, 'Resources/server/main.js')
const browserServer = path.join(repositoryRoot, 'apps/server/dist/main.js')
const temporaryDirectories = []
const runningChildren = new Set()
let resolveHost

function readyFrameError(label) {
  return new Error(`${label} ready frame was rejected; sensitive output redacted`)
}

function parseReadyFrame(line, label) {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    throw readyFrameError(label)
  }
  if (
    typeof frame !== 'object'
    || frame === null
    || frame.kind !== 'einfach-agent-server-ready'
    || frame.version !== 1
    || typeof frame.url !== 'string'
  ) {
    throw readyFrameError(label)
  }

  let url
  try {
    url = new URL(frame.url)
  } catch {
    throw readyFrameError(label)
  }
  const token = url.searchParams.get('token')
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !token) {
    throw readyFrameError(label)
  }
  return { token, url }
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function loadResolveHost() {
  const outputDirectory = await temporaryDirectory('einfach-resolve-host-')
  const outputFile = path.join(outputDirectory, 'resolveHost.mjs')
  await build({
    bundle: true,
    entryPoints: [path.join(repositoryRoot, 'apps/web/src/host/resolveHost.ts')],
    format: 'esm',
    logLevel: 'silent',
    outfile: outputFile,
    platform: 'browser',
  })
  return (await import(pathToFileURL(outputFile).href)).resolveHost
}

function childEnvironment(homeDirectory) {
  return {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    WEB_AGENT_CONFIG_DIR: path.join(homeDirectory, 'config'),
  }
}

async function startServer(executable, script, label) {
  const homeDirectory = await temporaryDirectory(`einfach-${label}-`)
  const child = spawn(executable, [script, '--ready-json', '--host', '127.0.0.1', '--port', '0'], {
    cwd: path.dirname(script),
    env: childEnvironment(homeDirectory),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runningChildren.add(child)

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  const line = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} ready frame timed out`)), 20_000)
    const finish = (action) => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      action()
    }
    const onData = () => {
      const newline = stdout.indexOf('\n')
      if (newline !== -1) finish(() => resolve(stdout.slice(0, newline)))
    }
    const onError = () => finish(() => reject(new Error(`${label} could not start`)))
    const onExit = () => finish(() => reject(new Error(`${label} exited before ready`)))
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })

  const { token, url } = parseReadyFrame(line, label)
  assert.equal(stderr.includes(token), false, `${label} stderr disclosed its token`)
  return { child, getStderr: () => stderr, getStdout: () => stdout, token, url }
}

async function resolveRunningServer(url) {
  const healthResponse = await fetch(new URL('/api/health', url))
  if (healthResponse.status !== 200) throw new Error('server health request failed')
  const payload = await healthResponse.json()
  if (
    typeof payload !== 'object'
    || payload === null
    || payload.service !== 'einfach-agent'
    || payload.host !== 'node-server'
    || typeof payload.version !== 'string'
  ) {
    throw new Error('server health payload was rejected; response redacted')
  }
  const origin = new URL(url.origin)
  const resolved = await resolveHost({
    fetch: (input, init) => fetch(new URL(input, origin), init),
  })
  assert.deepEqual(resolved, { kind: 'server', platform: payload.platform })
}

async function smokeServer(executable, script, label) {
  let handle
  try {
    handle = await startServer(executable, script, label)
    await resolveRunningServer(handle.url)
    await stopServer(handle, label)
  } catch {
    if (handle && runningChildren.has(handle.child)) handle.child.kill('SIGKILL')
    throw new Error(`${label} smoke failed; sensitive child output redacted`)
  }
}

async function stopServer(handle, label) {
  const exit = new Promise((resolve) => handle.child.once('exit', resolve))
  assert.equal(handle.child.kill('SIGTERM'), true, `${label} did not accept SIGTERM`)
  let exitTimeout
  try {
    await Promise.race([
      exit,
      new Promise((_, reject) => {
        exitTimeout = setTimeout(() => reject(new Error(`${label} did not exit`)), 10_000)
      }),
    ])
  } finally {
    clearTimeout(exitTimeout)
  }
  runningChildren.delete(handle.child)
  assert.equal(handle.getStderr().includes(handle.token), false, `${label} stderr disclosed its token`)
  assert.equal(handle.getStdout().trim().split('\n').length, 1, `${label} emitted extra ready output`)

  const healthUrl = new URL('/api/health', handle.url.origin)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(healthUrl)
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      return
    }
  }
  assert.fail(`${label} port remained available after child exit`)
}

before(async () => {
  await Promise.all([access(browserServer), access(bundledNode), access(bundledServer)])
  resolveHost = await loadResolveHost()
})

after(async () => {
  for (const child of runningChildren) child.kill('SIGKILL')
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })))
})

test('pure Web resolves a missing health endpoint as static without starting a child', async () => {
  const sentinel = 'must-not-appear-in-ready-errors'
  assert.throws(
    () => parseReadyFrame(`{"kind":"einfach-agent-server-ready","version":1,"url":"http://[invalid/?token=${sentinel}"}`, 'fixture'),
    (error) => error instanceof Error && !error.message.includes(sentinel),
  )
  assert.equal(runningChildren.size, 0)
  const resolved = await resolveHost({
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  })
  assert.deepEqual(resolved, { kind: 'static', reason: 'unhealthy' })
  assert.equal(runningChildren.size, 0)
})

test('browser Node server resolves as server and releases its port on exit', async () => {
  await smokeServer(process.execPath, browserServer, 'browser-server')
})

test('bundled Tauri sidecar resolves as server and releases its port on exit', async () => {
  await smokeServer(bundledNode, bundledServer, 'tauri-sidecar')
})
