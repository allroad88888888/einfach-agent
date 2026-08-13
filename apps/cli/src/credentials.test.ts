import { describe, expect, it } from 'vitest'
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
})
