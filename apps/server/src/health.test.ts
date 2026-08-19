import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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
    expect(createHealthPayload({ version: '9.9.9' })).toEqual({
      service: SERVICE_IDENTIFIER,
      host: HOST_IDENTIFIER,
      version: '9.9.9',
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
      service: 'web-agent',
      host: 'node-server',
      version: '1.2.3',
    })
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
  it('未知接口路径回 404 JSON，不落到静态托管', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'web-agent-server-api-'))
    try {
      await writeFile(join(dist, 'index.html'), '<!doctype html><title>首页</title>', 'utf8')
      server = await startTestServer({ distDirectory: dist })
      expect((await probe(server.port, '/')).body).toContain('首页')
      for (const target of ['/api', '/api/', '/api/invok', '/api/invoke/run_shell_command']) {
        const response = await probe(server.port, target)
        expect(response.status).toBe(404)
        expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
        expect(response.body).not.toContain('首页')
        expect(JSON.parse(response.body)).toMatchObject({ error: 'unknown_endpoint' })
      }
    } finally {
      await rm(dist, { recursive: true, force: true })
    }
  })
})
