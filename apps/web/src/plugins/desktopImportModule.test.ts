// 桌面求值这半截（P10 / 蓝图 3.4 桌面行）：Rust 读文件 → blob URL → 动态 import。
//
// jsdom 不实现 blob URL 的 ESM 求值，所以真机那一步用注入的 evaluate 替身收口；本文件钉的是
// 它周围那些会静默出错的地方：读失败要保真、截断不许求值、blob 一定要回收。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopImportModule, PLUGIN_ENTRY_READ_LIMIT } from './desktopImportModule'

const { readWorkspaceFileMock } = vi.hoisted(() => ({ readWorkspaceFileMock: vi.fn() }))

vi.mock('@web-agent/core/runtime/workspaceRead', () => ({
  readWorkspaceFile: readWorkspaceFileMock,
}))

const WORKSPACE_ROOT = '/workspace/project'
const ENTRY = '.webAgent/plugins/hello/core.js'

function readOk(content: string, extra: Record<string, unknown> = {}) {
  return { ok: true, data: { path: ENTRY, content, truncated: false, bytes: content.length, ...extra } }
}

describe('createDesktopImportModule', () => {
  beforeEach(() => {
    readWorkspaceFileMock.mockReset()
  })

  it('把入口读进来求值成模块，并在求值后回收 blob URL', async () => {
    readWorkspaceFileMock.mockResolvedValue(readOk('export default {}'))
    const created: string[] = []
    const revoked: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = `blob:test/${created.length}`
      created.push(url)
      void blob
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url)
    })
    const namespace = { default: 'plugin' }
    const evaluate = vi.fn(async () => namespace)

    const importModule = createDesktopImportModule(WORKSPACE_ROOT, { evaluate })
    await expect(importModule(ENTRY)).resolves.toBe(namespace)

    // 读盘走 workspace confinement，不开外部路径。
    expect(readWorkspaceFileMock).toHaveBeenCalledWith({
      path: ENTRY,
      maxBytes: PLUGIN_ENTRY_READ_LIMIT,
      workspaceRoot: WORKSPACE_ROOT,
      allowExternalPaths: false,
    })
    expect(evaluate).toHaveBeenCalledWith(created[0])
    expect(revoked).toEqual(created)
  })

  it('读失败：原样带上 workspaceRead 的错误文本抛出（loader 据此写诊断）', async () => {
    readWorkspaceFileMock.mockResolvedValue({ ok: false, error: 'read_workspace_file failed: ENOENT' })
    const evaluate = vi.fn()

    const importModule = createDesktopImportModule(WORKSPACE_ROOT, { evaluate })

    await expect(importModule(ENTRY)).rejects.toThrow('ENOENT')
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('入口超过上限被截断：不求值——半个模块装进来比装不上更糟', async () => {
    readWorkspaceFileMock.mockResolvedValue(
      readOk('export default {}', { truncated: true, bytes: PLUGIN_ENTRY_READ_LIMIT }),
    )
    const evaluate = vi.fn()

    const importModule = createDesktopImportModule(WORKSPACE_ROOT, { evaluate })

    await expect(importModule(ENTRY)).rejects.toThrow('截断')
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('求值抛错：blob URL 照样回收，异常原样上抛给 loader', async () => {
    readWorkspaceFileMock.mockResolvedValue(readOk('boom'))
    const revoked: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test/fail')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url)
    })

    const importModule = createDesktopImportModule(WORKSPACE_ROOT, {
      evaluate: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })

    await expect(importModule(ENTRY)).rejects.toThrow('Unexpected token')
    expect(revoked).toEqual(['blob:test/fail'])
  })
})
