import { describe, expect, it } from 'vitest'
import { narrowProviderTarget, resolveProviderTarget } from './providerRoute'

function target(value: unknown) {
  return resolveProviderTarget(narrowProviderTarget(value))
}

describe('端点白名单', () => {
  // 与 model_provider_route.rs 的五个 match 臂逐条对照。这张表是本域安全性的全部，
  // 少一条是功能缺失，多一条是把 Key 的使用面扩大了。
  it.each([
    ['deepseek', 'default', 'POST', '/chat/completions', 'https://api.deepseek.com/chat/completions', 'json', 32 * 1024 * 1024],
    ['glm', 'default', 'POST', '/chat/completions', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'json', 32 * 1024 * 1024],
    ['kimi', 'cn', 'POST', '/chat/completions', 'https://api.moonshot.cn/v1/chat/completions', 'json', 32 * 1024 * 1024],
    ['kimi', 'cn', 'POST', '/files', 'https://api.moonshot.cn/v1/files', 'multipart', 4 * 1024 * 1024],
    ['kimi', 'cn', 'DELETE', '/files/file_123.A-b', 'https://api.moonshot.cn/v1/files/file_123.A-b', 'none', 1024 * 1024],
  ])('允许 %s/%s %s %s', (provider, scope, method, path, url, bodyKind, maxResponseBytes) => {
    expect(target({ provider, scope, method, path })).toEqual({
      provider,
      scope,
      method,
      url,
      bodyKind,
      maxResponseBytes,
    })
  })

  it('作用域配错的组合一律拒绝', () => {
    // Kimi 只有 cn，DeepSeek / GLM 只有 default。放行任何一个都会去打一个不存在的 origin。
    for (const value of [
      { provider: 'kimi', scope: 'default', method: 'POST', path: '/chat/completions' },
      { provider: 'deepseek', scope: 'cn', method: 'POST', path: '/chat/completions' },
      { provider: 'glm', scope: 'cn', method: 'POST', path: '/chat/completions' },
      // scope 缺席时按 serde 的 default 取 'default'，于是 Kimi 同样落空
      { provider: 'kimi', method: 'POST', path: '/files' },
    ]) {
      expect(() => target(value)).toThrow('模型请求目标未获允许')
    }
  })

  it('路径必须字面全等，不接受前后缀与 query', () => {
    for (const path of [
      '/chat/completions/',
      '/chat/completions?stream=true',
      '/v1/chat/completions',
      '/files/',
      '/embeddings',
    ]) {
      expect(() =>
        target({ provider: 'deepseek', scope: 'default', method: 'POST', path }),
      ).toThrow('模型请求目标未获允许')
    }
  })

  it('删除路径只认单层资源 ID', () => {
    // Rust `accepts_only_safe_delete_paths` 的同款清单：越界、query、多层全部落选。
    for (const path of ['/files/', '/files/../key', '/files/key?query', '/files/x/y', '/files/a b']) {
      expect(() => target({ provider: 'kimi', scope: 'cn', method: 'DELETE', path })).toThrow(
        '模型请求目标未获允许',
      )
    }
    expect(() =>
      target({ provider: 'kimi', scope: 'cn', method: 'DELETE', path: `/files/${'a'.repeat(257)}` }),
    ).toThrow('模型请求目标未获允许')
  })

  it('DELETE 只对 Kimi 的文件端点开放', () => {
    expect(() =>
      target({ provider: 'deepseek', scope: 'default', method: 'DELETE', path: '/files/x' }),
    ).toThrow('模型请求目标未获允许')
  })
})

describe('target 的收窄', () => {
  it('拒绝多余字段——这是防开放代理的那一道', () => {
    // Rust `rejects_unknown_target_fields` 的等价用例：往 target 里塞一个 url，今天没人读它，
    // 哪天有人顺手读了就直接变成开放代理。
    expect(() =>
      narrowProviderTarget({
        provider: 'kimi',
        scope: 'cn',
        method: 'POST',
        path: '/files',
        url: 'https://evil.test',
      }),
    ).toThrow('模型请求格式无效')
  })

  it('缺少必填字段、类型不对、供应商/方法不在闭合集内都是格式无效', () => {
    for (const value of [
      undefined,
      null,
      'deepseek',
      [],
      { scope: 'default', method: 'POST', path: '/chat/completions' },
      { provider: 'deepseek', method: 'POST' },
      { provider: 'deepseek', method: 'POST', path: 123 },
      { provider: 'openai', method: 'POST', path: '/chat/completions' },
      { provider: 'deepseek', method: 'PUT', path: '/chat/completions' },
      { provider: 'deepseek', scope: 'us', method: 'POST', path: '/chat/completions' },
    ]) {
      expect(() => narrowProviderTarget(value)).toThrow('模型请求格式无效')
    }
  })

  it('scope 缺席补 default，键存在但为 undefined 也一样', () => {
    // 进程内注入时可选键会「存在且为 undefined」，走 HTTP 时同一份入参里那个键会被丢掉。
    // 两种形态必须得到同一个结果，否则同一份请求在两种传输下行为不同。
    const withoutKey = narrowProviderTarget({
      provider: 'deepseek',
      method: 'POST',
      path: '/chat/completions',
    })
    const withUndefined = narrowProviderTarget({
      provider: 'deepseek',
      scope: undefined,
      method: 'POST',
      path: '/chat/completions',
    })
    expect(withoutKey.scope).toBe('default')
    expect(withUndefined).toEqual(withoutKey)
  })
})
