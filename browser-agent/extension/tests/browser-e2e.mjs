import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { rawTextPlugin } from '../../../tsup.rawPlugin.ts'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const evidence = resolve(root, '../../.tasks/browser-agent/reports/050-evidence')
const chromePath = process.env.CHROME_PATH || '/Users/dol/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
await mkdir(evidence, { recursive: true })

const server = createServer((request, response) => {
  if (request.url === '/after-navigation') response.end('<!doctype html><title>Navigated</title><form><input name="other"></form>')
  else response.end('<!doctype html><title>Controlled fixture</title><form><label>Name<input name="name" required></label><label>City<select name="city" required><option value="">Choose</option><option value="shanghai">Shanghai</option></select></label><label>Unsupported<input type="file" name="upload"></label></form>')
})
let stderr = ''
let temporaryRoot
let chrome
let childError

try {
  await new Promise((resolveReady, rejectReady) => { server.once('error', rejectReady); server.listen(0, '127.0.0.1', resolveReady) })
  const port = server.address().port
  temporaryRoot = await mkdtemp(join(tmpdir(), 'browser-agent-mv3-'))
  const testDist = join(temporaryRoot, 'extension')
  await cp(dist, testDist, { recursive: true })
  await Promise.all(['browser-harness.html', 'browser-harness.js'].map((name) => copyFile(join(import.meta.dirname, name), join(testDist, name))))
  await build({ entryPoints: [join(import.meta.dirname, 'browser-runtime-harness.testFixtures.ts')], outfile: join(testDist, 'browser-runtime-harness.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome151', sourcemap: true, tsconfig: resolve(root, '../../tsconfig.app.json'), define: { 'process.env.NODE_ENV': '"production"' }, plugins: [rawTextPlugin()] })
  const e2eManifestPath = join(testDist, 'manifest.json')
  const e2eManifest = JSON.parse(await readFile(e2eManifestPath, 'utf8'))
  e2eManifest.host_permissions = [`http://127.0.0.1:${port}/*`]
  e2eManifest.permissions = [...new Set([...(e2eManifest.permissions ?? []), 'tabs'])]
  await writeFile(e2eManifestPath, `${JSON.stringify(e2eManifest, null, 2)}\n`)
  const profile = join(temporaryRoot, 'profile')
  await mkdir(profile)
  chrome = spawn(chromePath, [`--user-data-dir=${profile}`, '--password-store=basic', '--use-mock-keychain', '--remote-debugging-port=0', `--disable-extensions-except=${testDist}`, `--load-extension=${testDist}`, '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${port}/`], { stdio: ['ignore', 'pipe', 'pipe'] })
  chrome.once('error', (error) => { childError = error })
  chrome.stderr.on('data', (chunk) => { stderr += chunk })
  const portFile = join(profile, 'DevToolsActivePort')
  await waitFor(async () => { if (childError) throw childError; return readFile(portFile, 'utf8').then(() => true, () => false) }, 15_000)
  const [debugPort] = (await readFile(portFile, 'utf8')).trim().split('\n')
  const base = `http://127.0.0.1:${debugPort}`
  const version = await fetch(`${base}/json/version`).then((response) => response.json())
  const extensionId = await waitFor(async () => {
    const targets = await fetch(`${base}/json/list`).then((response) => response.json())
    const worker = targets.find((target) => target.type === 'service_worker' && target.url?.endsWith('/service-worker.js'))
    return worker?.url?.split('/')[2] || false
  }, 15_000)
  const fixtureTarget = await fetch(`${base}/json/new`, { method: 'PUT' }).then((response) => response.json())
  const fixtureCdp = await connect(fixtureTarget.webSocketDebuggerUrl)
  await fixtureCdp.call('Page.enable')
  await fixtureCdp.call('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await waitFor(async () => (await fixtureCdp.call('Runtime.evaluate', { expression: 'location.protocol', returnByValue: true })).result.value === 'http:', 10_000)
  fixtureCdp.close()
  const harnessUrl = `chrome-extension://${extensionId}/browser-harness.html#${port}`
  const harnessTarget = await fetch(`${base}/json/new?${encodeURIComponent(harnessUrl)}`, { method: 'PUT' }).then((response) => response.json())
  const cdp = await connect(harnessTarget.webSocketDebuggerUrl)
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await waitFor(async () => (await cdp.call('Runtime.evaluate', { expression: 'document.documentElement.dataset.ready', returnByValue: true })).result.value === 'true', 10_000)
  const box = (await cdp.call('Runtime.evaluate', { expression: 'JSON.stringify(document.querySelector("#run").getBoundingClientRect())', returnByValue: true })).result.value
  const rect = JSON.parse(box)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + 10, y: rect.y + 10, button: 'left', clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + 10, y: rect.y + 10, button: 'left', clickCount: 1 })
  await waitFor(async () => (await cdp.call('Runtime.evaluate', { expression: 'document.documentElement.dataset.panel' })).result.value === 'open', 30_000)
  const panelTarget = await waitFor(async () => (await fetch(`${base}/json/list`).then((response) => response.json())).find((target) => target.url === `chrome-extension://${extensionId}/sidepanel.html`) || false, 10_000)
  const panelCdp = await connect(panelTarget.webSocketDebuggerUrl)
  await panelCdp.call('Runtime.enable'); await panelCdp.call('Page.enable')
  await waitFor(async () => (await panelCdp.call('Runtime.evaluate', { expression: 'Boolean(document.querySelector(".browser-agent-view"))', returnByValue: true })).result.value === true, 15_000)
  const ui = await exerciseDefaultUi(panelCdp)
  const uiResult = ui.result
  const panelShot = await panelCdp.call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'default-sidepanel.png'), Buffer.from(panelShot.data, 'base64'))
  const panelSummary = (await panelCdp.call('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title,tabs:Array.from(document.querySelectorAll(".bav-tabs button"),node=>node.textContent),target:document.querySelector(".target-bar span")?.textContent,stylesheets:document.styleSheets.length,bodyBackground:getComputedStyle(document.body).backgroundColor,viewDisplay:getComputedStyle(document.querySelector(".browser-agent-view")).display})', returnByValue: true })).result.value
  await ui.startPendingRun()
  panelCdp.close()
  await cdp.call('Runtime.evaluate', { expression: 'window.closePanelForTest = true' })
  await waitFor(async () => (await cdp.call('Runtime.evaluate', { expression: 'document.documentElement.dataset.panel' })).result.value === 'reopened', 15_000)
  const reopenedTarget = await waitFor(async () => (await fetch(`${base}/json/list`).then((response) => response.json())).find((target) => target.url === `chrome-extension://${extensionId}/sidepanel.html` && target.id !== panelTarget.id) || false, 10_000)
  const reopenedCdp = await connect(reopenedTarget.webSocketDebuggerUrl)
  await reopenedCdp.call('Runtime.enable'); await reopenedCdp.call('Fetch.enable', { patterns: [{ urlPattern: 'https://fixture.invalid/*', requestStage: 'Request' }] })
  reopenedCdp.on('Fetch.requestPaused', (event) => { void reopenedCdp.call('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...corsHeaders()], body: Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Recovered safely.' }, finish_reason: 'stop' }] })).toString('base64') }) })
  await waitFor(async () => (await evaluate(reopenedCdp, `document.querySelector('select[aria-label="会话"]')?.options.length`)).result.value > 1, 10_000)
  const sessionValues = (await evaluate(reopenedCdp, `Array.from(document.querySelector('select[aria-label="会话"]').options).map(option=>option.value).filter(Boolean)`)).result.value
  for (const value of sessionValues) {
    await evaluate(reopenedCdp, `(() => { const select=document.querySelector('select[aria-label="会话"]'); select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event('change',{bubbles:true})) })()`)
    try { await waitFor(async () => (await evaluate(reopenedCdp, `document.body.innerText.includes('可恢复上次运行')`)).result.value === true, 1_000); break } catch { /* inspect the next persisted session */ }
  }
  try {
    await waitFor(async () => (await evaluate(reopenedCdp, `document.body.innerText.includes('可恢复上次运行') && document.querySelector('.target-bar span')?.textContent.includes('Controlled fixture')`)).result.value === true, 15_000)
  } catch (error) {
    const body = (await evaluate(reopenedCdp, 'document.body.innerText')).result.value
    throw new Error(`${error.message}; reopened panel body ${body}`)
  }
  const recoveryBefore = (await evaluate(reopenedCdp, `document.body.innerText`)).result.value
  await clickText(reopenedCdp, '恢复运行')
  await waitFor(async () => (await evaluate(reopenedCdp, `document.body.innerText.includes('Recovered safely.') && document.querySelector('.bav-run-strip')?.innerText.includes('已完成')`)).result.value === true, 15_000)
  uiResult.interruptedRecovery = { recoverable: recoveryBefore.includes('可恢复上次运行'), bindingRestored: recoveryBefore.includes('Controlled fixture'), continued: true }
  reopenedCdp.close()
  await cdp.call('Runtime.evaluate', { expression: 'window.finishReopenInspection = true' })
  try {
    await waitFor(async () => (await cdp.call('Runtime.evaluate', { expression: 'document.documentElement.dataset.done' })).result.value === 'true', 45_000)
  } catch (error) {
    const diagnostic = await cdp.call('Runtime.evaluate', { expression: 'JSON.stringify({stage:window.runtimeStage,result:document.querySelector("#result")?.textContent})', returnByValue: true })
    throw new Error(`${error.message}; ${diagnostic.result.value}`)
  }
  const reportText = (await cdp.call('Runtime.evaluate', { expression: 'document.querySelector("#result").textContent', returnByValue: true })).result.value
  const report = JSON.parse(reportText)
  const targetsAfterClose = await fetch(`${base}/json/list`).then((response) => response.json())
  report.panelTargetClosed = !targetsAfterClose.some((target) => target.url === `chrome-extension://${extensionId}/sidepanel.html`)
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'mv3-harness.png'), Buffer.from(screenshot.data, 'base64'))
  report.defaultUi = JSON.parse(panelSummary)
  report.defaultUi.flow = uiResult
  await writeFile(join(evidence, 'mv3-report.json'), `${JSON.stringify({ browser: version.Browser, protocol: version['Protocol-Version'], extensionId, fixture: `http://127.0.0.1:${port}/`, report }, null, 2)}\n`)
  if (!report.ok || !report.panelTargetClosed || !uiResult.completed || !uiResult.interruptedRecovery?.continued || uiResult.requestCount < 9 || report.defaultUi.stylesheets < 1 || report.defaultUi.viewDisplay === 'inline') throw new Error(`MV3 harness failed: ${JSON.stringify(report, null, 2)}`)
  console.log(JSON.stringify({ browser: version.Browser, extensionId, report, screenshot: join(evidence, 'mv3-harness.png') }, null, 2))
  cdp.close()
} finally {
  if (chrome) { chrome.kill('SIGTERM'); await waitForProcessExit(chrome, 5_000) }
  await new Promise((resolveClose) => server.close(resolveClose)).catch(() => undefined)
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  if (stderr) await writeFile(join(evidence, 'chrome-stderr.log'), stderr)
}

function connect(url) {
  return new Promise((resolveConnected, reject) => {
    const socket = new WebSocket(url); let id = 0
    const pending = new Map()
    const listeners = new Map()
    socket.onopen = () => resolveConnected({ call(method, params = {}) { return new Promise((resolveCall, rejectCall) => { const callId = ++id; pending.set(callId, { resolveCall, rejectCall }); socket.send(JSON.stringify({ id: callId, method, params })) }) }, on(method, listener) { listeners.set(method, listener) }, close() { socket.close() } })
    socket.onerror = reject
    socket.onmessage = (event) => { const message = JSON.parse(event.data); if (!message.id) { listeners.get(message.method)?.(message.params); return } const task = pending.get(message.id); if (!task) return; pending.delete(message.id); message.error ? task.rejectCall(new Error(message.error.message)) : task.resolveCall(message.result) }
  })
}
async function exerciseDefaultUi(cdp) {
  let requestCount = 0
  let requestError
  let hold = false
  let held = false
  cdp.on('Fetch.requestPaused', (event) => { void (async () => {
    try {
      if (event.request.method === 'OPTIONS') {
        await cdp.call('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 204, responseHeaders: corsHeaders() })
        return
      }
      if (hold) { held = true; return }
      const body = JSON.parse(event.request.postData || '{}')
      const message = uiModelMessage(body)
      requestCount += 1
      await cdp.call('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...corsHeaders()], body: Buffer.from(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })).toString('base64') })
    } catch (error) { requestError = error }
  })() })
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: 'https://fixture.invalid/*', requestStage: 'Request' }] })
  await clickText(cdp, '配置'); await clickText(cdp, '连接')
  await fill(cdp, 'input[name="label"]', 'UI fixture')
  await fill(cdp, 'input[name="baseUrl"]', 'https://fixture.invalid/v1')
  await fill(cdp, 'textarea[name="models"]', 'ui-model')
  await fill(cdp, 'input[name="apiKey"]', 'fixture-only')
  await clickText(cdp, '保存连接')
  await waitText(cdp, '连接已保存')
  await clickText(cdp, 'Agent')
  await waitFor(async () => (await evaluate(cdp, `Boolean(document.querySelector('input[name="name"]'))`)).result.value === true, 10_000)
  await fill(cdp, 'input[name="name"]', 'UI form agent')
  await fill(cdp, 'textarea[name="instructions"]', 'Fill and validate the bound form.')
  await evaluate(cdp, `for (const input of document.querySelectorAll('input[name="tool"]')) { input.checked = ['query_options','read_form','fill_fields','validate_form'].includes(input.value); input.dispatchEvent(new Event('change',{bubbles:true})) }`)
  await clickText(cdp, '保存 Agent'); await waitText(cdp, 'Agent 已保存')
  await clickText(cdp, '对话')
  await evaluate(cdp, `const select=document.querySelector('select[aria-label="使用 Agent"]'); select.value=select.options[1].value; select.dispatchEvent(new Event('change',{bubbles:true}))`)
  await clickText(cdp, '新建会话')
  await waitFor(async () => (await evaluate(cdp, `document.querySelector('select[aria-label="会话"]')?.options.length`)).result.value > 1, 10_000)
  await fill(cdp, 'textarea[aria-label="消息"]', 'Complete this form.')
  await clickText(cdp, '发送')
  try {
    await waitFor(async () => {
      if (requestError) throw requestError
      return (await evaluate(cdp, `document.querySelector('.bav-run-strip')?.innerText.includes('已完成') && document.body.innerText.includes('UI flow completed.')`)).result.value === true
    }, 20_000)
  } catch (error) {
    const body = (await evaluate(cdp, `document.body.innerText`)).result.value
    throw new Error(`${error.message}; UI requests ${requestCount}; body ${body}`)
  }
  const result = { completed: true, requestCount, boundTarget: (await evaluate(cdp, `document.querySelector('.target-bar span')?.textContent`)).result.value }
  return { result, async startPendingRun() {
    hold = true
    await clickText(cdp, '新建会话')
    await fill(cdp, 'textarea[aria-label="消息"]', 'Start a run that will be interrupted.')
    await clickText(cdp, '发送')
    await waitFor(async () => held, 10_000)
  } }
}
function corsHeaders() { return [{ name: 'access-control-allow-origin', value: '*' }, { name: 'access-control-allow-headers', value: '*' }, { name: 'access-control-allow-methods', value: 'POST, OPTIONS' }] }
function uiModelMessage(body) {
  const messages = body.messages ?? []
  const turn = messages.filter((message) => message.role === 'tool').length
  const names = ['query_options', 'query_options', 'read_form', 'read_form', 'fill_fields', 'fill_fields', 'validate_form', 'validate_form']
  const name = names[turn]
  if (!name) return { role: 'assistant', content: 'UI flow completed.' }
  const parsed = messages.flatMap((message) => { try { return [JSON.parse(message.content || '{}')] } catch { return [] } })
  const form = parsed.filter((value) => value.page && value.fields).at(-1)
  const option = parsed.flatMap((value) => value.options ?? []).at(-1)?.value
  const args = name === 'query_options' ? { sourceId: 'fixture-cities', parameters: { country: 'CN' } } : name === 'fill_fields' ? { page: form?.page, values: [{ id: form?.fields.find((field) => field.label === 'Name')?.id, value: 'Ada' }, { id: form?.fields.find((field) => field.label.startsWith('City'))?.id, value: option }] } : name === 'validate_form' ? { page: form?.page } : {}
  return { role: 'assistant', content: null, tool_calls: [{ id: `ui-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}
async function fill(cdp, selector, value) { const result = await evaluate(cdp, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing field: '+${JSON.stringify(selector)}); const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value').set; setter.call(node,${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); node.dispatchEvent(new Event('change',{bubbles:true})); return true })()`); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text) }
async function clickText(cdp, label) { const result = await evaluate(cdp, `(() => { const node=Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()===${JSON.stringify(label)}); if (!node) throw new Error('Missing button: '+${JSON.stringify(label)}); node.click(); return true })()`); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text) }
async function waitText(cdp, text) { await waitFor(async () => (await evaluate(cdp, `document.body.innerText.includes(${JSON.stringify(text)})`)).result.value === true, 10_000) }
async function evaluate(cdp, expression) { return cdp.call('Runtime.evaluate', { expression, returnByValue: true }) }
async function waitFor(operation, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 100)) }
  throw new Error(`Timed out after ${timeout}ms`)
}
async function waitForProcessExit(process, timeout) {
  if (process.exitCode !== null || process.signalCode !== null) return
  let timer
  await new Promise((resolveExit) => {
    process.once('exit', resolveExit)
    timer = setTimeout(() => process.kill('SIGKILL'), timeout)
  })
  clearTimeout(timer)
}
