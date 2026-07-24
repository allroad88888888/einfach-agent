import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '@einfach/core'
import { pendingArtifactsAtom, type PendingArtifact } from '@web-agent/core/state/transientAtoms'
import { rootStore, activeSessionIdAtom, resetRootStore } from '@web-agent/core/state/rootStore'
import { renderWithStore } from '../../test/renderWithStore'
import { discardArtifact } from '@web-agent/core/runtime/commands'
import { SaveArtifact } from './SaveArtifact'

// P8-f SaveArtifact：读 pendingArtifactsAtom（会话 store Provider 下）+ 保存产物。
// 契约 U1 —— UI 只读 atom + 调命令（discardArtifact），不 import writer removePendingArtifact。
// 这里把命令整模块 mock，断言「保存成功后按 (归属会话id, artifactId) 调 discardArtifact」，
// 不触碰真正的 transient writer。PF4：ownerSessionId 必须在点击那一刻从 rootStore 捕获。
vi.mock('@web-agent/core/runtime/commands', () => ({
  discardArtifact: vi.fn(),
}))

const ORIGINAL_SHOW_SAVE = (window as unknown as Record<string, unknown>).showSaveFilePicker

// 收集未处理的 Promise rejection —— 保存路径绝不该冒泡到全局。
let unhandled: unknown[] = []
const onUnhandled = (event: PromiseRejectionEvent) => {
  unhandled.push(event.reason)
}

beforeEach(() => {
  unhandled = []
  window.addEventListener('unhandledrejection', onUnhandled)
  // 默认给个归属会话 id（PF4：点击时从 rootStore 捕获）。
  rootStore.setter(activeSessionIdAtom, 'session-A')
})

afterEach(() => {
  window.removeEventListener('unhandledrejection', onUnhandled)
  if (ORIGINAL_SHOW_SAVE === undefined) {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker
  } else {
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = ORIGINAL_SHOW_SAVE
  }
  resetRootStore()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function seedArtifact(
  store: ReturnType<typeof createStore>,
  id = 'art-1',
): PendingArtifact {
  const artifact: PendingArtifact = {
    id,
    filename: 'plan.md',
    content: '# Plan',
    mimeType: 'text/markdown',
  }
  store.setter(pendingArtifactsAtom, (prev) => [...prev, artifact])
  return artifact
}

describe('SaveArtifact', () => {
  it('有 artifact：渲染文件名 + 字符数 + 保存按钮', () => {
    const store = createStore()
    seedArtifact(store)

    renderWithStore(<SaveArtifact />, { store })

    expect(screen.getByText('plan.md')).toBeInTheDocument()
    expect(screen.getByText('6 字符')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存/ })).toBeInTheDocument()
  })

  it('空 pendingArtifacts：渲染为空（返回 null）', () => {
    const store = createStore()
    // 不 seed 任何 artifact。
    const { container } = renderWithStore(<SaveArtifact />, { store })

    expect(container.querySelector('[aria-label="待保存文件"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull()
  })

  it('showSaveFilePicker 成功：按 create/write/close 顺序写盘并以 (归属会话id, artifactId) 调 discardArtifact', async () => {
    const user = userEvent.setup()
    const store = createStore()

    const calls: string[] = []
    const writable = {
      write: vi.fn(async () => {
        calls.push('write')
      }),
      close: vi.fn(async () => {
        calls.push('close')
      }),
    }
    const handle = {
      createWritable: vi.fn(async () => {
        calls.push('create')
        return writable
      }),
    }
    const showSaveFilePicker = vi.fn(async () => handle)
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = showSaveFilePicker

    const artifact = seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(discardArtifact).toHaveBeenCalledTimes(1))
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['create', 'write', 'close'])
    // PF4：归属会话 id（点击时的 active）+ artifactId。
    expect(discardArtifact).toHaveBeenCalledWith('session-A', artifact.id)
  })

  it('用户取消（picker 抛 AbortError）：不调 discardArtifact、显示「已取消」、保留 artifact', async () => {
    const user = userEvent.setup()
    const store = createStore()

    const showSaveFilePicker = vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    })
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = showSaveFilePicker

    seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(screen.getByText(/已取消/)).toBeInTheDocument())
    expect(discardArtifact).not.toHaveBeenCalled()
    // 取消不删本地 atom，产物仍在。
    expect(store.getter(pendingArtifactsAtom)).toHaveLength(1)
    expect(unhandled).toHaveLength(0)
  })

  it('write 失败：显示「保存失败」、close 不掩盖 write 错、不调 discardArtifact', async () => {
    const user = userEvent.setup()
    const store = createStore()

    const close = vi.fn(async () => {
      throw new Error('close boom')
    })
    const writable = {
      write: vi.fn(async () => {
        throw new Error('write boom')
      }),
      close,
    }
    const handle = { createWritable: vi.fn(async () => writable) }
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => handle)

    seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(screen.getByText(/保存失败/)).toBeInTheDocument())
    // 冒出的是原始 write 错，不是 close 错。
    expect(screen.getByText(/write boom/)).toBeInTheDocument()
    expect(screen.queryByText(/close boom/)).toBeNull()
    expect(close).toHaveBeenCalled()
    expect(discardArtifact).not.toHaveBeenCalled()
    expect(store.getter(pendingArtifactsAtom)).toHaveLength(1)
    expect(unhandled).toHaveLength(0)
  })

  it('无 showSaveFilePicker：blob-link 降级下载后调 discardArtifact', async () => {
    const user = userEvent.setup()
    const store = createStore()

    delete (window as unknown as Record<string, unknown>).showSaveFilePicker

    const clickSpy = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    ;(URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL

    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy
      return el
    })

    const artifact = seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(discardArtifact).toHaveBeenCalledWith('session-A', artifact.id))
    expect(createObjectURL).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
  })

  it('PF4：ownerSessionId 在点击时捕获——保存进行中切走 active，仍删归属会话', async () => {
    const user = userEvent.setup()
    const store = createStore()
    rootStore.setter(activeSessionIdAtom, 'session-A')

    // 慢 picker：保存挂起期间切走 active，再放行完成。
    let resolvePicker: (value: unknown) => void = () => {}
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    const handle = { createWritable: vi.fn(async () => writable) }
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve
        }),
    )

    const artifact = seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    // 保存挂起期间，active 被切到别的会话。
    rootStore.setter(activeSessionIdAtom, 'session-B')

    // 放行保存完成。
    resolvePicker(handle)

    await waitFor(() => expect(discardArtifact).toHaveBeenCalledTimes(1))
    // 删的是点击时捕获的 session-A，而不是完成时的 active（session-B）。
    expect(discardArtifact).toHaveBeenCalledWith('session-A', artifact.id)
  })
})
