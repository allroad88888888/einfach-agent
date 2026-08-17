import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { sendMessage, runAtom } from '@web-agent/core'
import { composerImageAttachmentAtom } from './composerImageAttachmentState'
import { Composer } from './Composer'

vi.mock('@web-agent/core/runtime/commands', () => ({
  continueInterruptedRun: vi.fn(),
  sendMessage: vi.fn(),
  setApprovalMode: vi.fn(),
  stopRun: vi.fn(),
}))

const accepted = { accepted: true, status: 'started', sessionId: 's', submissionSequence: 1 }

function photo(name = 'photo.png') {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' })
}

function renderComposer(store = createStore()) {
  return renderWithStore(<Composer vendor="kimi" model="kimi-k2.6" />, { store })
}

async function attach(file = photo()) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('missing image input')
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByText(file.name)
  return file
}

function dropFile(target: Element, file = photo()): Event {
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', {
    value: { files: [file], types: ['Files'] },
  })
  fireEvent(target, drop)
  return drop
}

function pasteFile(target: Element, file = photo()): Event {
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } })
  fireEvent(target, paste)
  return paste
}

describe('Composer image attachments', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'true')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('公开门禁关闭时阻止恢复会话里的待发送图片继续提交', () => {
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'false')
    const store = createStore()
    const file = photo()
    store.setter(composerImageAttachmentAtom, {
      images: [{
        id: 'restored-image', file, name: file.name, mimeType: file.type,
        byteSize: file.size, width: 20, height: 10,
      }],
      operation: 'idle',
      revision: 1,
    })
    renderComposer(store)

    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Kimi 图片输入尚未开放')
    expect(screen.getByRole('button', { name: '添加图片' })).toBeDisabled()
  })

  it('支持选择图片、预览和移除，并释放只属于 DOM 的 object URL', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 20, height: 10, close: vi.fn() }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
    renderComposer()
    await attach()

    expect(screen.getByRole('img', { name: 'photo.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移除图片：photo.png' }))

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test'))
    expect(screen.queryByText('photo.png')).toBeNull()
  })

  it('组件卸载时释放预览 object URL', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 20, height: 10, close: vi.fn() }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:unmount'), revokeObjectURL: vi.fn() })
    const { unmount } = renderComposer()
    await attach()

    unmount()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:unmount')
  })

  it('启用时可通过 paste 接收图片', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 20, height: 10, close: vi.fn() }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:paste'), revokeObjectURL: vi.fn() })
    renderComposer()

    const paste = pasteFile(screen.getByLabelText('消息'), photo('pasted.png'))

    expect(paste.defaultPrevented).toBe(true)
    expect(await screen.findByText('pasted.png')).toBeInTheDocument()
  })

  it('启用时可通过 drop 接收图片', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 20, height: 10, close: vi.fn() }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:drop'), revokeObjectURL: vi.fn() })
    const { container } = renderComposer()
    const composer = container.querySelector('.agentnew-composer')
    if (!composer) throw new Error('missing composer')

    const drop = dropFile(composer, photo('dropped.png'))

    expect(drop.defaultPrevented).toBe(true)
    expect(await screen.findByText('dropped.png')).toBeInTheDocument()
  })

  it('两个独立 Einfach store 的附件草稿不串会话', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 20, height: 10, close: vi.fn() }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:scoped'), revokeObjectURL: vi.fn() })
    const firstStore = createStore()
    const secondStore = createStore()
    const first = renderComposer(firstStore)
    renderComposer(secondStore)
    const input = first.container.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('missing image input')

    fireEvent.change(input, { target: { files: [photo('first-session.png')] } })

    await waitFor(() => expect(firstStore.getter(composerImageAttachmentAtom).images).toHaveLength(1))
    expect(firstStore.getter(composerImageAttachmentAtom).images[0]?.name).toBe('first-session.png')
    expect(secondStore.getter(composerImageAttachmentAtom).images).toEqual([])
  })

  it('允许仅图片发送；Core 接受后才清理附件', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 20, height: 10, close: vi.fn() }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
    vi.mocked(sendMessage).mockImplementation(() => Promise.resolve(accepted) as never)
    renderComposer()
    const file = await attach()

    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: '',
      images: [expect.objectContaining({ data: file, name: 'photo.png', width: 20, height: 10 })],
    })))
    await waitFor(() => expect(screen.queryByText('photo.png')).toBeNull())
  })

  it('Core 拒绝后保留图片和草稿，供用户重试', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 20, height: 10, close: vi.fn() }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
    vi.mocked(sendMessage).mockImplementation(() => Promise.resolve({
      accepted: false,
      status: 'rejected',
      reason: 'prepare_failed',
      error: '上传图片失败',
    }) as never)
    renderComposer()
    await attach()

    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('上传图片失败')
    expect(screen.getByText('photo.png')).toBeInTheDocument()
  })

  it('准备中重复发送不会重复提交', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 20, height: 10, close: vi.fn() }))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
    let resolve!: (value: typeof accepted) => void
    vi.mocked(sendMessage).mockImplementation(() => new Promise((done) => { resolve = done }) as never)
    renderComposer()
    await attach()

    const send = screen.getByRole('button', { name: '发送' })
    fireEvent.click(send)
    fireEvent.click(send)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('正在准备图片')

    resolve({ ...accepted, submissionSequence: 2 })
    await waitFor(() => expect(screen.queryByText('photo.png')).toBeNull())
  })

  it('锁定时阻止文件 drop 的浏览器默认行为但不接收附件', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'waiting_user' })
    const { container } = renderWithStore(
      <Composer vendor="kimi" model="kimi-k2.6" />,
      { store },
    )
    const composer = container.querySelector('.agentnew-composer')
    if (!composer) throw new Error('missing composer')
    const drop = dropFile(composer)

    expect(drop.defaultPrevented).toBe(true)
    expect(screen.queryByText('photo.png')).not.toBeInTheDocument()
  })

  it('图片准备中阻止文件 drop 的浏览器默认行为但不接收附件', () => {
    const store = createStore()
    store.setter(composerImageAttachmentAtom, {
      images: [], operation: 'validating', revision: 0,
    })
    const { container } = renderWithStore(
      <Composer vendor="kimi" model="kimi-k2.6" />,
      { store },
    )
    const composer = container.querySelector('.agentnew-composer')
    if (!composer) throw new Error('missing composer')

    expect(dropFile(composer).defaultPrevented).toBe(true)
    expect(screen.queryByText('photo.png')).not.toBeInTheDocument()
  })
})
