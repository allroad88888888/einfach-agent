export function createFixtureModelFetch(): typeof fetch {
  return async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '这是本地演示响应。请在配置页查看可用工具，或在演示业务页体验表单。' }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } })
}
