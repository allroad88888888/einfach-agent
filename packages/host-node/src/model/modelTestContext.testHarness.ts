// 本域测试共用的夹具：一个隔离的配置主目录 + 一张干净的在飞请求表 + 假上游的登记与收尾
// ---------------------------------------------------------------------------
// 三份测试（转发、上游限额与超时、取消）用的是同一套前置条件，抽出来是为了让「隔离」这件事
// 只写一遍。两条必须每次都做对的：
//   · **必须清掉 `WEB_AGENT_CONFIG_DIR`**。开发机上真设了这个变量时，不清就会去读运行测试那个人的
//     真实配置——里面有真的 API Key。
//   · **每个用例一张新的取消表**。共用进程级那张会让「表回到 0」这类断言互相干扰，而那正是
//     泄漏检测唯一的可观测形态。

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { CONFIG_DIRECTORY_ENV } from '../config/configPaths'
import { createModelRequestRegistry, type ModelRequestRegistry } from './requestRegistry'
import { startFakeUpstream, type FakeUpstream, type UpstreamHandler } from './upstreamServer.testHarness'
import type { ForwardProviderRequestDeps } from './forwardRequest'

/** 一把**已知**的 Key。「不外泄」的断言全拿它当探针。 */
export const TEST_API_KEY = 'sk-secret-model-domain-probe-0123456789'

export interface ModelTestContext {
  /** 本用例的临时主目录（`<home>/.webAgent/config.json` 就是那份配置）。 */
  readonly home: string
  /** 本用例独占的在飞请求表。 */
  readonly registry: ModelRequestRegistry
  /** 覆写 `modelCredentials` 段。默认已写好 deepseek 与 kimi 两把。 */
  writeCredentials(credentials: Record<string, string>): Promise<void>
  /** 起一台假上游，用例结束时自动关。 */
  upstream(handler: UpstreamHandler): Promise<FakeUpstream>
  /** 转发所需的装配槽。 */
  deps(fake: FakeUpstream, overrides?: Partial<ForwardProviderRequestDeps>): ForwardProviderRequestDeps
}

/** 在测试文件顶层调用一次；它自己登记 beforeEach / afterEach。 */
export function useModelTestContext(): ModelTestContext {
  const state = { home: '', registry: createModelRequestRegistry() }
  const upstreams: FakeUpstream[] = []
  let savedOverride: string | undefined

  async function writeCredentials(credentials: Record<string, string>): Promise<void> {
    await mkdir(join(state.home, '.webAgent'), { recursive: true })
    await writeFile(
      join(state.home, '.webAgent', 'config.json'),
      JSON.stringify({ version: 1, modelCredentials: credentials }),
    )
  }

  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'web-agent-model-'))
    savedOverride = process.env[CONFIG_DIRECTORY_ENV]
    delete process.env[CONFIG_DIRECTORY_ENV]
    state.registry = createModelRequestRegistry()
    await writeCredentials({ 'deepseek:default': TEST_API_KEY, 'kimi:cn': TEST_API_KEY })
  })

  afterEach(async () => {
    if (savedOverride === undefined) delete process.env[CONFIG_DIRECTORY_ENV]
    else process.env[CONFIG_DIRECTORY_ENV] = savedOverride
    await Promise.all(upstreams.splice(0).map((fake) => fake.close()))
    await rm(state.home, { recursive: true, force: true })
  })

  return {
    get home() {
      return state.home
    },
    get registry() {
      return state.registry
    },
    writeCredentials,
    async upstream(handler) {
      const fake = await startFakeUpstream(handler)
      upstreams.push(fake)
      return fake
    },
    deps(fake, overrides) {
      return {
        options: { homeDir: state.home },
        fetchImpl: fake.fetchImpl,
        registry: state.registry,
        ...overrides,
      }
    },
  }
}

/** 聊天端点的规范信封。`overrides` 用来改单个字段。 */
export function chatEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    target: { provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions' },
    body: { kind: 'json', json: '{"model":"deepseek-chat"}' },
    requestId: 'request-1',
    ...overrides,
  }
}
