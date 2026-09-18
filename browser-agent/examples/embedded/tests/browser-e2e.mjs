import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { rawTextPlugin } from '../../../../tsup.rawPlugin.ts'

const packageRoot = resolve(import.meta.dirname, '..')
const dist = join(packageRoot, 'dist')
const evidence = resolve(packageRoot, '../../../.tasks/browser-agent/reports/050-evidence')
const chromePath = process.env.CHROME_PATH || '/Users/dol/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
let chrome
let temporaryRoot
let childError
let adapterFixturePath
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/controlled-adapter.js' && adapterFixturePath) { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(adapterFixturePath)); return }
    const requested = normalize(decodeURIComponent((request.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '')
    const file = join(dist, requested === '/' ? 'index.html' : requested)
    if (!(await stat(file)).isFile() || !file.startsWith(dist)) throw new Error('not found')
    response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream')
    response.end(await readFile(file))
  } catch { response.statusCode = 404; response.end('not found') }
})

try {
  await mkdir(evidence, { recursive: true })
  await new Promise((resolveReady, rejectReady) => { server.once('error', rejectReady); server.listen(0, '127.0.0.1', resolveReady) })
  const port = server.address().port
  temporaryRoot = await mkdtemp(join(tmpdir(), 'browser-agent-embedded-'))
  adapterFixturePath = join(temporaryRoot, 'controlled-adapter.js')
  await build({ entryPoints: [join(import.meta.dirname, 'controlled-adapter.testFixtures.ts')], outfile: adapterFixturePath, bundle: true, format: 'esm', platform: 'browser', target: 'chrome151', tsconfig: resolve(packageRoot, '../../../tsconfig.app.json'), plugins: [rawTextPlugin()] })
  const profile = join(temporaryRoot, 'profile'); await mkdir(profile)
  chrome = spawn(chromePath, [`--user-data-dir=${profile}`, '--password-store=basic', '--use-mock-keychain', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${port}/`], { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.once('error', (error) => { childError = error })
  const portFile = join(profile, 'DevToolsActivePort')
  await waitFor(async () => { if (childError) throw childError; return readFile(portFile, 'utf8').then(() => true, () => false) }, 15_000)
  const [debugPort] = (await readFile(portFile, 'utf8')).trim().split('\n')
  const base = `http://127.0.0.1:${debugPort}`
  const version = await fetch(`${base}/json/version`).then((response) => response.json())
  const target = await fetch(`${base}/json/new`, { method: 'PUT' }).then((response) => response.json())
  const cdp = await connect(target.webSocketDebuggerUrl); await cdp.call('Page.enable'); await cdp.call('Runtime.enable')
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  try { await waitFor(async () => (await evaluate(cdp, 'document.querySelectorAll("button:not(:disabled)").length')).value === 2, 15_000) }
  catch (error) { throw new Error(`${error.message}; page ${(await evaluate(cdp, 'document.body.innerText')).value}`) }
  await evaluate(cdp, 'document.querySelectorAll("button").forEach((button) => button.click())')
  await waitFor(async () => (await statuses(cdp)).every((value) => value.startsWith('Completed in isolated session')), 20_000)
  const first = await statuses(cdp)
  await evaluate(cdp, 'document.querySelectorAll("button").forEach((button) => button.click())')
  await waitFor(async () => { const next = await statuses(cdp); return next.every((value) => value.startsWith('Completed in isolated session')) && next.some((value, index) => value !== first[index]) }, 20_000)
  const second = await statuses(cdp)
  const values = (await evaluate(cdp, 'Array.from(document.querySelectorAll("iframe"), frame => ({person: frame.contentDocument.querySelector("[name=person]").value, city: frame.contentDocument.querySelector("[name=city]").value, controlled: frame.contentDocument.querySelector("[data-controlled]").textContent}))')).value
  await evaluate(cdp, `import('/controlled-adapter.js')`)
  await evaluate(cdp, '(async()=>{window.adapterCancelResult=await window.runControlledAdapterCancel();return true})()')
  const adapterCancel = JSON.parse((await evaluate(cdp, 'JSON.stringify(window.adapterCancelResult)')).value)
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'embedded-two-clients.png'), Buffer.from(screenshot.data, 'base64'))
  const report = { browser: version.Browser, first, second, values, adapterCancel, namespaces: ['sales-agent', 'travel-agent'], repeated: true }
  await writeFile(join(evidence, 'embedded-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (values[0]?.person !== 'Ada' || values[0]?.city !== 'cn-city' || values[1]?.person !== 'Ada' || values[1]?.city !== 'gb-city' || values.some((value) => value.controlled !== 'adapter-value')) throw new Error(`Embedded values incorrect: ${JSON.stringify(values)}`)
  if (!adapterCancel.entered || !adapterCancel.aborted || adapterCancel.lateWrite || adapterCancel.value !== 'before' || (adapterCancel.error !== 'AbortError' && adapterCancel.outcomes?.[0]?.ok !== false)) throw new Error(`Controlled adapter cancellation incorrect: ${JSON.stringify(adapterCancel)}`)
  console.log(JSON.stringify(report, null, 2)); cdp.close()
} finally {
  if (chrome) { chrome.kill('SIGTERM'); await waitForExit(chrome, 5_000) }
  await new Promise((resolveClose) => server.close(resolveClose)).catch(() => undefined)
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
}

async function statuses(cdp) { return (await evaluate(cdp, 'Array.from(document.querySelectorAll(".status"), node => node.textContent)')).value }
async function evaluate(cdp, expression) { return (await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result }
function connect(url) { return new Promise((resolveSocket, reject) => { const socket = new WebSocket(url); let id = 0; const pending = new Map(); socket.onopen = () => resolveSocket({ call(method, params = {}) { return new Promise((resolveCall, rejectCall) => { const callId = ++id; pending.set(callId, { resolveCall, rejectCall }); socket.send(JSON.stringify({ id: callId, method, params })) }) }, close() { socket.close() } }); socket.onerror = reject; socket.onmessage = (event) => { const message = JSON.parse(event.data); const task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.rejectCall(new Error(message.error.message)) : task.resolveCall(message.result) } }) }
async function waitFor(operation, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await operation(); if (value) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 100)) } throw new Error(`Timed out after ${timeout}ms`) }
async function waitForExit(process, timeout) { if (process.exitCode !== null || process.signalCode !== null) return; let timer; await new Promise((resolveExit) => { process.once('exit', resolveExit); timer = setTimeout(() => process.kill('SIGKILL'), timeout) }); clearTimeout(timer) }
