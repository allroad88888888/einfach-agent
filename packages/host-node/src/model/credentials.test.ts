import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_DIRECTORY_ENV } from '../config/configPaths'
import {
  credentialConfigKey,
  normalizeApiKey,
  readActiveModelCredential,
  readConfiguredModelCredential,
} from './credentials'

let home: string
let savedOverride: string | undefined

async function writeConfig(contents: string): Promise<void> {
  const directory = join(home, '.webAgent')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'config.json'), contents)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'web-agent-model-credentials-'))
  // 开发机上真设了这个变量时，不隔离的话本文件会去读用户的真实配置（里面有真 Key）。
  savedOverride = process.env[CONFIG_DIRECTORY_ENV]
  delete process.env[CONFIG_DIRECTORY_ENV]
})

afterEach(async () => {
  if (savedOverride === undefined) delete process.env[CONFIG_DIRECTORY_ENV]
  else process.env[CONFIG_DIRECTORY_ENV] = savedOverride
  await rm(home, { recursive: true, force: true })
})

describe('凭证绑定', () => {
  it('三对固定绑定，作用域配错是受控失败', () => {
    expect(credentialConfigKey('deepseek', 'default')).toBe('deepseek:default')
    expect(credentialConfigKey('glm', 'default')).toBe('glm:default')
    expect(credentialConfigKey('kimi', 'cn')).toBe('kimi:cn')
    expect(() => credentialConfigKey('kimi', 'default')).toThrow('模型凭证作用域未获允许')
    expect(() => credentialConfigKey('deepseek', 'cn')).toThrow('模型凭证作用域未获允许')
  })

  it('归一化：去首尾空白，空与超长都算没配置', () => {
    // 配置文件里留一个 " " 是常见的手写残留。当成有效 Key 会让请求带着空 Bearer 打上去，
    // 换回一条 401，而用户看到的提示与「没配置」完全不同。
    expect(normalizeApiKey(' key ')).toBe('key')
    expect(normalizeApiKey('   ')).toBeUndefined()
    expect(normalizeApiKey('k'.repeat(1_025))).toBeUndefined()
    expect(normalizeApiKey('k'.repeat(1_024))).toBe('k'.repeat(1_024))
    expect(normalizeApiKey(undefined)).toBeUndefined()
  })
})

describe('从 N7 的配置里读 Key', () => {
  it('读的是 modelCredentials 段里那一个键', async () => {
    await writeConfig(
      '{"version":1,"modelCredentials":{"deepseek:default":" sk-config ","kimi:cn":"sk-kimi"},"mcp":{"servers":[]}}',
    )
    await expect(readActiveModelCredential({ homeDir: home }, 'deepseek', 'default')).resolves.toBe(
      'sk-config',
    )
    await expect(readActiveModelCredential({ homeDir: home }, 'kimi', 'cn')).resolves.toBe('sk-kimi')
  })

  it('没配置时的错误只带展示名，不带键、不带配置路径', async () => {
    await writeConfig('{"version":1}')
    await expect(
      readActiveModelCredential({ homeDir: home }, 'glm', 'default'),
    ).rejects.toThrow('未配置 GLM API Key')
    await expect(
      readConfiguredModelCredential({ homeDir: home }, 'glm', 'default'),
    ).resolves.toBeUndefined()
  })

  it('配置文件不存在时也是「没配置」，不是读取失败', async () => {
    await expect(
      readActiveModelCredential({ homeDir: home }, 'deepseek', 'default'),
    ).rejects.toThrow('未配置 DeepSeek API Key')
  })

  it('段被写坏时整段受控失败，不是当成没配置', async () => {
    // Rust 反序列化整张 BTreeMap<String,String>，一条坏值就整段失败。只判目标键会让
    // 「配置文件坏了」在两个宿主上给出不同答案。
    await writeConfig('{"version":1,"modelCredentials":"oops"}')
    await expect(
      readActiveModelCredential({ homeDir: home }, 'deepseek', 'default'),
    ).rejects.toThrow('模型配置文件格式无效')
    await writeConfig('{"version":1,"modelCredentials":{"deepseek:default":123}}')
    await expect(
      readActiveModelCredential({ homeDir: home }, 'deepseek', 'default'),
    ).rejects.toThrow('模型配置文件格式无效')
  })

  it('mcp 段与 modelCredentials 段互不可见', async () => {
    // 凭证边界落在**段名**上：mcp_config_read 请求的段名恒为 mcp，所以它既读不到也写不到 Key。
    // 反过来本文件请求的段名恒为 modelCredentials，mcp 段里放什么都影响不到它。
    await writeConfig(
      '{"version":1,"mcp":{"deepseek:default":"sk-not-a-credential"},"modelCredentials":{"deepseek:default":"sk-real"}}',
    )
    await expect(readActiveModelCredential({ homeDir: home }, 'deepseek', 'default')).resolves.toBe(
      'sk-real',
    )
  })
})
