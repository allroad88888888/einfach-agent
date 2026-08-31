import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '@lingui/react'
import { renderWithStore } from '../../test/renderWithStore'
import { activateLocale, appI18n } from '../../i18n'
import {
  activeWorkspaceIdAtom,
  canPickWorkspaceDirectory,
  pickWorkspaceDirectory,
  rootStore,
  setWorkspaceRoot,
  workspacesAtom,
} from '@einfach-agent/core'
import { WorkspaceRootField } from './WorkspaceRootField'

vi.mock('@einfach-agent/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@einfach-agent/core')>()),
  canPickWorkspaceDirectory: vi.fn(),
  pickWorkspaceDirectory: vi.fn(),
  setWorkspaceRoot: vi.fn(),
}))

function seedActiveSession(): void {
  rootStore.setter(workspacesAtom, {
    w1: {
      id: 'w1',
      name: 'workspace',
      rootPath: '/current/workspace',
      createdAt: 0,
      updatedAt: 0,
    },
  })
  rootStore.setter(activeWorkspaceIdAtom, 'w1')
}

function renderField() {
  return renderWithStore(
    <I18nProvider i18n={appI18n}>
      <WorkspaceRootField />
    </I18nProvider>,
  )
}

describe('WorkspaceRootField', () => {
  beforeEach(async () => {
    await activateLocale('zh-CN')
    vi.mocked(canPickWorkspaceDirectory).mockReturnValue(false)
    vi.mocked(pickWorkspaceDirectory).mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('手工输入路径后写入当前一级工作区', async () => {
    seedActiveSession()
    renderField()

    const input = screen.getByLabelText('工作区目录')
    expect(input).toHaveValue('/current/workspace')
    expect(screen.queryByRole('button', { name: '选择文件夹' })).toBeNull()

    await userEvent.type(input, '2')

    await waitFor(() => {
      expect(setWorkspaceRoot).toHaveBeenCalledWith('/current/workspace2')
    })
  })

  it('桌面或本机 server 宿主通过系统选择器写回用户选中的文件夹', async () => {
    seedActiveSession()
    vi.mocked(canPickWorkspaceDirectory).mockReturnValue(true)
    vi.mocked(pickWorkspaceDirectory).mockResolvedValue({ ok: true, path: '/Users/me/project' })
    renderField()

    await userEvent.click(screen.getByRole('button', { name: '选择文件夹' }))

    await waitFor(() => expect(setWorkspaceRoot).toHaveBeenCalledWith('/Users/me/project'))
  })

  it('取消选择时不修改路径，宿主错误会显示出来', async () => {
    seedActiveSession()
    vi.mocked(canPickWorkspaceDirectory).mockReturnValue(true)
    vi.mocked(pickWorkspaceDirectory)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'Finder 无法打开' })
    renderField()

    await userEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(setWorkspaceRoot).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Finder 无法打开')
  })

  it('英语激活时翻译目录字段文案，保留动态路径', async () => {
    seedActiveSession()
    await activateLocale('en')
    renderField()

    const input = screen.getByLabelText('Workspace directory')
    expect(input).toHaveValue('/current/workspace')
    expect(input).toHaveAttribute('placeholder', 'Absolute workspace path (leave blank to use the Git root)')
  })
})
