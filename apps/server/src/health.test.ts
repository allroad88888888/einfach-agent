import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { authProbe, bearer } from './authProbe.testHarness'
import { HOST_IDENTIFIER, SERVICE_IDENTIFIER, createHealthPayload } from './health'
import { probe, startTestServer, type TestServerHandle } from './testServer.testHarness'

let server: TestServerHandle | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function start(version?: string): Promise<number> {
  server = await startTestServer({ version, distDirectory: '/definitely-missing-dist' })
  return server.port
}

describe('createHealthPayload', () => {
  it('只由注入的事实决定内容', () => {
    expect(createHealthPayload({ version: '9.9.9', platform: 'windows' })).toEqual({
      service: SERVICE_IDENTIFIER,
      host: HOST_IDENTIFIER,
      version: '9.9.9',
      platform: 'windows',
    })
  })

  // 'windows' 上面那条用的是**跑测试的机器绝不会是**的一个值：本模块若哪天自己去读
  // process.platform 而不是用注入的事实，这条会当场转红，而注入 'darwin'/'linux' 时它
  // 在本机恰好也能通过。
  it('platform 是可声明的四值域，unsupported 原样透传', () => {
    expect(createHealthPayload({ version: '0', platform: 'unsupported' })).toMatchObject({
      platform: 'unsupported',
    })
  })
})

describe('GET /api/health', () => {
  it('回报服务标识、宿主标识与版本', async () => {
    const port = await start('1.2.3')
    const response = await probe(port, '/api/health')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    // 断言字段值而不是「字段集合恰好是这三个」：S5 可能往握手里加字段，加了不该让本例转红。
    expect(JSON.parse(response.body)).toMatchObject({
      service: 'einfach-agent',
      host: 'node-server',
      version: '1.2.3',
    })
  })

  it('回报**执行 shell 的那台机器**的平台（S5 握手）', async () => {
    // 期望值由本测试文件自己从 process.platform 独立算出，不 import 被测链路上的
    // nodeHostPlatform()——否则这条断言会退化成与实现同源的重言式，握手接错了也照样绿。
    // 本例走的是**不带 token** 的 probe（S2 已裁决 health 豁免 token），而那正是平台必须住在
    // health 里的理由：core 要求「桥与平台同一次登记」，浏览器得先知道平台才登记得了桥，而
    // token 是跟桥一起装配的——把平台改由某条 /api/invoke 回答就成了先有鸡还是先有蛋。
    const expected =
      process.platform === 'darwin' ? 'macos'
      : process.platform === 'linux' ? 'linux'
      : process.platform === 'win32' ? 'windows'
      : 'unsupported'
    const port = await start('1.2.3')
    expect(JSON.parse((await probe(port, '/api/health')).body)).toMatchObject({ platform: expected })
  })


  it('默认版本取自本包 package.json', async () => {
    const port = await start()
    // 从本测试文件自己的位置独立算出清单路径，不借被测模块的常量——否则「版本是否真的接到了
    // health 上」这条断言会退化成与实现同源的重言式。
    const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json')
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    const expected = (manifest as { version: string }).version
    expect(expected).toMatch(/^\d+\.\d+\.\d+/)
    expect(JSON.parse((await probe(port, '/api/health')).body)).toMatchObject({ version: expected })
  })

  it('产物缺失也照答——服务端活着与前端有没有 build 是两件事', async () => {
    const port = await start('1.2.3')
    expect((await probe(port, '/api/health')).status).toBe(200)
    expect((await probe(port, '/')).status).toBe(503)
  })

  it('HEAD 回同样的头部但不带正文', async () => {
    const port = await start('1.2.3')
    const head = await probe(port, '/api/health', 'HEAD')
    const get = await probe(port, '/api/health')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers['content-length']).toBe(get.headers['content-length'])
  })

  it('非 GET/HEAD 回 405 并带 allow', async () => {
    const port = await start('1.2.3')
    const response = await probe(port, '/api/health', 'POST')
    expect(response.status).toBe(405)
    expect(response.headers.allow).toBe('GET, HEAD')
    expect(JSON.parse(response.body)).toMatchObject({ error: 'method_not_allowed' })
  })
})

describe('/api/* 兜底', () => {
  // 这条是回归护栏：未知的 /api 路径若落到静态托管，调用方会拿到 200 + 一整页 index.html，
  // 而不是一个错误——JSON 解析会在离病因十万八千里的地方报错。所以这里特意配一份**存在的**产物。
  //
  // S2 之后这些请求必须带 token：认证卡口排在路径分派之前，未认证的调用方拿到的是 401，
  // 连「有哪些接口存在」都问不出来。**那条 401 语义由 authApi.test.ts 钉住**；本例要钉的是
  // 「通过认证之后，未知的 /api 路径回 404 JSON 而不是首页」，所以它带着有效 token 发。
  it('未知接口路径回 404 JSON，不落到静态托管', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'web-agent-server-api-'))
    const token = 'health-test-token'
    try {
      await writeFile(join(dist, 'index.html'), '<!doctype html><title>首页</title>', 'utf8')
      server = await startTestServer({ distDirectory: dist, token })
      expect((await probe(server.port, '/')).body).toContain('首页')
      // `/api/invoke/…` **不在**这张表里：它是一条真实存在的接口（S3），GET 它拿到的是 405
      // 而不是 404。下面单独钉住这件事——「它被路由走了」正是本文件要防的「落到静态托管」的反面。
      for (const target of ['/api', '/api/', '/api/invok']) {
        const response = await authProbe(server.port, target, { headers: bearer(token) })
        expect(response.status).toBe(404)
        expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
        expect(response.body).not.toContain('首页')
        expect(JSON.parse(response.body)).toMatchObject({ error: 'unknown_endpoint' })
      }
      const invoked = await authProbe(server.port, '/api/invoke/run_shell_command', {
        headers: bearer(token),
      })
      expect(invoked.status).toBe(405)
      expect(invoked.body).not.toContain('首页')
      expect(JSON.parse(invoked.body)).toMatchObject({ error: 'method_not_allowed' })
    } finally {
      await rm(dist, { recursive: true, force: true })
    }
  })
})
