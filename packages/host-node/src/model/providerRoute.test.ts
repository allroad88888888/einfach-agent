import { describe, expect, it } from 'vitest'
import {
  narrowProviderTarget,
  resolveProviderTarget,
  type RegisteredProviderOrigins,
} from './providerRoute'

/** 默认**什么都没登记**：登记式条目在这个前提下必须一律落空。 */
function target(value: unknown, registered: RegisteredProviderOrigins = {}) {
  return resolveProviderTarget(narrowProviderTarget(value), registered)
}

const OPENAI_COMPAT_CHAT = {
  provider: 'openai-compat',
  scope: 'default',
  method: 'POST',
  path: '/chat/completions',
} as const

describe('端点白名单', () => {
  // 与 model_provider_route.rs 的五个 match 臂逐条对照。这张表是本域安全性的全部，
  // 少一条是功能缺失，多一条是把 Key 的使用面扩大了。
  it.each([
    ['deepseek', 'default', 'POST', '/chat/completions', 'https://api.deepseek.com/chat/completions', 'json', 32 * 1024 * 1024],
    ['deepseek', 'default', 'POST', '/files', 'https://api.deepseek.com/files', 'multipart', 4 * 1024 * 1024],
    ['deepseek', 'default', 'DELETE', '/files/file-api-image_123-A-b', 'https://api.deepseek.com/files/file-api-image_123-A-b', 'none', 1024 * 1024],
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

  it('DeepSeek DELETE 只认 file-api- 前缀的单层资源 ID', () => {
    const invalidPaths = [
      '/files/file_123',
      '/files/file-api-',
      '/files/file-api-image?query=1',
      '/files/file-api-image/child',
      '/files/file-api-image.one',
      `/files/file-api-${'a'.repeat(248)}`,
    ]
    for (const path of invalidPaths) {
      expect(() => target({
        provider: 'deepseek', scope: 'default', method: 'DELETE', path,
      })).toThrow('模型请求目标未获允许')
    }
    expect(target({
      provider: 'deepseek', scope: 'default', method: 'DELETE',
      path: `/files/file-api-${'a'.repeat(247)}`,
    }).url).toBe(`https://api.deepseek.com/files/file-api-${'a'.repeat(247)}`)
  })

  it('文件端点不扩展到其他 provider 或方法', () => {
    for (const value of [
      { provider: 'glm', scope: 'default', method: 'POST', path: '/files' },
      { provider: 'glm', scope: 'default', method: 'DELETE', path: '/files/file-api-x' },
      { provider: 'deepseek', scope: 'default', method: 'POST', path: '/files/file-api-x' },
    ]) {
      expect(() => target(value)).toThrow('模型请求目标未获允许')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// openai-compat：origin 由用户登记，「精确匹配一个已知 origin」这个前提在它身上不成立。
// 替代约束是「只放行那一条显式登记的、且过得了判据的地址」，这一组就是它的判据集。
describe('登记式 origin（openai-compat）', () => {
  it('登记过就按登记的那条拼 URL，路径仍是字面量全等的 chat 端点', () => {
    expect(target(OPENAI_COMPAT_CHAT, { openAiCompat: 'https://gateway.example.com/v1' }))
      .toEqual({
        provider: 'openai-compat',
        scope: 'default',
        method: 'POST',
        url: 'https://gateway.example.com/v1/chat/completions',
        bodyKind: 'json',
        maxResponseBytes: 32 * 1024 * 1024,
      })
  })

  it('connectionId survives target narrowing but never supplies an origin', () => {
    const narrowed = narrowProviderTarget({ ...OPENAI_COMPAT_CHAT, connectionId: 'profile-a' })
    expect(narrowed.connectionId).toBe('profile-a')
    expect(() => resolveProviderTarget(narrowed)).toThrow('模型请求目标未获允许')
    expect(resolveProviderTarget(narrowed, { openAiCompat: 'https://profile.example/v1' }).url)
      .toBe('https://profile.example/v1/chat/completions')
  })

  it('**没登记就是目标未获允许**——不存在「猜一个默认接入点」的分支', () => {
    expect(() => target(OPENAI_COMPAT_CHAT)).toThrow('模型请求目标未获允许')
    expect(() => target(OPENAI_COMPAT_CHAT, {})).toThrow('模型请求目标未获允许')
    expect(() => target(OPENAI_COMPAT_CHAT, { openAiCompat: undefined }))
      .toThrow('模型请求目标未获允许')
  })

  it('不传第二个参数默认就是「什么都没登记」，fail closed 而不是 fail open', () => {
    // 忘了把配置里的登记传进来时，后果必须是打不出去，而不是打到某个默认地址。
    expect(() => resolveProviderTarget(narrowProviderTarget(OPENAI_COMPAT_CHAT)))
      .toThrow('模型请求目标未获允许')
  })

  it('登记值仍要当场过判据——白名单是最后一道，它不判就没人判了', () => {
    // 这些值走 model_endpoint_set 时进不来，但配置文件是用户可以手改的，不是可信输入。
    for (const smuggled of [
      'http://evil.example.com/v1',
      'https://user:pass@gateway.example.com/v1',
      'https://gateway.example.com/v1?key=leak',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(() => target(OPENAI_COMPAT_CHAT, { openAiCompat: smuggled }))
        .toThrow('模型请求目标未获允许')
    }
  })

  it('回环上的明文 http 放行（自建网关的典型形态）', () => {
    expect(target(OPENAI_COMPAT_CHAT, { openAiCompat: 'http://127.0.0.1:8080/v1' }).url)
      .toBe('http://127.0.0.1:8080/v1/chat/completions')
  })

  it('登记的地址末尾斜杠不会拼出双斜杠', () => {
    expect(target(OPENAI_COMPAT_CHAT, { openAiCompat: 'https://gateway.example.com/v1/' }).url)
      .toBe('https://gateway.example.com/v1/chat/completions')
  })

  it('方法与路径这一维没有放宽：只有 POST /chat/completions', () => {
    const registered = { openAiCompat: 'https://gateway.example.com/v1' }
    for (const value of [
      // 它的 adapter 不上传文件，因此没有 /files，也没有 DELETE。
      { ...OPENAI_COMPAT_CHAT, path: '/files' },
      { ...OPENAI_COMPAT_CHAT, method: 'DELETE', path: '/files/abc' },
      { ...OPENAI_COMPAT_CHAT, path: '/embeddings' },
      { ...OPENAI_COMPAT_CHAT, path: '/chat/completions/' },
      { ...OPENAI_COMPAT_CHAT, path: '/chat/completions?stream=true' },
      { ...OPENAI_COMPAT_CHAT, path: '/../../admin' },
      // 作用域只有 default。
      { ...OPENAI_COMPAT_CHAT, scope: 'cn' },
    ]) {
      expect(() => target(value, registered)).toThrow('模型请求目标未获允许')
    }
  })

  it('登记一条 origin 不会把别家的端点也挪过去', () => {
    // 登记值只喂给 openai-compat 那一条：前三家的 origin 是常量，登记再多也动不了它们。
    const registered = { openAiCompat: 'https://gateway.example.com/v1' }
    expect(target({ provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions' }, registered).url)
      .toBe('https://api.deepseek.com/chat/completions')
    expect(target({ provider: 'kimi', scope: 'cn', method: 'POST', path: '/files' }, registered).url)
      .toBe('https://api.moonshot.cn/v1/files')
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
      { ...OPENAI_COMPAT_CHAT, connectionId: '' },
      { ...OPENAI_COMPAT_CHAT, connectionId: 'UPPERCASE' },
      { ...OPENAI_COMPAT_CHAT, connectionId: 42 },
      { provider: 'deepseek', method: 'POST', path: '/chat/completions', connectionId: 'profile-a' },
      { ...OPENAI_COMPAT_CHAT, connectionId: 'profile-a', headers: { authorization: 'secret' } },
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
