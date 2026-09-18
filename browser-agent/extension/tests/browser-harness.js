import './browser-runtime-harness.js'

const result = document.querySelector('#result')
document.querySelector('#run').addEventListener('click', async () => {
  const report = { panelOpened: false, panelClosed: false, panelOpenCount: 0 }
  chrome.sidePanel.onOpened.addListener(() => { report.panelOpened = true; report.panelOpenCount += 1 })
  chrome.sidePanel.onClosed.addListener(() => { report.panelClosed = true })
  try {
    const origin = `http://127.0.0.1:${location.hash.slice(1)}`
    report.permission = await chrome.permissions.request({ origins: [`${origin}/*`] })
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((item) => item.url?.startsWith('http://127.0.0.1:'))
    if (!tab) throw new Error(`Fixture tab not found: ${JSON.stringify(tabs.map((item) => item.url))}`)
    const handshake = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: tab.id, frameId: 0 })
    report.handshake = handshake
    if (!handshake.ok) throw new Error(handshake.error)
    const target = handshake.data
    const secondary = await chrome.tabs.create({ url: `${origin}/second-tab`, active: true })
    report.pinnedRead = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'pinned-1', target, sessionId: 'browser-e2e', method: 'readForm' })
    await chrome.tabs.remove(secondary.id)
    report.read = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'read-1', target, sessionId: 'browser-e2e', method: 'readForm' })
    const fields = report.read.data.fields
    const name = fields.find((field) => field.label === 'Name')
    const city = fields.find((field) => field.label.startsWith('City'))
    report.fill = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'fill-1', target, sessionId: 'browser-e2e', method: 'fillFields', input: { page: report.read.data.page, values: [{ id: name.id, value: 'Ada' }, { id: city.id, value: 'shanghai' }] } })
    report.validate = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'validate-1', target, sessionId: 'browser-e2e', method: 'validateForm', input: { page: report.read.data.page } })
    result.textContent = JSON.stringify({ stage: 'runtime', report }, null, 2)
    report.runtime = await window.runRuntimeHarness(target)
    await chrome.tabs.reload(tab.id)
    await new Promise((resolve) => setTimeout(resolve, 700))
    report.reloadOldTarget = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'reload-old', target, sessionId: 'browser-e2e', method: 'readForm' })
    const rebound = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: tab.id, frameId: 0 })
    if (!rebound.ok) throw new Error(rebound.error)
    report.reloadNewTarget = rebound.data
    report.reloadRead = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'reload-new', target: rebound.data, sessionId: 'browser-e2e', method: 'readForm' })
    const pendingCancel = chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'cancel-real', target: rebound.data, sessionId: 'browser-e2e', method: 'readForm' })
    report.cancel = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'cancel-page-call', requestId: 'cancel-real', target: rebound.data })
    report.cancelledCall = await pendingCancel
    const currentWindow = await chrome.windows.getCurrent()
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.sidePanel.open({ windowId: currentWindow.id })
    document.documentElement.dataset.panel = 'open'
    for (let index = 0; index < 600 && !window.closePanelForTest; index += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    await chrome.sidePanel.close({ windowId: currentWindow.id })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await chrome.sidePanel.open({ windowId: currentWindow.id })
    document.documentElement.dataset.panel = 'reopened'
    for (let index = 0; index < 300 && !window.finishReopenInspection; index += 1) await new Promise((resolve) => setTimeout(resolve, 100))
    await new Promise((resolve) => setTimeout(resolve, 500))
    await chrome.sidePanel.close({ windowId: currentWindow.id })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await chrome.tabs.update(tab.id, { url: `${origin}/after-navigation` })
    await new Promise((resolve) => setTimeout(resolve, 500))
    report.stale = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'stale-1', target, sessionId: 'browser-e2e', method: 'readForm' })
    report.ok = report.permission && report.pinnedRead.ok && report.read.ok && report.fill.ok && report.validate.ok && report.runtime.ok && !report.reloadOldTarget.ok && report.reloadRead.ok && report.reloadNewTarget.documentId !== target.documentId && report.cancel.ok && !report.stale.ok && report.panelOpened
  } catch (error) { report.error = String(error); report.ok = false }
  result.textContent = JSON.stringify(report, null, 2)
  document.documentElement.dataset.done = 'true'
})
document.documentElement.dataset.ready = 'true'
