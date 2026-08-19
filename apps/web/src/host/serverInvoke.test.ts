import { describe, expect, it, vi } from 'vitest'
import {
  createHttpInvoke,
  invokeServerCommand,
  isServerInvokeUnauthorized,
  ServerInvokeError,
  type ServerInvokeFetch,
} from './serverInvoke'
import type { ServerInvokeTokenEnvironment } from './serverInvokeToken'

/** 从不读写真实 window：token 环境固定给一个带 token 的假值，除非某条用例显式覆盖。 */
function tokenEnv(token: string | undefined): ServerInvokeTokenEnvironment {
  return {
    location: { href: token ? `http://127.0.0.1:4765/?token=${token}` : 'http://127.0.0.1:4765/' },
    history: { state: null, replaceState: vi.fn() },
    sessionStorage: { getItem: () => null, setItem: vi.fn() },
  }
}

/** 满足 `ServerInvokeFetch` 的最小应答；测试从不发真实网络请求。 */
function jsonFetch(status: number, body: unknown, ok = status >= 200 && status < 300): ServerInvokeFetch {
  return vi.fn(async () => ({ ok, status, json: async () => body }))
}

describe('invokeServerCommand', () => {
  it('成功时把请求方法/头/body 发对，并原样返回响应体', async () => {
    const fetch = jsonFetch(200, { home: '/Users/dol' })
    const result = await invokeServerCommand('get_user_home_dir', undefined, {
      fetch,
      tokenEnvironment: tokenEnv('abc123'),
    })
    expect(result).toEqual({ home: '/Users/dol' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Parameters<ServerInvokeFetch>[1]]
    expect(url).toBe('/api/invoke/get_user_home_dir')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers.authorization).toBe('Bearer abc123')
    expect(init.body).toBe('{}')
  })

  it('args 有值时逐字 JSON 序列化进 body', async () => {
    const fetch = jsonFetch(200, null)
    await invokeServerCommand('write_workspace_file', { path: 'a.txt', content: 'hi' }, {
      fetch,
      tokenEnvironment: tokenEnv('abc123'),
    })
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Parameters<ServerInvokeFetch>[1]]
    expect(JSON.parse(init.body)).toEqual({ path: 'a.txt', content: 'hi' })
  })

  it('命令名里的特殊字符会被编码进 URL', async () => {
    const fetch = jsonFetch(200, null)
    await invokeServerCommand('a/b c', undefined, { fetch, tokenEnvironment: tokenEnv('t') })
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown]
    expect(url).toBe(`/api/invoke/${encodeURIComponent('a/b c')}`)
  })

  it('没有 token 时不带 Authorization 头（仍然把请求发出去，让 server 给出准确的 401）', async () => {
    const fetch = jsonFetch(401, { error: 'missing_token', message: '缺少访问令牌，请使用启动时打印的完整链接。' }, false)
    await expect(
      invokeServerCommand('get_user_home_dir', undefined, { fetch, tokenEnvironment: tokenEnv(undefined) }),
    ).rejects.toBeInstanceOf(ServerInvokeError)
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Parameters<ServerInvokeFetch>[1]]
    expect(init.headers.authorization).toBeUndefined()
  })

  it('服务端失败信封 {error, message} 映射成 ServerInvokeError，status/code/message 都对', async () => {
    const fetch = jsonFetch(401, { error: 'invalid_token', message: '访问令牌无效，请使用启动时打印的完整链接。' }, false)
    let caught: unknown
    try {
      await invokeServerCommand('run_shell_command', {}, { fetch, tokenEnvironment: tokenEnv('wrong') })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ServerInvokeError)
    const error = caught as ServerInvokeError
    expect(error.status).toBe(401)
    expect(error.code).toBe('invalid_token')
    expect(error.message).toBe('访问令牌无效，请使用启动时打印的完整链接。')
  })

  it('404 unknown_command / 501 command_not_implemented 同样走信封映射', async () => {
    const notFound = jsonFetch(404, { error: 'unknown_command', message: '未知命令：foo' }, false)
    await expect(
      invokeServerCommand('foo', undefined, { fetch: notFound, tokenEnvironment: tokenEnv('t') }),
    ).rejects.toMatchObject({ status: 404, code: 'unknown_command' })

    const notImplemented = jsonFetch(501, { error: 'command_not_implemented', message: '命令未实现：bar' }, false)
    await expect(
      invokeServerCommand('bar', undefined, { fetch: notImplemented, tokenEnvironment: tokenEnv('t') }),
    ).rejects.toMatchObject({ status: 501, code: 'command_not_implemented' })
  })

  it('失败响应体不是合法信封时退到通用兜底文案，仍是 ServerInvokeError', async () => {
    const fetch = jsonFetch(500, { unexpected: true }, false)
    let caught: unknown
    try {
      await invokeServerCommand('x', undefined, { fetch, tokenEnvironment: tokenEnv('t') })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ServerInvokeError)
    const error = caught as ServerInvokeError
    expect(error.status).toBe(500)
    expect(error.code).toBeUndefined()
    expect(error.message).toContain('500')
  })

  it('失败响应体不是合法 JSON 时同样兜底，不炸掉', async () => {
    const fetch: ServerInvokeFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    }))
    await expect(
      invokeServerCommand('x', undefined, { fetch, tokenEnvironment: tokenEnv('t') }),
    ).rejects.toBeInstanceOf(ServerInvokeError)
  })

  it('网络层失败（fetch 本身 reject）映射成 status: undefined 的 ServerInvokeError', async () => {
    const fetch: ServerInvokeFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    let caught: unknown
    try {
      await invokeServerCommand('x', undefined, { fetch, tokenEnvironment: tokenEnv('t') })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ServerInvokeError)
    const error = caught as ServerInvokeError
    expect(error.status).toBeUndefined()
    expect(error.message).toContain('无法连接本地服务')
    expect(error.message).toContain('Failed to fetch')
  })

  it('成功响应体不是合法 JSON 时映射成 ServerInvokeError（不会把半截响应当成功）', async () => {
    const fetch: ServerInvokeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input')
      },
    }))
    await expect(
      invokeServerCommand('x', undefined, { fetch, tokenEnvironment: tokenEnv('t') }),
    ).rejects.toBeInstanceOf(ServerInvokeError)
  })

  it('成功且 body 为 null 时原样透传（对应 S3 的 result ?? null）', async () => {
    const fetch = jsonFetch(200, null)
    await expect(
      invokeServerCommand('run_workspace_task', undefined, { fetch, tokenEnvironment: tokenEnv('t') }),
    ).resolves.toBeNull()
  })
})

describe('isServerInvokeUnauthorized', () => {
  it('只认 ServerInvokeError 且 status === 401', () => {
    expect(isServerInvokeUnauthorized(new ServerInvokeError({ status: 401, code: 'missing_token', message: 'x' })))
      .toBe(true)
    expect(isServerInvokeUnauthorized(new ServerInvokeError({ status: 403, code: 'forbidden_origin', message: 'x' })))
      .toBe(false)
    expect(isServerInvokeUnauthorized('缺少访问令牌')).toBe(false)
    expect(isServerInvokeUnauthorized(new Error('缺少访问令牌'))).toBe(false)
  })
})

describe('createHttpInvoke() —— HostInvoke 契约：reject 必须是裸字符串', () => {
  it('成功时行为与直接调用 invokeServerCommand 一致', async () => {
    const fetch = jsonFetch(200, { ok: true })
    const invoke = createHttpInvoke({ fetch, tokenEnvironment: tokenEnv('t') })
    await expect(invoke('get_user_home_dir')).resolves.toEqual({ ok: true })
  })

  it('401 失败时 reject 的是裸字符串（服务端的 message，不是对象、不是 Error）', async () => {
    const fetch = jsonFetch(401, { error: 'missing_token', message: '缺少访问令牌，请使用启动时打印的完整链接。' }, false)
    const invoke = createHttpInvoke({ fetch, tokenEnvironment: tokenEnv(undefined) })
    let caught: unknown
    try {
      await invoke('run_shell_command', {})
    } catch (error) {
      caught = error
    }
    expect(typeof caught).toBe('string')
    expect(caught).toBe('缺少访问令牌，请使用启动时打印的完整链接。')
    // 不是 {error, message} 对象——那会让核心里 `String(error)` 风格的 catch 分支拿到
    // "[object Object]"。
    expect(caught).not.toHaveProperty('message')
  })

  it('折叠之后仍能被 core 两种既有 catch 写法正确解读', async () => {
    const fetch = jsonFetch(403, { error: 'forbidden_origin', message: '本地服务不接受跨站请求。' }, false)
    const invoke = createHttpInvoke({ fetch, tokenEnvironment: tokenEnv('t') })
    let caught: unknown
    try {
      await invoke('run_shell_command', {})
    } catch (error) {
      caught = error
    }
    // 写法一：packages/agent-core 里 messageFromError 的等价实现。
    const messageFromError = (error: unknown): string => {
      if (error instanceof Error) return error.message
      if (typeof error === 'string') return error
      return JSON.stringify(error)
    }
    expect(messageFromError(caught)).toBe('本地服务不接受跨站请求。')
    // 写法二：更简的 `error instanceof Error ? error.message : String(error)`。
    const simple = caught instanceof Error ? caught.message : String(caught)
    expect(simple).toBe('本地服务不接受跨站请求。')
  })

  it('网络层失败同样折叠成裸字符串', async () => {
    const fetch: ServerInvokeFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const invoke = createHttpInvoke({ fetch, tokenEnvironment: tokenEnv('t') })
    await expect(invoke('x')).rejects.toBe('无法连接本地服务：Failed to fetch')
  })

  it('httpInvoke 的泛型签名与 HostInvoke 一致（编译期检查，运行期只需不抛类型错误）', async () => {
    const fetch = jsonFetch(200, { value: 1 })
    const invoke = createHttpInvoke({ fetch, tokenEnvironment: tokenEnv('t') })
    const result = await invoke<{ value: number }>('cmd', { a: 1 })
    expect(result.value).toBe(1)
  })
})
