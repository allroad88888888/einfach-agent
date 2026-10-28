import type { ToolContext, ToolRegistry } from '@einfach-agent/core/tools'
import type { DomActionResult, DomSnapshot } from '@einfach-agent/tools-browser-dom'
import type { FixtureBusiness } from './fixture-business.testFixtures'

export function mountDomPreview(container: HTMLElement, tools: ToolRegistry, business: FixtureBusiness): void {
  const panel = document.createElement('section')
  panel.setAttribute('aria-label', 'DOM选择演示')
  panel.innerHTML = '<button type="button">运行DOM选择演示</button><pre aria-live="polite">将通过真实工具registry选择“安全漏洞”。</pre>'
  container.append(panel)
  const output = panel.querySelector('pre')!
  panel.querySelector('button')!.addEventListener('click', () => void runDomPreview(tools, business).then(
    (text) => { output.textContent = text },
    (error) => { output.textContent = error instanceof Error ? error.message : '演示失败' },
  ))
}

export async function runDomPreview(tools: ToolRegistry, business: FixtureBusiness): Promise<string> {
  const ctx = { sessionId: 'fixture-dom-preview', signal: new AbortController().signal } as ToolContext
  const initial = await data<DomSnapshot>(tools, 'read_dom', { text: '选择工单类型' }, ctx)
  const trigger = initial.nodes.find((node) => node.name.includes('选择工单类型'))
  if (!trigger) throw new Error('未读取到自定义下拉触发器')
  await data<DomActionResult>(tools, 'click_dom', { page: initial.page, ref: trigger.ref }, ctx)
  const options = await data<DomSnapshot>(tools, 'wait_for_dom', { page: initial.page, scopeRef: trigger.parentRef, text: '安全漏洞', timeoutMs: 1000 }, ctx)
  const option = options.nodes.find((node) => node.name.includes('安全漏洞'))
  if (!option) throw new Error('异步候选中没有安全漏洞')
  await data<DomActionResult>(tools, 'click_dom', { page: initial.page, ref: option.ref }, ctx)
  const verified = await data<DomSnapshot>(tools, 'read_dom', { page: initial.page, scopeRef: trigger.parentRef, text: '安全漏洞' }, ctx)
  if (!verified.nodes.some((node) => node.name.includes('安全漏洞'))) throw new Error('回读未确认安全漏洞')
  if (!business.iframe.contentDocument?.querySelector<HTMLElement>('[data-ticket-options]')?.hidden) throw new Error('选择后候选弹层仍然打开')
  return ['1. read_dom：按可见文字找到自定义下拉', '2. click_dom：展开普通 div/span 异步候选', '3. wait_for_dom：在已观察父节点内看到“安全漏洞”', '4. click_dom：选择候选', '5. read_dom：候选关闭后回读显示值“安全漏洞”'].join('\n')
}

async function data<T>(tools: ToolRegistry, name: string, args: unknown, ctx: ToolContext): Promise<T> {
  const result = await tools.run(name, args, ctx)
  if (!result.ok) throw new Error(result.error)
  return result.data as T
}
