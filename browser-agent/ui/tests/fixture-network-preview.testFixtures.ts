import type { ToolContext, ToolRegistry } from '@einfach-agent/core/tools'
import type { NetworkListResult, NetworkRequestDetails, NetworkResponseDetails } from '@einfach-agent/tools-browser-network'
import { loadCities, loadCitiesWithXhr, type FixtureBusiness } from './fixture-business.testFixtures'

export function mountNetworkPreview(container: HTMLElement, tools: ToolRegistry, business: FixtureBusiness): void {
  const panel = document.createElement('section')
  panel.setAttribute('aria-label', '网络请求演示')
  panel.innerHTML = '<button type="button">演示请求捕获</button><pre aria-live="polite">可读取注入后、对话前的初始化请求。</pre>'
  container.append(panel)
  const button = panel.querySelector('button')!
  const output = panel.querySelector('pre')!
  button.addEventListener('click', () => void runNetworkPreview(tools, business).then(
    (text) => { output.textContent = text },
    (error) => { output.textContent = error instanceof Error ? error.message : '演示失败' },
  ))
}

export async function runNetworkPreview(tools: ToolRegistry, business: FixtureBusiness): Promise<string> {
  await business.initialization
  const ctx = { sessionId: 'fixture-network-preview', signal: new AbortController().signal } as ToolContext
  const capture = await data<{ captureId: string }>(tools, 'start_network_capture', { urlIncludes: '/fixture-api/cities', includeBuffered: true }, ctx)
  const buffered = await data<NetworkListResult>(tools, 'list_network_requests', { captureId: capture.captureId }, ctx)
  const initial = buffered.requests.find((request) => request.resourceType === 'fetch')
  if (!initial) throw new Error('未捕获对话前初始化请求')
  const initialResponse = await data<NetworkResponseDetails>(tools, 'get_network_response', { captureId: capture.captureId, requestId: initial.requestId }, ctx)

  const waiting = data(tools, 'wait_for_network_request', { captureId: capture.captureId, urlIncludes: 'transport=xhr', method: 'GET', state: 'finished' }, ctx)
  await Promise.all([loadCities(business.iframe.contentWindow!, business.iframe.contentDocument!, 'GB'), loadCitiesWithXhr(business.iframe.contentWindow!, 'GB')])
  await waiting
  const latest = await data<NetworkListResult>(tools, 'list_network_requests', { captureId: capture.captureId }, ctx)
  const request = latest.requests.find((item) => item.url.includes('transport=xhr')) ?? latest.requests.at(-1)!
  const details = await data<NetworkRequestDetails>(tools, 'get_network_request', { captureId: capture.captureId, requestId: request.requestId }, ctx)
  const response = await data<NetworkResponseDetails>(tools, 'get_network_response', { captureId: capture.captureId, requestId: request.requestId }, ctx)
  await data(tools, 'stop_network_capture', { captureId: capture.captureId }, ctx)
  return [
    `对话前初始化请求：${initial.method} ${new URL(initial.url).pathname}，状态 ${initial.status ?? '未知'}`,
    `初始化响应：${initialResponse.body ?? initialResponse.reason ?? '无正文'}`,
    `本次共捕获 ${latest.requests.length} 条请求`,
    `最新请求：${details.method} ${new URL(details.url).pathname}，状态 ${details.status ?? response.status ?? '未知'}`,
    `最新响应：${response.body ?? response.reason ?? '无正文'}`,
  ].join('\n')
}

async function data<T>(tools: ToolRegistry, name: string, args: unknown, ctx: ToolContext): Promise<T> {
  const result = await tools.run(name, args, ctx)
  if (!result.ok) throw new Error(result.error)
  return result.data as T
}
