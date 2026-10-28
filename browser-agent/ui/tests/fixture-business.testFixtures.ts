import { createApiToolsHost, type OptionsSource } from '@einfach-agent/tools-browser-api'
import { createWindowNetworkHost, installWindowNetworkRecorder, type NetworkToolsHost } from '@einfach-agent/tools-browser-network'
import { createDomPageHost, type PageToolsHost } from '@einfach-agent/tools-browser-page'
import { createDomToolsHost, type DomToolsHost } from '@einfach-agent/tools-browser-dom'

export interface FixtureBusiness {
  iframe: HTMLIFrameElement
  pageHost: PageToolsHost
  domHost: DomToolsHost
  apiHost: ReturnType<typeof createApiToolsHost>
  networkHost: NetworkToolsHost & { dispose(): void }
  initialization: Promise<unknown>
  dispose(): void
}

export async function createFixtureBusiness(container: HTMLElement, configureWindow?: (window: Window) => void): Promise<FixtureBusiness> {
  const iframe = document.createElement('iframe')
  iframe.title = '演示业务页面'
  iframe.dataset.fixtureBusiness = 'isolated'
  container.append(iframe)
  const businessWindow = iframe.contentWindow
  const businessDocument = iframe.contentDocument
  if (!businessWindow || !businessDocument) throw new Error('无法访问同源演示页面')
  configureWindow?.(businessWindow)
  const recorder = installWindowNetworkRecorder({ window: businessWindow })
  const networkHost = createWindowNetworkHost({ window: businessWindow, targetId: 'fixture-business-frame', documentId: 'fixture-business-document' })
  businessDocument.open(); businessDocument.write(markup); businessDocument.close()
  wireDependentOptions(businessDocument)
  wireCustomSelect(businessDocument)
  const initialization = loadCities(businessWindow, businessDocument, 'CN')
  const pageHost = createDomPageHost({ document: businessDocument, targetId: 'fixture-business-frame', documentId: 'fixture-business-document' })
  const source: OptionsSource = {
    id: 'fixture-cities', label: '演示城市目录', description: '根据国家筛选演示城市候选项。',
    async query(input, ctx) {
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const all = cityOptions[String(input.parameters?.country ?? '')] ?? []
      const query = input.query?.trim().toLocaleLowerCase()
      return { options: query ? all.filter((item) => item.label.toLocaleLowerCase().includes(query)) : all }
    },
  }
  return {
    iframe, pageHost, domHost: createDomToolsHost({ document: businessDocument, targetId: 'fixture-business-frame', documentId: 'fixture-business-document' }), networkHost, initialization,
    apiHost: createApiToolsHost([source], { isSourceAllowed: (_sourceId, sessionId) => Boolean(sessionId) }),
    dispose() { networkHost.dispose(); recorder.dispose(); iframe.remove() },
  }
}

function wireCustomSelect(document: Document): void {
  const trigger = document.querySelector<HTMLButtonElement>('[data-ticket-trigger]')!
  const list = document.querySelector<HTMLElement>('[data-ticket-options]')!
  trigger.addEventListener('click', () => setTimeout(() => { list.hidden = false; trigger.setAttribute('aria-expanded', 'true') }, 30))
  list.addEventListener('click', (event) => {
    const option = (event.target as Element).closest('[data-ticket-option]')
    if (!option) return
    document.querySelector<HTMLElement>('[data-ticket-value]')!.textContent = option.textContent
    list.hidden = true; trigger.setAttribute('aria-expanded', 'false')
  })
}

const cityOptions: Record<string, readonly { label: string; value: string }[]> = {
  CN: [{ label: '上海', value: 'shanghai' }, { label: '北京', value: 'beijing' }],
  GB: [{ label: '伦敦', value: 'london' }, { label: '曼彻斯特', value: 'manchester' }],
}

function wireDependentOptions(document: Document): void {
  const country = document.querySelector<HTMLSelectElement>('#country')!
  const city = document.querySelector<HTMLSelectElement>('#city')!
  const refresh = () => city.replaceChildren(...(cityOptions[country.value] ?? []).map(({ label, value }) => new Option(label, value)))
  country.addEventListener('change', refresh); refresh()
  setTimeout(() => {
    const asynchronous = document.querySelector<HTMLSelectElement>('#async-team')
    asynchronous?.append(new Option('平台工程', 'platform'), new Option('产品设计', 'design'))
    asynchronous?.removeAttribute('aria-busy')
  }, 30)
}

export async function loadCities(window: Window, document: Document, country: string): Promise<unknown> {
  const url = new URL(`/fixture-api/cities?country=${encodeURIComponent(country)}`, window.parent.location.href)
  const response = await window.fetch(url)
  const payload = await response.json() as { cities?: Array<{ label: string; value: string }> }
  const city = document.querySelector<HTMLSelectElement>('#city')
  if (city && payload.cities) city.replaceChildren(...payload.cities.map(({ label, value }) => new Option(label, value)))
  return payload
}

export function loadCitiesWithXhr(window: Window, country: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new window.XMLHttpRequest()
    request.open('GET', new URL(`/fixture-api/cities?country=${encodeURIComponent(country)}&transport=xhr`, window.parent.location.href))
    request.addEventListener('load', () => resolve(), { once: true })
    request.addEventListener('error', () => reject(new Error('演示 XHR 请求失败')), { once: true })
    request.send()
  })
}

const markup = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>差旅申请演示</title></head><body>
<main><h1>差旅申请</h1><form><label>申请人 <input id="applicant" name="applicant" required value="林晓"></label>
<label>国家 <select id="country" name="country"><option value="CN">中国</option><option value="GB">英国</option></select></label><label>城市 <select id="city" name="city"></select></label>
<fieldset><legend>交通方式</legend><label><input type="radio" name="transport" value="rail" checked>火车</label><label><input type="radio" name="transport" value="air">飞机</label></fieldset>
<label>同行服务 <select id="services" name="services" multiple><option value="hotel">酒店</option><option value="pickup">接送</option></select></label><label><input id="policy" name="policy" type="checkbox">已阅读差旅政策</label>
<label>所属团队 <select id="async-team" name="team" aria-busy="true"></select></label></form>
<section data-ticket-select><h2>非原生工单类型</h2><div data-ticket-trigger aria-expanded="false" tabindex="0">选择工单类型</div><span data-ticket-value>尚未选择</span><div data-ticket-options hidden><span data-ticket-option>功能建议</span><span data-ticket-option>安全漏洞</span><span data-ticket-option>账号问题</span></div></section>
<table><caption>近期申请</caption><thead><tr><th>申请人</th><th>城市</th><th>状态</th></tr></thead><tbody><tr><td>周宁</td><td>上海</td><td>已批准</td></tr><tr><td>沈悦</td><td>伦敦</td><td>待审核</td></tr></tbody></table></main></body></html>`
