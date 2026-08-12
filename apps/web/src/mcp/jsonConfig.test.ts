import { describe, expect, it } from 'vitest'
import { parseMcpJsonConfig } from './jsonConfig'

describe('parseMcpJsonConfig', () => {
  it('parses the standard mcpServers stdio shape', () => {
    expect(parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest'],
        },
      },
    }))).toEqual([{
      name: 'playwright',
      transport: 'stdio',
      url: '',
      command: 'npx',
      argsText: '@playwright/mcp@latest',
      cwd: '',
      autoConnect: false,
    }])
  })

  it('parses multiple stdio and HTTP servers', () => {
    expect(parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        files: {
          type: 'stdio',
          command: 'node',
          args: ['server.js', '--read-only'],
          cwd: '/workspace',
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/api',
        },
      },
    }))).toMatchObject([
      {
        name: 'files',
        transport: 'stdio',
        argsText: 'server.js\n--read-only',
        cwd: '/workspace',
        autoConnect: false,
      },
      {
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/api',
        autoConnect: false,
      },
    ])
  })

  it('accepts a named single-server object', () => {
    expect(parseMcpJsonConfig(JSON.stringify({
      name: 'playwright',
      transport: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
    }))[0]).toMatchObject({
      name: 'playwright',
      transport: 'stdio',
      command: 'npx',
      argsText: '@playwright/mcp@latest',
    })
  })

  it.each([
    ['', '请输入 MCP JSON 配置'],
    ['[]', '顶层必须是对象'],
    ['null', '顶层必须是对象'],
    ['{}', 'MCP 配置不能为空'],
    ['{"mcpServers":[]}', 'mcpServers 必须是对象'],
    ['{"mcpServers":{}}', '至少需要一个服务'],
    ['{"command":"npx"}', '必须提供 name'],
  ])('rejects an empty or structurally invalid config', (input, error) => {
    expect(() => parseMcpJsonConfig(input)).toThrow(error)
  })

  it('rejects malformed JSON with a Chinese error', () => {
    expect(() => parseMcpJsonConfig('{"mcpServers":')).toThrow('MCP JSON 格式无效')
  })

  it('rejects duplicate server names and duplicate server fields', () => {
    expect(() => parseMcpJsonConfig(
      '{"mcpServers":{"playwright":{"command":"npx"},"playwright":{"command":"node"}}}',
    )).toThrow('MCP 服务名称重复：“playwright”')
    expect(() => parseMcpJsonConfig(
      '{"mcpServers":{"playwright":{"command":"npx","command":"node"}}}',
    )).toThrow('MCP 服务“playwright”存在重复字段“command”')
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        Playwright: { command: 'npx' },
        ' playwright ': { command: 'node' },
      },
    }))).toThrow('MCP 服务名称重复')
  })

  it('rejects unsupported fields and identifies the service', () => {
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest'],
          notAField: true,
        },
      },
    }))).toThrow('MCP 服务“playwright”包含不支持的字段：notAField')
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        remote: {
          url: 'https://mcp.example.com/api',
          autoConnect: true,
        },
      },
    }))).toThrow('MCP 服务“remote”不支持 autoConnect；JSON 导入后统一手动连接')
    expect(() => parseMcpJsonConfig(JSON.stringify({
      name: 'remote',
      url: 'https://mcp.example.com/api',
      cwd: '/silently-ignored-before',
    }))).toThrow('MCP 服务“remote”包含不支持的字段：cwd')
  })

  it('rejects mixed or conflicting transports', () => {
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        mixed: { command: 'npx', url: 'https://example.com/mcp' },
      },
    }))).toThrow('MCP 服务“mixed”不能同时配置 command 和 url')
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        mixed: { type: 'http', command: 'npx' },
      },
    }))).toThrow('MCP 服务“mixed”声明的传输方式与 command 不匹配')
  })

  it('rejects invalid field types and identifies the service', () => {
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: '@playwright/mcp' },
      },
    }))).toThrow('MCP 服务“playwright”的 args 必须是字符串数组')
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['@playwright/mcp', '  '] },
      },
    }))).toThrow('MCP 服务“playwright”的 args 不能包含空字符串')
  })

  it('reuses draft validation for unsafe arguments and URLs', () => {
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['--token=sk-secretvalue'] },
      },
    }))).toThrow('MCP 服务“playwright”：启动参数不能包含疑似 token')
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: {
        remote: { url: 'https://example.com/mcp?token=value' },
      },
    }))).toThrow('MCP 服务“remote”：服务地址不能包含查询参数')
  })

  it('rejects unsupported top-level fields', () => {
    expect(() => parseMcpJsonConfig(JSON.stringify({
      mcpServers: { playwright: { command: 'npx' } },
      inputs: [],
    }))).toThrow('MCP JSON 顶层包含不支持的字段：inputs')
  })

  it('limits the number of imported services', () => {
    const mcpServers = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`server-${index}`, { command: 'node' }]),
    )
    expect(() => parseMcpJsonConfig(JSON.stringify({ mcpServers })))
      .toThrow('一次最多导入 50 个 MCP 服务')
  })

  it('limits JSON input by UTF-8 byte length', () => {
    const oversized = JSON.stringify('你'.repeat(90_000))
    expect(() => parseMcpJsonConfig(oversized))
      .toThrow('MCP JSON 配置不能超过 256 KiB')
  })

  // C3：headers / env 是否被接受，完全由调用方传入的 allowCredentials 决定——这个模块本身
  // 不猜测、也不探测宿主。不传 options（等价于 allowCredentials: false）与显式浏览器宿主
  // 走同一条路径。
  describe('凭据字段（headers / env）', () => {
    it('rejects env without allowCredentials, without silently stripping it', () => {
      expect(() => parseMcpJsonConfig(JSON.stringify({
        mcpServers: {
          playwright: {
            command: 'npx',
            args: ['@playwright/mcp@latest'],
            env: { TOKEN: 'secret' },
          },
        },
      }))).toThrow('MCP 服务“playwright”的凭据字段仅桌面端支持，请删除 headers/env 后再导入')
    })

    it('rejects headers without allowCredentials, without silently stripping it', () => {
      expect(() => parseMcpJsonConfig(JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://mcp.example.com/api',
            headers: { Authorization: 'Bearer secret' },
          },
        },
      }))).toThrow('MCP 服务“remote”的凭据字段仅桌面端支持，请删除 headers/env 后再导入')
    })

    it('accepts and sanitizes env/headers when allowCredentials is true', () => {
      const [files, remote] = parseMcpJsonConfig(JSON.stringify({
        mcpServers: {
          files: {
            command: 'node',
            args: ['server.js'],
            env: { TOKEN: 'secret-value' },
          },
          remote: {
            url: 'https://mcp.example.com/api',
            headers: { Authorization: 'Bearer secret-value' },
          },
        },
      }), { allowCredentials: true })

      expect(files).toMatchObject({ env: { TOKEN: 'secret-value' } })
      expect(remote).toMatchObject({ headers: { Authorization: 'Bearer secret-value' } })
    })

    it('rejects malformed env/headers shapes even when allowCredentials is true', () => {
      expect(() => parseMcpJsonConfig(JSON.stringify({
        mcpServers: {
          files: { command: 'node', env: { 'bad key': 'x' } },
        },
      }), { allowCredentials: true })).toThrow('MCP 服务“files”的 env 格式不正确')
      expect(() => parseMcpJsonConfig(JSON.stringify({
        mcpServers: {
          remote: { url: 'https://mcp.example.com/api', headers: { Authorization: 123 } },
        },
      }), { allowCredentials: true })).toThrow('MCP 服务“remote”的 headers 格式不正确')
    })
  })
})
