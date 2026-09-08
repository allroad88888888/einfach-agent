import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import { activateLocale } from '../../i18n'
import { ConversationCapabilitiesButton } from './ConversationCapabilitiesButton'
import { ConversationCapabilitiesPanel } from './ConversationCapabilitiesPanel'

const commands = vi.hoisted(() => ({
  get: vi.fn(),
  toggle: vi.fn(),
  clone: vi.fn(),
}))

vi.mock('@einfach-agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@einfach-agent/core')>()
  return {
    ...actual,
    getSessionCapabilityCatalog: commands.get,
    toggleDraftSessionCapability: commands.toggle,
    cloneSessionCapabilities: commands.clone,
  }
})

function catalog(state: 'draft' | 'locked' | 'legacy-unrestricted' = 'draft') {
  return {
    sessionId: 'session-a',
    state,
    policyVersion: state,
    tools: [
      { name: 'alpha', label: 'Alpha tool', description: 'Find things', kind: 'tool' as const, available: true, selected: true },
      { name: 'beta', label: 'Beta tool', description: 'Write things', kind: 'tool' as const, available: true, selected: false },
      { name: 'gone', label: 'Gone tool', description: '', kind: 'tool' as const, available: false, selected: true },
    ],
    skills: [
      { name: 'skill/alpha', label: 'Alpha skill', description: 'A skill', kind: 'skill' as const, available: true, selected: true },
    ],
  }
}

function PanelHarness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>打开</button>
      <ConversationCapabilitiesPanel open={open} sessionId="session-a" policyVersion="draft" triggerRef={triggerRef} onClose={() => setOpen(false)} />
    </>
  )
}

function PanelRequestHarness({ policyVersion }: { policyVersion: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  return <ConversationCapabilitiesPanel open sessionId="session-a" policyVersion={policyVersion} triggerRef={triggerRef} onClose={() => undefined} />
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function nestedRules(rules: CSSRuleList | CSSRule[]): CSSRule[] {
  return Array.from(rules).flatMap((rule) => 'cssRules' in rule
    ? [rule, ...nestedRules((rule as CSSGroupingRule).cssRules)]
    : [rule])
}

describe('ConversationCapabilitiesPanel', () => {
  beforeEach(async () => {
    commands.get.mockReset()
    commands.toggle.mockReset()
    commands.clone.mockReset()
    await activateLocale('zh-CN')
  })

  it('入口以紧凑图标展示，并在可访问名称和提示中保留能力摘要', async () => {
    commands.get.mockResolvedValue(catalog())
    renderWithStore(<ConversationCapabilitiesButton sessionId="session-a" policyVersion="draft" open={false} onOpen={() => undefined} />)

    const button = await screen.findByRole('button', { name: '会话能力：2 个工具 · 1 个 Skills' })
    expect(button).toHaveTextContent('')
    expect(button).toHaveAttribute('title', '会话能力：2 个工具 · 1 个 Skills')
    expect(button.querySelector('svg')).toBeInTheDocument()
  })

  it('加载 draft、搜索、切换、全选和清空均走会话命令', async () => {
    let current = catalog()
    commands.get.mockImplementation(async () => current)
    commands.toggle.mockImplementation(async (kind: 'tool' | 'skill', name: string, selected: boolean) => {
      current = {
        ...current,
        [kind === 'tool' ? 'tools' : 'skills']: current[kind === 'tool' ? 'tools' : 'skills']
          .map((item) => item.name === name ? { ...item, selected } : item),
      }
    })
    renderWithStore(<PanelHarness />)

    const dialog = await screen.findByRole('dialog', { name: '能力' })
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭能力设置' })).toHaveFocus())
    fireEvent.change(screen.getByRole('textbox', { name: '搜索工具和 Skills' }), { target: { value: 'Beta' } })
    expect(within(dialog).getByText('Beta tool')).toBeInTheDocument()
    expect(within(dialog).queryByText('Alpha tool')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索工具和 Skills' }), { target: { value: '' } })

    const betaToggle = screen.getByRole('checkbox', { name: '切换 Beta tool' })
    betaToggle.focus()
    fireEvent.click(betaToggle)
    await waitFor(() => expect(commands.toggle).toHaveBeenCalledWith('tool', 'beta', true, 'session-a'))
    expect(betaToggle).toHaveFocus()
    const toolSection = screen.getByRole('heading', { name: '工具' }).closest('section')!
    fireEvent.click(within(toolSection).getByRole('button', { name: '清空' }))
    await waitFor(() => expect(commands.toggle).toHaveBeenCalledWith('tool', 'alpha', false, 'session-a'))
    fireEvent.click(within(toolSection).getByRole('button', { name: '全选' }))
    await waitFor(() => expect(commands.toggle).toHaveBeenCalledWith('tool', 'beta', true, 'session-a'))
    expect(screen.getByText('不可用')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '切换 Gone tool' })).toHaveAccessibleDescription('此能力在当前环境中已不可用。')
  })

  it('通过真实 Provider 翻译 tombstone 说明，而非展示 catalog 的英文', async () => {
    commands.get.mockResolvedValue(catalog())
    renderWithStore(<PanelHarness />)

    expect(await screen.findByText('此能力在当前环境中已不可用。')).toBeInTheDocument()
    expect(screen.queryByText('No longer available in the current environment.')).toBeNull()

    await activateLocale('en')
    await waitFor(() => expect(screen.getByText('This capability is no longer available in the current environment.')).toBeInTheDocument())
  })

  it('首次加载显示 status，工具和 Skills 为空时各自显示空态', async () => {
    const pending = deferred<ReturnType<typeof catalog>>()
    commands.get.mockReturnValueOnce(pending.promise)
    renderWithStore(<PanelHarness />)

    expect(await screen.findByRole('status')).toHaveTextContent('正在加载能力…')
    pending.resolve({ ...catalog(), tools: [], skills: [] })
    expect(await screen.findByText('当前环境没有可配置的工具。')).toBeInTheDocument()
    expect(screen.getByText('当前环境没有可配置的 Skills。')).toBeInTheDocument()
  })

  it('较早的 load 晚返回时不会覆盖最新 catalog', async () => {
    const older = deferred<ReturnType<typeof catalog>>()
    const newer = deferred<ReturnType<typeof catalog>>()
    commands.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { rerender } = renderWithStore(<PanelRequestHarness policyVersion="one" />)

    expect(await screen.findByRole('status')).toBeInTheDocument()
    rerender(<PanelRequestHarness policyVersion="two" />)
    await waitFor(() => expect(commands.get).toHaveBeenCalledTimes(2))
    newer.resolve({ ...catalog(), tools: [{ name: 'new', label: 'New tool', description: 'Latest', kind: 'tool', available: true, selected: true }], skills: [] })
    expect(await screen.findByText('New tool')).toBeInTheDocument()
    older.resolve({ ...catalog(), tools: [{ name: 'old', label: 'Old tool', description: 'Stale', kind: 'tool', available: true, selected: true }], skills: [] })
    await waitFor(() => expect(screen.queryByText('Old tool')).toBeNull())
    expect(screen.getByText('New tool')).toBeInTheDocument()
  })

  it('旧 toggle 尾部的 stale load 不会作废 policy 更新后的当前 load', async () => {
    const toggle = deferred<void>()
    const currentLoad = deferred<ReturnType<typeof catalog>>()
    commands.get.mockResolvedValueOnce(catalog()).mockReturnValueOnce(currentLoad.promise)
    commands.toggle.mockReturnValueOnce(toggle.promise)
    const { rerender } = renderWithStore(<PanelRequestHarness policyVersion="one" />)

    fireEvent.click(await screen.findByRole('checkbox', { name: '切换 Alpha tool' }))
    await waitFor(() => expect(commands.toggle).toHaveBeenCalledWith('tool', 'alpha', false, 'session-a'))
    rerender(<PanelRequestHarness policyVersion="two" />)
    expect(await screen.findByRole('status')).toBeInTheDocument()
    await waitFor(() => expect(commands.get).toHaveBeenCalledTimes(2))

    toggle.resolve()
    currentLoad.resolve({ ...catalog(), tools: [{ name: 'latest', label: 'Latest tool', description: 'Current', kind: 'tool', available: true, selected: true }], skills: [] })

    expect(await screen.findByText('Latest tool')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('更新失败后保留错误，以便用户重试', async () => {
    commands.get.mockResolvedValue(catalog())
    commands.toggle.mockRejectedValue(new Error('refused'))
    renderWithStore(<PanelHarness />)

    fireEvent.click(await screen.findByRole('checkbox', { name: '切换 Alpha tool' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载或更新能力设置。')
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
  })

  it('失败可重试，locked 与 legacy 只读且可复制新对话', async () => {
    commands.get.mockRejectedValueOnce(new Error('network')).mockResolvedValue(catalog('locked'))
    commands.clone.mockResolvedValue({ status: 'created', sessionId: 'session-b' })
    renderWithStore(<PanelHarness />)

    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载或更新能力设置。')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('配置在发送首条消息后锁定。')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '切换 Alpha tool' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '按此配置新建对话' }))
    await waitFor(() => expect(commands.clone).toHaveBeenCalledWith('session-a'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Tab 焦点环绕，Escape 关闭并归还触发按钮焦点', async () => {
    commands.get.mockResolvedValue(catalog())
    renderWithStore(<PanelHarness />)

    const dialog = await screen.findByRole('dialog', { name: '能力' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveClass('conversation-capabilities-panel')
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ))
    const first = focusable[0]!
    const last = focusable.at(-1)!
    first.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: '打开' })).toHaveFocus())
  })

  it('窄屏 media contract 将面板设为全屏，并为底部操作预留安全区', () => {
    const rules = Array.from(document.styleSheets).flatMap((sheet) => {
      try { return nestedRules(sheet.cssRules) } catch { return [] }
    })
    const narrowPanel = rules.find((rule) => rule instanceof CSSStyleRule
      && rule.parentRule instanceof CSSMediaRule
      && rule.parentRule.conditionText.includes('max-width: 720px')
      && rule.selectorText === '.conversation-capabilities-panel') as CSSStyleRule | undefined
    const stylesheetText = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent).join('\n')

    expect(narrowPanel?.style.width).toBe('100%')
    expect(narrowPanel?.style.height).toBe('100dvh')
    expect(stylesheetText).toContain('safe-area-inset-bottom')
  })
})
