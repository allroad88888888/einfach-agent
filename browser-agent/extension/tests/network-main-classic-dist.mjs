import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)))
execFileSync('pnpm', ['--dir', extensionRoot, 'build'], { stdio: 'inherit' })

const bundle = readFileSync(join(extensionRoot, 'dist/network-main.js'), 'utf8')
assert.ok(bundle.startsWith('(() => {'), 'network-main dist must have a private classic-script scope')

const dom = new JSDOM('<!doctype html>', { url: 'https://allowed.test/', runScripts: 'outside-only' })
const page = dom.window
Object.assign(page, { Response, Headers, Request, ReadableStream, TextEncoder })
page.fetch = async () => new Response('early response body', { status: 200, headers: { 'content-type': 'text/plain' } })

try {
  page.eval(bundle)
  await page.fetch('/before-second-injection')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const firstGateway = page.__einfachBrowserAgentNetworkGateway__
  assert.ok(firstGateway, 'first classic-script evaluation must install the gateway')

  page.eval(bundle)
  assert.equal(page.__einfachBrowserAgentNetworkGateway__, firstGateway, 'same-version reinjection must preserve the gateway')

  const listed = await firstGateway.call('session', 'main-frame', 'document', 'list', 'listRequests', {})
  assert.equal(listed.capture.scope, 'document')
  assert.equal(listed.requests.length, 1)
  assert.match(listed.requests[0].url, /before-second-injection/)

  const response = await firstGateway.call('session', 'main-frame', 'document', 'response', 'getResponse', {
    captureId: listed.capture.captureId,
    requestId: listed.requests[0].requestId,
  })
  assert.equal(response.body, 'early response body')
  console.log('classic dist reinjection passed: gateway, request, and response body survived')
} finally {
  page.__einfachBrowserAgentNetworkGateway__?.dispose()
  dom.window.close()
}
