import { describe, it, expect } from 'vitest'
import { createToolRegistry, toolRegistry, type ToolRegistry } from './registry'
import type { Tool, ToolContext, ToolResult } from './types'
import { normalizeAskUserQuestionPayload } from '../runtime/askUserQuestion'

// ToolResult 是判别联合（含无 ok 字段的 { pause } 分支），直接 res.ok/res.error 在 tsc 下
// 过不了窄化——用 'in' 操作符窄化后再取 error，配合 toContain 断言多处校验错误文案。
function expectValidationError(res: ToolResult): string {
  if ('ok' in res && res.ok === false) return res.error
  throw new Error(`期望 run 返回 { ok:false, error }，实际是 ${JSON.stringify(res)}`)
}

// 最小 fake ctx：registry.run 只把它原样透传给 tool.execute，本文件不校验副作用面。
const ctx: ToolContext = {
  sessionId: 's',
  signal: new AbortController().signal,
  progress() {},
  callTool: async () => ({ ok: true }),
  runShell: async (input) => ({
    platform: input.platform,
    shell: 'test',
    command: input.command,
    cwd: input.cwd ?? '',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    truncated: false,
  }),
  renderCard: () => ({ cardId: 'x' }),
  saveArtifact: () => ({ artifactId: 'y' }),
}

// inline fake Tool 构造器：默认一个 internal 工具，execute 回 { ok:true, data }。
// 各用例用 overrides 定制 name/skill/inputSchema/execute。
function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'demo',
    runtime: 'internal',
    skill: { description: 'demo 一句话摘要', triggers: ['demo'], content: '# demo 指南正文' },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async () => ({ ok: true, data: { echoed: true } }),
    ...overrides,
  }
}

describe('tools/registry —— 抽象工厂 ToolRegistry（§3/§4）', () => {
  it('模块级单例 toolRegistry 就是一个可用的 ToolRegistry', () => {
    const reg: ToolRegistry = toolRegistry
    expect(typeof reg.register).toBe('function')
    expect(typeof reg.has).toBe('function')
    expect(typeof reg.registrationVersion).toBe('function')
    expect(typeof reg.list).toBe('function')
    expect(typeof reg.loadSchema).toBe('function')
    expect(typeof reg.run).toBe('function')
  })

  it('register 后 has/list 反映；list 项只有 name/description(=skill.description)/runtime', () => {
    const reg = createToolRegistry()
    expect(reg.has('demo')).toBe(false)

    reg.register(makeTool())

    expect(reg.has('demo')).toBe(true)
    const list = reg.list()
    expect(list).toHaveLength(1)
    const [item] = list
    // description 取自 skill.description（terse）。
    expect(item).toEqual({ name: 'demo', description: 'demo 一句话摘要', runtime: 'internal' })
    // manifest-only（TK3）：绝不含 inputSchema / guide / content / skill。
    expect(item).not.toHaveProperty('inputSchema')
    expect(item).not.toHaveProperty('guide')
    expect(item).not.toHaveProperty('content')
    expect(item).not.toHaveProperty('skill')
  })

  it('同名 register 覆盖（幂等，后注册胜）', () => {
    const reg = createToolRegistry()
    reg.register(makeTool({ skill: { description: '旧', content: '旧正文' } }))
    const oldVersion = reg.registrationVersion('demo')
    reg.register(makeTool({ skill: { description: '新', content: '新正文' } }))

    expect(reg.list()).toHaveLength(1)
    expect(reg.list()[0].description).toBe('新')
    expect(reg.loadSchema('demo')?.guide).toBe('新正文')
    expect(reg.registrationVersion('demo')).toBeGreaterThan(oldVersion!)
    expect(reg.loadSchema('demo')?.registrationVersion).toBe(reg.registrationVersion('demo'))
  })

  it('loadSchema：在 summary 之上补 inputSchema + guide(=skill.content)', () => {
    const reg = createToolRegistry()
    reg.register(makeTool())

    const loaded = reg.loadSchema('demo')
    expect(loaded).toEqual({
      name: 'demo',
      description: 'demo 一句话摘要',
      runtime: 'internal',
      registrationVersion: 1,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      guide: '# demo 指南正文',
    })
  })

  it('loadSchema 未知名 → undefined', () => {
    const reg = createToolRegistry()
    expect(reg.loadSchema('nope')).toBeUndefined()
  })

  it('内置 shell tools 已注册，manifest-only；loadSchema 才暴露 schema + guide', () => {
    const shellNames = ['shell_macos', 'shell_linux', 'shell_powershell']
    const list = toolRegistry.list().filter((tool) => shellNames.includes(tool.name))

    expect(list.map((tool) => tool.name).sort()).toEqual([...shellNames].sort())
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['description', 'name', 'runtime'])
      expect(item.runtime).toBe('server') // 依赖 Tauri 本机 shell（TP3）。
    }

    const loaded = toolRegistry.loadSchema('shell_macos')
    expect(loaded?.inputSchema).toMatchObject({ required: ['command'] })
    expect(loaded?.guide.length).toBeGreaterThan(0)
  })

  it('内置 workspace server tools 已注册，manifest-only；loadSchema 才暴露 schema + guide', () => {
    const fileToolNames = [
      'read_file',
      'list_files',
      'search_files',
      'rg_search',
      'run_task',
      'apply_patch',
      'write_file',
      'git_diff_review',
    ]
    const list = toolRegistry.list().filter((tool) => fileToolNames.includes(tool.name))

    expect(list.map((tool) => tool.name).sort()).toEqual([...fileToolNames].sort())
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['description', 'name', 'runtime'])
      expect(item.runtime).toBe('server') // 依赖 Tauri 文件系统/git（TP3）。
    }

    const loaded = toolRegistry.loadSchema('apply_patch')
    expect(loaded?.inputSchema).toMatchObject({ required: ['operations'] })
    expect(loaded?.guide.length).toBeGreaterThan(0)
  })

  it('Evaluation 只暴露提交入口，私有 evaluator 不能被执行模型加载', () => {
    expect(toolRegistry.has('submit_stage_result')).toBe(true)
    expect(toolRegistry.has('evaluate_stage')).toBe(false)
    expect(toolRegistry.has('evaluate_plan')).toBe(false)
  })

  it('run 未知名 → { ok:false, error 含 "unknown tool" }（不抛）', async () => {
    const reg = createToolRegistry()
    const res = await reg.run('nope', {}, ctx)
    expect(res).toEqual({ ok: false, error: 'unknown tool: nope' })
  })

  it('run 正常工具 → 透传其 ToolResult', async () => {
    const reg = createToolRegistry()
    reg.register(makeTool({ execute: async () => ({ ok: true, data: { n: 42 } }) }))
    const res = await reg.run('demo', { q: 'x' }, ctx)
    expect(res).toEqual({ ok: true, data: { n: 42 } })
  })

  it('run 工具 execute 抛普通 Error → { ok:false, error:消息 }（不抛，TK6）', async () => {
    const reg = createToolRegistry()
    reg.register(
      makeTool({
        execute: () => {
          throw new Error('boom')
        },
      }),
    )
    // args 需满足 makeTool 默认 inputSchema（required: ['q']），否则会在 schema 校验阶段
    // 就被挡下，走不到 execute。
    const res = await reg.run('demo', { q: 'x' }, ctx)
    expect(res).toEqual({ ok: false, error: 'boom' })
  })

  it('run 工具 execute 抛 AbortError → rethrow 透传（不封装）', async () => {
    const reg = createToolRegistry()
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    reg.register(
      makeTool({
        execute: () => {
          throw abortErr
        },
      }),
    )
    await expect(reg.run('demo', { q: 'x' }, ctx)).rejects.toBe(abortErr)
  })

  describe('run 接入 A3 schema 校验器（校验失败/default 填充）', () => {
    it('args 不满足 inputSchema → { ok:false, error 含中文字段路径 }，且不调用 execute', async () => {
      const reg = createToolRegistry()
      let executed = false
      reg.register(
        makeTool({
          execute: () => {
            executed = true
            return { ok: true }
          },
        }),
      )
      // 缺少必填字段 q。
      const res = await reg.run('demo', {}, ctx)
      const error = expectValidationError(res)
      expect(error).toContain('q')
      expect(error).toContain('缺少必填字段')
      expect(executed).toBe(false)
    })

    it('一次性收集多处校验错误（不是遇错即停）', async () => {
      const reg = createToolRegistry()
      reg.register(
        makeTool({
          inputSchema: {
            type: 'object',
            properties: {
              q: { type: 'string' },
              n: { type: 'number', minimum: 1 },
            },
            required: ['q', 'n'],
          },
        }),
      )
      const res = await reg.run('demo', { n: 0 }, ctx)
      const error = expectValidationError(res)
      // 两处问题都要出现在同一条错误里：缺 q，以及 n 小于 minimum。
      expect(error).toContain('q')
      expect(error).toContain('n')
    })

    it('校验成功后，把含 default 填充的规范化 value（而非原始 args）传给 execute', async () => {
      const reg = createToolRegistry()
      let receivedArgs: unknown
      reg.register(
        makeTool({
          inputSchema: {
            type: 'object',
            properties: {
              q: { type: 'string' },
              mode: { type: 'string', default: 'safe' },
            },
            required: ['q'],
          },
          execute: (args) => {
            receivedArgs = args
            return { ok: true }
          },
        }),
      )
      // 原始 args 未提供 mode，execute 应收到填充了 default 的 value。
      const res = await reg.run('demo', { q: 'hi' }, ctx)
      expect(res).toEqual({ ok: true })
      expect(receivedArgs).toEqual({ q: 'hi', mode: 'safe' })
    })

    it('schema 校验失败时 execute 抛出的错误不会污染结果（根本没被调用）', async () => {
      const reg = createToolRegistry()
      reg.register(
        makeTool({
          execute: () => {
            throw new Error('不应该被调用')
          },
        }),
      )
      const res = await reg.run('demo', { q: 123 }, ctx) // q 应为字符串
      expect(res).toEqual({
        ok: false,
        error: expect.stringContaining('期望类型 string'),
      })
    })
  })

  // 回归：schema 校验器自身抛异常时，run() 仍须遵守「返回 error result，绝不抛（AbortError 除外）」。
  // 曾经 validateAgainstSchema 的调用在 try 块【外面】，校验器一抛就穿透 run() 冒到最外层：
  // 整条 run 变 error，且那个 tool_call 的结果没被回填 —— 下一轮重发 items 就是非法消息序列。
  describe('run 的错误封装覆盖 schema 校验阶段（校验器抛异常也不穿透）', () => {
    // 病态 schema：default 是含 BigInt 的对象，cloneValue 里的 JSON.stringify 会抛 TypeError。
    function makeThrowingSchemaTool(thrown?: Error): Tool {
      return makeTool({
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            meta: {
              default: thrown
                ? {
                    get n(): never {
                      throw thrown
                    },
                  }
                : { n: BigInt(1) },
            },
          },
          required: ['q'],
        },
      })
    }

    it('校验器抛普通异常 → { ok:false, error }，不穿透 run()', async () => {
      const reg = createToolRegistry()
      reg.register(makeThrowingSchemaTool())

      const res = await reg.run('demo', { q: 'x' }, ctx)
      const error = expectValidationError(res)
      expect(error.length).toBeGreaterThan(0)
    })

    it('校验器抛 AbortError → 仍旧 rethrow 透传（不封装）', async () => {
      const abortErr = new Error('aborted')
      abortErr.name = 'AbortError'
      const reg = createToolRegistry()
      reg.register(makeThrowingSchemaTool(abortErr))

      await expect(reg.run('demo', { q: 'x' }, ctx)).rejects.toBe(abortErr)
    })
  })

  // 回归（本轮最严重）：ask_user_question 的 inputSchema 一度比归一化层更严
  // （top-level required 含 id、question 级 required id/text/type、type 带 enum），
  // 模型只要把 type 写歪一个字或漏一个 question 级 id，整次调用就在 registry 层被打回 { ok:false }：
  // runToolLoop 走 appendMappedToolResult 而不进 waiting_user —— 提问卡片彻底不渲染。
  // 契约：ask_user_question payload 由 runtime 层防御式归一化：
  // normalizeAskUserQuestionPayload 才是唯一真相，schema 不得抢在它前面拦。
  describe('ask_user_question 的 schema 不得抢在归一化层前面拦（提问卡片必须能渲染）', () => {
    it('type 写歪 + 缺 top-level id → { pause }（而不是 { ok:false }），归一化后 type 收敛为 text', async () => {
      const res = await toolRegistry.run(
        'ask_user_question',
        {
          title: '确认范围',
          // 模型把 'multi-choice' 写成了 'multiple-choice'，且没给 top-level id。
          questions: [{ id: 'a', text: '要哪个方案？', type: 'multiple-choice', options: ['x', 'y'] }],
        },
        ctx,
      )

      expect('pause' in res).toBe(true)
      if (!('pause' in res)) throw new Error('期望 registry.run 返回 { pause }')

      // 归一化层照常兜底：非法 type → 'text'，问题项保留，卡片渲染得出来。
      const payload = normalizeAskUserQuestionPayload(res.pause)
      expect(payload.title).toBe('确认范围')
      expect(payload.questions).toHaveLength(1)
      expect(payload.questions[0]).toMatchObject({ id: 'a', text: '要哪个方案？', type: 'text' })
      expect(payload.questions[0].options).toEqual(['x', 'y'])
    })

    it('缺 question 级 id/type → 仍返回 { pause }，合法问题项照常留下', async () => {
      const res = await toolRegistry.run(
        'ask_user_question',
        {
          questions: [
            { text: '缺 id 的问题' }, // 归一化层会丢弃它，但 registry 不该因此打回整次调用
            { id: 'b', text: '要继续吗？' }, // 连 type 都没给
          ],
        },
        ctx,
      )

      expect('pause' in res).toBe(true)
      if (!('pause' in res)) throw new Error('期望 registry.run 返回 { pause }')

      // 丢弃权在归一化层：非法项丢掉，合法项保留并补默认 type。
      const payload = normalizeAskUserQuestionPayload(res.pause)
      expect(payload.questions).toHaveLength(1)
      expect(payload.questions[0]).toMatchObject({ id: 'b', text: '要继续吗？', type: 'text' })
    })

    it('questions 缺失/为空数组仍由 execute 判非法 → { ok:false }（暂停语义不被滥用）', async () => {
      const missing = await toolRegistry.run('ask_user_question', { id: 'q1' }, ctx)
      expect(expectValidationError(missing)).toContain('questions')

      const empty = await toolRegistry.run('ask_user_question', { id: 'q1', questions: [] }, ctx)
      expect(expectValidationError(empty)).toBeTruthy()
    })
  })

  // 钳位必须对 model 可见：参数被悄悄改过而 model 不知情，它就会把截断结果当完整结果继续推理
  // （请求 maxMatches:5000 拿到 200 条），或反复重发同一个越界值。
  describe('maximum 钳位的 warning 要随成功结果带回给 model', () => {
    it('越界 → execute 收到钳位后的值，且结果上带 warnings', async () => {
      const reg = createToolRegistry()
      let seen: unknown
      reg.register(
        makeTool({
          name: 'clamped',
          inputSchema: {
            type: 'object',
            properties: { n: { type: 'integer', maximum: 5 } },
            required: ['n'],
          },
          execute(args) {
            seen = args
            return { ok: true, data: { got: (args as { n: number }).n } }
          },
        }),
      )

      const res = await reg.run('clamped', { n: 999 }, ctx)
      expect(seen).toEqual({ n: 5 })
      if (!('ok' in res) || !res.ok) throw new Error('期望 { ok:true }')
      expect(res.warnings?.[0]).toContain('n')
      expect(res.warnings?.[0]).toContain('已钳位为 5')
    })

    it('未越界 → 不带 warnings 字段（不给每个成功结果塞空数组）', async () => {
      const reg = createToolRegistry()
      reg.register(
        makeTool({
          name: 'clamped',
          inputSchema: {
            type: 'object',
            properties: { n: { type: 'integer', maximum: 5 } },
            required: ['n'],
          },
          execute: () => ({ ok: true, data: { got: 1 } }),
        }),
      )

      const res = await reg.run('clamped', { n: 1 }, ctx)
      if (!('ok' in res) || !res.ok) throw new Error('期望 { ok:true }')
      expect(res.warnings).toBeUndefined()
    })
  })
})
