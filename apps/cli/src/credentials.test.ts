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
      configPath: '/tmp/config.json', modelCredentials: {},
    })).toThrow(/DEEPSEEK_API_KEY.*modelCredentials/)
  })
})
