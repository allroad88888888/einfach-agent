import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import { activateLocale } from '../../i18n'
import { ComposerControlBar } from './ComposerControlBar'

const commands = vi.hoisted(() => ({ getCatalog: vi.fn() }))

vi.mock('@einfach-agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@einfach-agent/core')>()
  return { ...actual, getSessionCapabilityCatalog: commands.getCatalog }
})

describe('ComposerControlBar capability entry', () => {
  beforeEach(async () => {
    commands.getCatalog.mockReset()
    await activateLocale('zh-CN')
  })

  it('将紧凑图标入口固定为控制条最右侧元素', async () => {
    commands.getCatalog.mockResolvedValue({
      sessionId: 'session-a',
      state: 'draft',
      policyVersion: 'draft',
      tools: [],
      skills: [],
    })
    const { container } = renderWithStore(
      <ComposerControlBar
        approvalMode="confirm"
        modelSettings={{ vendor: 'openai-compat', model: 'test-model' }}
        sessionId="session-a"
        modelSettingsDisabled={false}
        capabilityPolicy={{ version: 1, state: 'draft', revision: 0, disabledTools: [], disabledSkills: [] }}
        queuedMessageCount={1}
        onToggleApprovalMode={() => undefined}
      />,
    )

    const button = await screen.findByRole('button', { name: '会话能力：0 个工具 · 0 个 Skills' })
    const controlBar = container.querySelector('.agentnew-composer-status-line')
    expect(controlBar?.lastElementChild).toBe(button)
    expect(button).toHaveTextContent('')
    expect(getComputedStyle(button).width).toBe('28px')
    expect(getComputedStyle(button).marginLeft).toBe('auto')
  })
})
