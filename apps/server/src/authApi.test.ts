// 端到端：起一台真在监听的 server，用原样的请求行与请求头打它。
//
// 上面几个文件测的是判定本身；这一份测的是**判定真的接在了进 API 面的那道门上**。
// 两者缺一不可——判定再对，没接上就等于没有。

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authProbe, bearer } from './authProbe.testHarness'
import { startTestServer, type TestServerHandle } from './testServer.testHarness'

const TOKEN = 'e2e-token-0123456789'
const INVOKE_PATH = '/api/invoke/run_shell_command'

let dist: string
let server: TestServerHandle | undefined

async function start(token: string | undefined = TOKEN): Promise<number> {
  server = await startTestServer({ distDirectory: dist, version: '1.2.3', token })
  return server.port
}

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'web-agent-server-auth-'))
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>首页</title>', 'utf8')
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(dist, { recursive: true, force: true })
})

describe('无 token 的 /api/* 请求被拒', () => {
  // 本卡的判据条款。少了这道门，用户开着 server 时访问的**任何**网页都能 POST 一条
  // run_shell_command——攻击者读不到响应不代表命令没跑。
  it('POST /api/invoke/... 无 token → 401，且响应里没有任何执行痕迹', async () => {
    const port = await start()
    const response = await authProbe(port, INVOKE_PATH, { method: 'POST' })
    expect(response.status).toBe(401)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['www-authenticate']).toBe('Bearer')
    expect(JSON.parse(response.body)).toMatchObject({ error: 'missing_token' })
  })

  it('未知的 /api 路径无 token 回 401 而不是 404——未认证的调用方不该问得出 API 面', async () => {
    const port = await start()
    for (const target of ['/api', '/api/', '/api/invok', INVOKE_PATH]) {
      const response = await authProbe(port, target)
      expect(response.status).toBe(401)
      expect(JSON.parse(response.body)).toMatchObject({ error: 'missing_token' })
      // 也别落到静态托管去：那样调用方拿到的是 200 和一整页 index.html。
      expect(response.body).not.toContain('首页')
    }
  })

  it('token 错 → 401 invalid_token', async () => {
    const port = await start()
    const response = await authProbe(port, INVOKE_PATH, { method: 'POST', headers: bearer('wrong-token') })
    expect(response.status).toBe(401)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'invalid_token' })
  })

  it('token 只认请求头：放进 query 不算数', async () => {
    const port = await start()
    const response = await authProbe(port, `${INVOKE_PATH}?token=${TOKEN}`, { method: 'POST' })
    expect(response.status).toBe(401)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'missing_token' })
  })

  it('带对 token 的请求穿过这道门，落到路由的下一层', async () => {
    const port = await start()
    const response = await authProbe(port, '/api/invok', { headers: bearer(TOKEN) })
    // S3 还没接 invoke 分支，所以这里的「下一层」是 404 兜底。要紧的是它**不是** 401：
    // 认证过了，之后由路由自己决定。
    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'unknown_endpoint' })
  })

  it('不传 token 选项时仍然生成随机 token，不是关闭认证', async () => {
    const port = await start(undefined)
    expect((await authProbe(port, INVOKE_PATH, { method: 'POST' })).status).toBe(401)
    // 「猜一个」也不行——它是 256 bit 的随机值。
    expect((await authProbe(port, INVOKE_PATH, { method: 'POST', headers: bearer('') })).status).toBe(401)
  })
})

describe('跨站与 rebinding', () => {
  it('跨站 Origin → 403，即便带着正确 token', async () => {
    const port = await start()
    const response = await authProbe(port, INVOKE_PATH, {
      method: 'POST',
      headers: { ...bearer(TOKEN), origin: 'http://evil.com' },
    })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'forbidden_origin' })
  })

  it('DNS rebinding：Host 是攻击者域名 → 403', async () => {
    const port = await start()
    const response = await authProbe(port, INVOKE_PATH, {
      method: 'POST',
      headers: { ...bearer(TOKEN), host: `evil.com:${port}`, origin: `http://evil.com:${port}` },
    })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'forbidden_host' })
  })

  it('我们自己页面的同源请求照常放行', async () => {
    const port = await start()
    for (const host of ['127.0.0.1', 'localhost']) {
      const response = await authProbe(port, '/api/health', { headers: { origin: `http://${host}:${port}` } })
      expect(response.status).toBe(200)
    }
  })
})

describe('health 豁免与静态面', () => {
  it('health 不带 token 也回 200——B1 的探测在拿到 token 之前', async () => {
    const port = await start()
    const response = await authProbe(port, '/api/health')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ service: 'web-agent', host: 'node-server' })
  })

  it('health 豁免的只有 token：跨站 Origin 仍然 403', async () => {
    const port = await start()
    const response = await authProbe(port, '/api/health', { headers: { origin: 'http://evil.com' } })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'forbidden_origin' })
  })

  it('静态面不校验 token——它发的是用户自己 build 的公开产物，且 B2 要从 URL 里拿 token', async () => {
    const port = await start()
    const root = await authProbe(port, '/')
    expect(root.status).toBe(200)
    expect(root.body).toContain('首页')
    // S4 打印的正是这种带 token 的链接；页面必须能开出来，否则 token 送不到浏览器里。
    const withToken = await authProbe(port, `/?token=${TOKEN}`)
    expect(withToken.status).toBe(200)
    expect(withToken.body).toContain('首页')
  })
})
