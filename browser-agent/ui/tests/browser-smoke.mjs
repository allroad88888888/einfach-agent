import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const output = resolve('browser-agent/ui/reports/040-evidence')
const profile = await mkdtemp(join(tmpdir(), 'browser-agent-ui-'))
await mkdir(output, { recursive: true })
const chrome = spawn(chromePath, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-first-run',
  'about:blank',
], { stdio: 'ignore' })
const chromeExited = new Promise((resolve) => {
  chrome.once('exit', resolve)
  chrome.once('error', resolve)
})
const chromeSpawned = new Promise((resolve, reject) => {
  chrome.once('spawn', resolve)
  chrome.once('error', reject)
})

try {
  await chromeSpawned
  const page = await waitForPage(profile)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map()
  const consoleErrors = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message) }
    if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result))
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  const evidence = []
  for (const item of [
    { name: 'empty-narrow', scenario: 'empty', width: 360, height: 760 },
    { name: 'settings-wide', scenario: 'configured', width: 1040, height: 780, setup: "[...document.querySelectorAll('button')].find(x=>x.textContent==='配置').click(); setTimeout(()=>[...document.querySelectorAll('button')].find(x=>x.textContent==='连接').click(),50)" },
    { name: 'waiting-narrow', scenario: 'waiting', width: 360, height: 820, setup: "const s=document.querySelector('select[aria-label=会话]');s.selectedIndex=1;s.dispatchEvent(new Event('change',{bubbles:true}))" },
    { name: 'running-wide', scenario: 'running', width: 1040, height: 780, setup: "const s=document.querySelector('select[aria-label=会话]');s.selectedIndex=1;s.dispatchEvent(new Event('change',{bubbles:true}))" },
  ]) {
    consoleErrors.length = 0
    await send('Emulation.setDeviceMetricsOverride', { width: item.width, height: item.height, deviceScaleFactor: 1, mobile: item.width <= 360 })
    await send('Page.navigate', { url: `http://127.0.0.1:4178/fixture.html?scenario=${item.scenario}` })
    await waitUntil(send, "document.querySelector('main[aria-label=\"浏览器 Agent\"]') !== null", consoleErrors)
    if (item.setup) { await send('Runtime.evaluate', { expression: item.setup }); await delay(250) }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    const check = await send('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify({focus:{tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim(),outline:getComputedStyle(document.activeElement).outlineStyle},overflow:{document:document.documentElement.scrollWidth>document.documentElement.clientWidth,elements:[...document.querySelectorAll('*')].filter(n=>n.scrollWidth>n.clientWidth+1&&getComputedStyle(n).overflowX==='visible').slice(0,8).map(n=>n.tagName+'.'+n.className)}})` })
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(resolve(output, `${item.name}.png`), Buffer.from(screenshot.data, 'base64'))
    evidence.push({ ...item, setup: undefined, consoleErrors: [...consoleErrors], ...JSON.parse(check.result.value) })
  }
  socket.close()
  await writeFile(resolve(output, 'browser-checks.json'), JSON.stringify(evidence, null, 2))
} finally {
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGTERM')
  await chromeExited
  await rm(profile, { recursive: true, force: true })
}

async function waitForPage(profilePath) {
  for (let count = 0; count < 80; count += 1) {
    try {
      const [portLine] = (await readFile(join(profilePath, 'DevToolsActivePort'), 'utf8')).split('\n')
      const port = Number(portLine)
      if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid DevToolsActivePort')
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
      const page = pages.find((entry) => entry.type === 'page' && !entry.url.startsWith('chrome-extension:'))
      if (page) return page
    } catch {}
    await delay(100)
  }
  throw new Error('Chrome DevTools endpoint did not start')
}
async function waitUntil(send, expression, errors = []) {
  for (let count = 0; count < 100; count += 1) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (result.result.value) return
    await delay(50)
  }
  const state = await send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,body:document.body?.innerText,html:document.documentElement?.outerHTML.slice(0,500)})', returnByValue: true })
  throw new Error(`Fixture did not become ready: ${expression}\n${errors.join('\n')}\n${state.result.value}`)
}
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
