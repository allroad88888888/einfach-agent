import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probe, startTestServer, type TestServerHandle } from './testServer.testHarness'

const isUnix = process.platform !== 'win32'

let base: string
let dist: string
let server: TestServerHandle | undefined

async function start(distDirectory = dist): Promise<number> {
  server = await startTestServer({ distDirectory, version: '1.2.3' })
  return server.port
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'web-agent-server-static-'))
  dist = join(base, 'dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>首页</title>', 'utf8')
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log("hi")\n', 'utf8')
  await writeFile(join(dist, '中文.txt'), '中文正文', 'utf8')
  await writeFile(join(base, 'secret.txt'), '绝密内容', 'utf8')
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(base, { recursive: true, force: true })
})

describe('静态托管', () => {
  it('根路径回落到 index.html', async () => {
    const response = await probe(await start(), '/')
    expect(response.status).toBe(200)
    expect(response.body).toContain('首页')
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('按扩展名给内容类型', async () => {
    const port = await start()
    const asset = await probe(port, '/assets/app.js')
    expect(asset.status).toBe(200)
    expect(asset.body).toContain('console.log')
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8')
  })

  it('文件名的百分号编码能正确解开，且 content-length 按字节算', async () => {
    const response = await probe(await start(), '/%E4%B8%AD%E6%96%87.txt')
    expect(response.status).toBe(200)
    expect(response.body).toBe('中文正文')
    // 一个汉字 3 字节：用字符数算 content-length 会把响应截断在半个字符上。
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body, 'utf8'))
  })

  it('缺失的资源回 404，目录没有 index.html 也是 404', async () => {
    const port = await start()
    expect((await probe(port, '/nope.js')).status).toBe(404)
    expect((await probe(port, '/assets')).status).toBe(404)
    expect((await probe(port, '/assets/')).status).toBe(404)
  })

  it('HEAD 与 GET 同头不同体；非 GET/HEAD 回 405', async () => {
    const port = await start()
    const head = await probe(port, '/', 'HEAD')
    const get = await probe(port, '/')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers['content-length']).toBe(get.headers['content-length'])
    const post = await probe(port, '/', 'POST')
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')
  })
})

describe('路径禁闭', () => {
  // 明文 `../` 到不了 handler（HTTP 客户端与 URL 解析会先把它规范化掉），所以这里全是编码变体
  // ——它们才是真正能活着抵达的形态。明文形态由 staticPath.test.ts 直接喂函数覆盖。
  const traversals = [
    '/%2e%2e/secret.txt',
    '/%2E%2E%2Fsecret.txt',
    '/..%2f..%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/..%5csecret.txt',
    '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  ]

  it.each(traversals)('拒绝穿越：%s', async (target) => {
    const response = await probe(await start(), target)
    expect(response.status).toBe(400)
    expect(response.body).not.toContain('绝密内容')
  })

  it('二次编码解一次后只是个不存在的文件名，回 404 且拿不到根外内容', async () => {
    const response = await probe(await start(), '/%252e%252e%252fsecret.txt')
    expect(response.status).toBe(404)
    expect(response.body).not.toContain('绝密内容')
  })

  it('拒绝 NUL 截断与坏编码', async () => {
    const port = await start()
    expect((await probe(port, '/index.html%00.png')).status).toBe(400)
    expect((await probe(port, '/%zz')).status).toBe(400)
  })

  it.runIf(isUnix)('拒绝经软链接逃出站点根的目标', async () => {
    await symlink(join(base, 'secret.txt'), join(dist, 'escape.txt'))
    const response = await probe(await start(), '/escape.txt')
    expect(response.status).toBe(403)
    expect(response.body).not.toContain('绝密内容')
  })

  it.runIf(isUnix)('站点根自身是软链接时照常服务', async () => {
    const link = join(base, 'dist-link')
    await symlink(dist, link)
    expect((await probe(await start(link), '/')).body).toContain('首页')
  })
})

describe('产物缺失时的提示', () => {
  it('目录不存在：给可读提示而不是 404 裸页', async () => {
    const missing = join(base, 'not-built')
    const response = await probe(await start(missing), '/')
    expect(response.status).toBe(503)
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body, 'utf8'))
    // 提示要说清「怎么办」，不是「文件没找到」。
    expect(response.body).toContain('pnpm build')
    expect(response.body).toContain(missing)
    expect(response.body).not.toContain('404')
  })

  it('目录在但没有 index.html：同样按「产物不完整」提示', async () => {
    await rm(join(dist, 'index.html'))
    const response = await probe(await start(), '/')
    expect(response.status).toBe(503)
    expect(response.body).toContain('pnpm build')
  })

  it('产物缺失时，其余资源仍是普通 404', async () => {
    await rm(join(dist, 'index.html'))
    expect((await probe(await start(), '/assets/nope.js')).status).toBe(404)
  })
})
