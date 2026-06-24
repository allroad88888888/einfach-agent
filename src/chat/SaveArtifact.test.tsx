import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '@einfach/core'
import {
  activePendingArtifactsAtom,
  activeSessionIdAtom,
  addPendingArtifact,
  createSession,
  pendingArtifactsBySessionAtom,
  selectSession,
} from '../agent/state/atoms'
import { renderWithStore } from '../test/renderWithStore'
import { SaveArtifact } from './SaveArtifact'

const ORIGINAL_SHOW_SAVE = (window as unknown as Record<string, unknown>).showSaveFilePicker

let unhandled: unknown[] = []
const onUnhandled = (event: PromiseRejectionEvent) => {
  unhandled.push(event.reason)
}

beforeEach(() => {
  unhandled = []
  window.addEventListener('unhandledrejection', onUnhandled)
})

afterEach(() => {
  window.removeEventListener('unhandledrejection', onUnhandled)
  if (ORIGINAL_SHOW_SAVE === undefined) {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker
  } else {
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = ORIGINAL_SHOW_SAVE
  }
  vi.restoreAllMocks()
})

function seedArtifact(store: ReturnType<typeof createStore>, sessionId?: string) {
  return addPendingArtifact(store, sessionId, {
    filename: 'plan.md',
    content: '# Plan',
    mimeType: 'text/markdown',
  })
}

describe('SaveArtifact', () => {
  it('writes through showSaveFilePicker (create/write/close order) and clears the artifact', async () => {
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

    seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(store.getter(activePendingArtifactsAtom)).toHaveLength(0))
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['create', 'write', 'close'])
  })

  it('treats a cancelled picker (AbortError) as friendly cancellation without throwing and keeps the artifact', async () => {
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
    expect(store.getter(activePendingArtifactsAtom)).toHaveLength(1)
    expect(unhandled).toHaveLength(0)
  })

  it('shows a friendly error and closes resources when write fails (close error must not mask write error)', async () => {
    const user = userEvent.setup()
    const store = createStore()

    const close = vi.fn(async () => {})
    const writable = {
      write: vi.fn(async () => {
        throw new Error('disk full')
      }),
      close,
    }
    const handle = { createWritable: vi.fn(async () => writable) }
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => handle)

    seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(screen.getByText(/保存失败/)).toBeInTheDocument())
    expect(screen.getByText(/disk full/)).toBeInTheDocument()
    expect(close).toHaveBeenCalled()
    expect(store.getter(activePendingArtifactsAtom)).toHaveLength(1)
    expect(unhandled).toHaveLength(0)
  })

  it('keeps the original write error even when close() also throws', async () => {
    const user = userEvent.setup()
    const store = createStore()

    const writable = {
      write: vi.fn(async () => {
        throw new Error('write boom')
      }),
      close: vi.fn(async () => {
        throw new Error('close boom')
      }),
    }
    const handle = { createWritable: vi.fn(async () => writable) }
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => handle)

    seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(screen.getByText(/保存失败/)).toBeInTheDocument())
    // original write error surfaced, not the close error
    expect(screen.getByText(/write boom/)).toBeInTheDocument()
    expect(screen.queryByText(/close boom/)).not.toBeInTheDocument()
    expect(store.getter(activePendingArtifactsAtom)).toHaveLength(1)
    expect(unhandled).toHaveLength(0)
  })

  it('shows a friendly error when createWritable fails and keeps the artifact', async () => {
    const user = userEvent.setup()
    const store = createStore()

    const handle = {
      createWritable: vi.fn(async () => {
        throw new Error('no permission')
      }),
    }
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => handle)

    seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(screen.getByText(/保存失败/)).toBeInTheDocument())
    expect(screen.getByText(/no permission/)).toBeInTheDocument()
    expect(store.getter(activePendingArtifactsAtom)).toHaveLength(1)
    expect(unhandled).toHaveLength(0)
  })

  it('falls back to an a[download] Blob link when showSaveFilePicker is unavailable', async () => {
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
      if (tag === 'a') {
        ;(el as HTMLAnchorElement).click = clickSpy
      }
      return el
    })

    seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(store.getter(activePendingArtifactsAtom)).toHaveLength(0))
    expect(createObjectURL).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
  })

  it('falls back to Blob when showSaveFilePicker exists but is not a function (PF5 feature-detect)', async () => {
    const user = userEvent.setup()
    const store = createStore()

    // present-but-not-callable: `in` would be true, `typeof === function` is false
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = {}

    const clickSpy = vi.fn()
    ;(URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn()
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy
      return el
    })

    seedArtifact(store)
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(store.getter(activePendingArtifactsAtom)).toHaveLength(0))
    expect(clickSpy).toHaveBeenCalled()
  })

  it('PF4: captures the owning session at click time — switching sessions mid-save clears the right session', async () => {
    const user = userEvent.setup()
    const store = createStore()
    const sessionA = store.getter(activeSessionIdAtom)

    // a slow picker so we can switch sessions while the save is in flight
    let resolvePicker: (value: unknown) => void = () => {}
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    const handle = { createWritable: vi.fn(async () => writable) }
    ;(window as unknown as Record<string, unknown>).showSaveFilePicker = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve
        }),
    )

    seedArtifact(store, sessionA)
    // seed a different artifact in a (yet to be created) session B as well
    renderWithStore(<SaveArtifact />, { store })

    await user.click(screen.getByRole('button', { name: /保存/ }))

    // switch to session B while session A's save is pending
    const sessionB = createSession(store, 'B')
    seedArtifact(store, sessionB)
    selectSession(store, sessionB)

    // now let session A's save complete
    resolvePicker(handle)

    await waitFor(() => {
      const bySession = store.getter(pendingArtifactsBySessionAtom)
      // session A artifact removed despite active session being B at completion
      expect(bySession[sessionA] ?? []).toHaveLength(0)
      // session B artifact untouched
      expect(bySession[sessionB] ?? []).toHaveLength(1)
    })
  })
})
