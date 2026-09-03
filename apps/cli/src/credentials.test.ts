import { describe, expect, it } from 'vitest'
import { normalizeApiKey } from '@einfach-agent/host-node'
import { requireDeepSeekCredential, resolveModelCredentials } from './credentials'

describe('resolveModelCredentials', () => {
  it('优先使用环境变量且不读取可选配置文件', async () => {
    const credentials = await resolveModelCredentials({
      env: { DEEPSEEK_API_KEY: 'environment-key' },
      configPath: '/tmp/ignored.json',
      readConfigFile: async () => {
        throw new Error('不应读取')
      },
    })

    expect(credentials.modelCredentials.deepseek).toBe('environment-key')
  })

  it('环境变量缺失时从配置文件读取默认 DeepSeek 凭证', async () => {
    const credentials = await resolveModelCredentials({
      env: {},
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({
        modelCredentials: { 'deepseek:default': 'config-key', 'glm:default': 'glm-key' },
      }),
    })

    expect(credentials).toMatchObject({
      modelCredentials: { deepseek: 'config-key', glm: 'glm-key' },
    })
  })

  it('缺少默认凭证时给出环境变量与配置文件两条路径', () => {
    expect(() => requireDeepSeekCredential({
      configPath: '/tmp/config.json', modelCredentials: {}, modelBaseUrls: {},
    })).toThrow(/DEEPSEEK_API_KEY.*modelCredentials/)
  })

  it('openai-compat 的 key 与 baseUrl 都能从环境变量解析（无 DeepSeek 时读配置文件分支）', async () => {
    const credentials = await resolveModelCredentials({
      env: {
        OPENAI_COMPAT_API_KEY: 'gateway-key',
        OPENAI_COMPAT_BASE_URL: 'https://gateway.example/v1',
      },
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({}),
    })

    expect(credentials.modelCredentials['openai-compat']).toBe('gateway-key')
    expect(credentials.modelBaseUrls['openai-compat']).toBe('https://gateway.example/v1')
  })

  it('openai-compat 的 key 与 baseUrl 都能从配置文件解析', async () => {
    const credentials = await resolveModelCredentials({
      env: {},
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({
        modelCredentials: {
          'openai-compat:default': 'config-key',
          'openai-compat:default:baseUrl': 'https://config.example/v1',
        },
      }),
    })

    expect(credentials.modelCredentials['openai-compat']).toBe('config-key')
    expect(credentials.modelBaseUrls['openai-compat']).toBe('https://config.example/v1')
  })

  it('DeepSeek 环境变量短路时，openai-compat 的 baseUrl 仍只认环境变量，不读配置文件', async () => {
    const credentials = await resolveModelCredentials({
      env: {
        DEEPSEEK_API_KEY: 'environment-key',
        OPENAI_COMPAT_BASE_URL: 'https://gateway.example/v1',
      },
      configPath: '/tmp/ignored.json',
      readConfigFile: async () => {
        throw new Error('不应读取')
      },
    })

    expect(credentials.modelBaseUrls['openai-compat']).toBe('https://gateway.example/v1')
  })

  it('没有配置 openai-compat 时 modelBaseUrls 里不出现它', async () => {
    const credentials = await resolveModelCredentials({
      env: {},
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({}),
    })

    expect(credentials.modelBaseUrls['openai-compat']).toBeUndefined()
  })

  it('使用 host 的 API Key 归一化规则处理配置文件中的空白与超长值', async () => {
    const overlong = 'k'.repeat(1_025)
    const credentials = await resolveModelCredentials({
      env: {},
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({
        modelCredentials: {
          'deepseek:default': ' key ',
          'glm:default': '   ',
          'kimi:cn': overlong,
        },
      }),
    })

    expect(credentials.modelCredentials).toEqual({
      deepseek: normalizeApiKey(' key '),
    })
    expect(credentials.modelCredentials.glm).toBe(normalizeApiKey('   '))
    expect(credentials.modelCredentials.kimi).toBe(normalizeApiKey(overlong))
  })

  it('拒绝含非字符串成员的完整 modelCredentials 段', async () => {
    await expect(resolveModelCredentials({
      env: {},
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({
        modelCredentials: { 'deepseek:default': 'key', unrelated: 1 },
      }),
    })).rejects.toThrow('模型配置文件格式无效')
  })

  it.each([
    ['https://gateway.example/v1/', 'https://gateway.example/v1'],
    ['http://127.0.0.1:8080/v1/', 'http://127.0.0.1:8080/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
  ])('归一化接受安全的 openai-compat 环境接入点：%s', async (input, expected) => {
    const credentials = await resolveModelCredentials({
      env: { OPENAI_COMPAT_BASE_URL: input },
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({}),
    })

    expect(credentials.modelBaseUrls['openai-compat']).toBe(expected)
  })

  it.each([
    'http://gateway.example/v1',
    'https://user:pass@gateway.example/v1',
    'https://gateway.example/v1?key=secret',
    'https://gateway.example/v1#fragment',
  ])('拒绝不安全的 openai-compat 环境接入点：%s', async (input) => {
    const credentials = await resolveModelCredentials({
      env: { OPENAI_COMPAT_BASE_URL: input },
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({}),
    })

    expect(credentials.modelBaseUrls['openai-compat']).toBeUndefined()
  })

  it('环境接入点优先于配置文件，并保留 host 的归一化结果', async () => {
    const credentials = await resolveModelCredentials({
      env: { OPENAI_COMPAT_BASE_URL: 'https://environment.example/v1/' },
      configPath: '/tmp/config.json',
      readConfigFile: async () => JSON.stringify({
        modelCredentials: { 'openai-compat:default:baseUrl': 'https://config.example/v1' },
      }),
    })

    expect(credentials.modelBaseUrls['openai-compat']).toBe('https://environment.example/v1')
  })
})
