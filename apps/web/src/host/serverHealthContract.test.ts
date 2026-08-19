import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HEALTH_PATH,
  HOST_IDENTIFIER,
  HOST_PLATFORMS,
  readServerPlatform,
  SERVICE_IDENTIFIER,
} from './serverHealthContract'

const healthyPayload = {
  service: 'einfach-agent',
  host: 'node-server',
  version: '0.1.0',
  platform: 'linux',
}

describe('readServerPlatform', () => {
  it('认出我们自己的握手并带出平台', () => {
    expect(readServerPlatform(healthyPayload)).toBe('linux')
  })

  it("'unsupported' 原样带出，不映射成三值之一", () => {
    // 这个值的含义是「宿主没有可用 shell（FreeBSD/AIX 这类）」，文件能力照常。
    // 谁把它兜成 macos/linux/windows，谁就让那台机器上每条 shell 命令以 platform mismatch 失败。
    expect(readServerPlatform({ ...healthyPayload, platform: 'unsupported' })).toBe('unsupported')
  })

  it('忽略未知字段（M 线还要往 health 里加东西）', () => {
    expect(readServerPlatform({ ...healthyPayload, capabilities: ['model-proxy'], extra: 1 }))
      .toBe('linux')
  })

  it('service 不是 web-agent 就不认——本机任何开发服务器都可能对 /api/health 回 200', () => {
    expect(readServerPlatform({ ...healthyPayload, service: 'someone-else' })).toBeUndefined()
    expect(readServerPlatform({ status: 'ok' })).toBeUndefined()
  })

  it('host 不是 node-server 就不认', () => {
    expect(readServerPlatform({ ...healthyPayload, host: 'other-host' })).toBeUndefined()
  })

  it('平台缺失或不认识时不猜、不回落', () => {
    const { platform: _dropped, ...withoutPlatform } = healthyPayload
    expect(readServerPlatform(withoutPlatform)).toBeUndefined()
    expect(readServerPlatform({ ...healthyPayload, platform: 'solaris' })).toBeUndefined()
    expect(readServerPlatform({ ...healthyPayload, platform: null })).toBeUndefined()
    // 尤其不能借 Object.prototype 上的键蒙混过关。
    expect(readServerPlatform({ ...healthyPayload, platform: 'toString' })).toBeUndefined()
  })

  it('非对象载荷一律不认', () => {
    expect(readServerPlatform(undefined)).toBeUndefined()
    expect(readServerPlatform(null)).toBeUndefined()
    expect(readServerPlatform('einfach-agent')).toBeUndefined()
    expect(readServerPlatform([healthyPayload])).toBeUndefined()
  })
})

// 副本与正本的对拍。**读的是文本不是 import**：`apps/server` 与 `apps/web` 是两个 app，
// 依赖方向里没有 app→app 这条边，真去 import 还会把 node:http 那条链拖进浏览器产物的模块图。
// 而副本唯一的风险是漂移，漂移的症状又是「server 宿主被静默判成 static」——只靠注释盯不住，
// 所以在这里机械比对。改了服务端那份而没改这边 = 红灯，而不是等到用户发现工具全没了。
describe('与 apps/server/src/health.ts 的对拍', () => {
  // 不用 `new URL('字面量', import.meta.url)`：Vite 的 assetImportMetaUrl 会把它当资源引用静态
  // 改写，Vitest 下拿到的不是 file: URL，fileURLToPath 当场抛（S1 交回时记下的范式事实）。
  const serverHealthPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../server/src/health.ts',
  )
  const source = readFileSync(serverHealthPath, 'utf8')

  const readStringConst = (name: string): string => {
    const match = new RegExp(`export const ${name} = '([^']*)'`).exec(source)
    if (match === null) {
      throw new Error(`apps/server/src/health.ts 里找不到 export const ${name} —— 契约变形了，先去看那边`)
    }
    return match[1]
  }

  it('路径与两个判别标识逐字一致', () => {
    expect(HEALTH_PATH).toBe(readStringConst('HEALTH_PATH'))
    expect(SERVICE_IDENTIFIER).toBe(readStringConst('SERVICE_IDENTIFIER'))
    expect(HOST_IDENTIFIER).toBe(readStringConst('HOST_IDENTIFIER'))
  })

  it('平台四值域逐字一致', () => {
    const declaration = /export type HealthPlatform =([^\n]+)/.exec(source)
    if (declaration === null) {
      throw new Error('apps/server/src/health.ts 里找不到 HealthPlatform 的声明')
    }
    const serverValues = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect([...serverValues].sort()).toEqual([...HOST_PLATFORMS].sort())
  })
})
