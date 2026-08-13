import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { rootStore } from '@web-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { configurePluginSettings } from '../../plugins/commands'
import { resetPluginSettingsState } from '../../plugins/state'
import { createMemoryPluginToggleStorage } from '../../plugins/toggleStorage'
import { FakePluginSettingsProvider, loadedPlugin } from '../../plugins/testFixtures'
import { PluginSettingsPanel } from './PluginSettingsPanel'

describe('PluginSettingsPanel', () => {
  beforeEach(() => {
    resetPluginSettingsState(rootStore)
  })

  afterEach(() => {
    resetPluginSettingsState(rootStore)
  })

  it('renders all five status badges with their diagnostics reachable', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({
          dirName: 'enabled-dir',
          id: 'com.example.enabled',
          name: '已启用插件',
          version: '1.0.0',
          status: 'enabled',
          dispose: () => {},
        }),
        loadedPlugin({
          dirName: 'disabled-dir',
          id: 'com.example.disabled',
          name: '已停用插件',
          version: '1.0.0',
          status: 'enabled',
          dispose: () => {},
        }),
        loadedPlugin({
          dirName: 'incompatible-dir',
          id: 'com.example.incompatible',
          name: '不兼容插件',
          version: '1.0.0',
          status: 'incompatible',
          diagnostics: ['incompatible-dir: apiVersion 不在支持区间'],
        }),
        loadedPlugin({
          dirName: 'failed-dir',
          id: 'com.example.failed',
          name: '失败插件',
          version: '1.0.0',
          status: 'failed',
          diagnostics: ['failed-dir: 安装失败 — 工具名重复'],
        }),
        // manifest 从未解析成功：没有 id/name/version，只有 dirName——面板应展示为「清单无效」，
        // 与"曾经解析成功但装的时候才失败"的 failed 区分开。
        loadedPlugin({
          dirName: 'invalid-dir',
          status: 'failed',
          diagnostics: ['invalid-dir: manifest 无效，未加载'],
        }),
      ],
    })
    configurePluginSettings({
      provider,
      toggleStorage: createMemoryPluginToggleStorage({ disabled: { 'com.example.disabled': true } }),
    })

    renderWithStore(<PluginSettingsPanel />, { store: rootStore })

    expect(await screen.findByRole('article', { name: '插件 已启用插件' })).toHaveTextContent('已启用')
    expect(screen.getByRole('article', { name: '插件 已停用插件' })).toHaveTextContent('已停用')
    expect(screen.getByRole('article', { name: '插件 不兼容插件' })).toHaveTextContent('版本不兼容')
    expect(screen.getByRole('article', { name: '插件 失败插件' })).toHaveTextContent('加载失败')
    expect(screen.getByRole('article', { name: '插件 invalid-dir' })).toHaveTextContent('清单无效')

    // 停用/不兼容/失败/无效四种都不该提供启停开关：前者已经在停用记录里到位，
    // 后三者要先解决插件自身问题，面板不假装能"重试"。
    expect(within(screen.getByRole('article', { name: '插件 不兼容插件' })).queryByRole('button')).toBeNull()
    expect(within(screen.getByRole('article', { name: '插件 失败插件' })).queryByRole('button')).toBeNull()
    expect(within(screen.getByRole('article', { name: '插件 invalid-dir' })).queryByRole('button')).toBeNull()
  })

  it('disables an enabled plugin via dispose and re-enables it via the provider', async () => {
    const user = userEvent.setup()
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({
          dirName: 'toggle-me',
          id: 'com.example.toggle',
          name: '可切换插件',
          version: '1.0.0',
          status: 'enabled',
          dispose: () => {},
        }),
      ],
    })
    const toggleStorage = createMemoryPluginToggleStorage()
    configurePluginSettings({ provider, toggleStorage })
    renderWithStore(<PluginSettingsPanel />, { store: rootStore })

    const card = await screen.findByRole('article', { name: '插件 可切换插件' })
    await user.click(within(card).getByRole('button', { name: '停用' }))

    await waitFor(() => expect(provider.disposeCalls).toEqual(['toggle-me']))
    expect(toggleStorage.load()).toEqual({ disabled: { 'com.example.toggle': true }, tools: {} })
    expect(card).toHaveTextContent('已停用')

    await user.click(within(card).getByRole('button', { name: '启用' }))
    await waitFor(() => expect(provider.enableCalls).toEqual(['toggle-me']))
    expect(toggleStorage.load()).toEqual({ disabled: {}, tools: {} })
    expect(card).toHaveTextContent('已启用')
  })

  it('expands a failed plugin\'s diagnostics on demand', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({
          dirName: 'broken',
          id: 'com.example.broken',
          name: '坏插件',
          version: '1.0.0',
          status: 'failed',
          diagnostics: ['broken: 安装失败 — 工具名重复'],
        }),
      ],
    })
    configurePluginSettings({ provider })
    renderWithStore(<PluginSettingsPanel />, { store: rootStore })

    const card = await screen.findByRole('article', { name: '插件 坏插件' })
    const details = card.querySelector('details')
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute('open')

    fireEvent.click(within(card).getByText('诊断（1 条）'))

    expect(details).toHaveAttribute('open')
    expect(details).toHaveTextContent('broken: 安装失败 — 工具名重复')
  })

  it('gates model-visible tools behind per-tool checkboxes that default to off', async () => {
    const user = userEvent.setup()
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({
          dirName: 'with-tools',
          id: 'com.example.tools',
          name: '带工具插件',
          version: '1.0.0',
          status: 'enabled',
          withheldTools: ['plugin_tool_a', 'plugin_tool_b', 'plugin_tool_c'],
          dispose: () => {},
        }),
      ],
    })
    const toggleStorage = createMemoryPluginToggleStorage()
    configurePluginSettings({ provider, toggleStorage })
    renderWithStore(<PluginSettingsPanel />, { store: rootStore })

    const card = await screen.findByRole('article', { name: '插件 带工具插件' })
    expect(card).toHaveTextContent('勾选后此工具将进入模型上下文与执行路径')
    const boxes = within(card).getAllByRole('checkbox')
    expect(boxes).toHaveLength(3)
    expect(boxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true)

    await user.click(within(card).getByRole('checkbox', { name: 'plugin_tool_a' }))

    // 勾选走的是"改记录 + 重装插件"，闸门在重装时按新记录放行这一个工具。
    await waitFor(() => expect(provider.enableCalls).toEqual(['with-tools']))
    expect(toggleStorage.load().tools).toEqual({ 'com.example.tools': { plugin_tool_a: true } })
    await waitFor(() =>
      expect(within(card).getByRole('checkbox', { name: 'plugin_tool_a' })).toBeChecked(),
    )
    expect(card).toHaveTextContent('2/3 未启用')

    await user.click(within(card).getByRole('checkbox', { name: 'plugin_tool_a' }))

    await waitFor(() => expect(toggleStorage.load().tools).toEqual({}))
    expect(within(card).getByRole('checkbox', { name: 'plugin_tool_a' })).not.toBeChecked()
  })

  it('keeps the tool checkboxes read-only while the plugin itself is disabled', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({
          dirName: 'off-dir',
          id: 'com.example.off',
          name: '停用插件',
          version: '1.0.0',
          status: 'enabled',
          withheldTools: ['plugin_tool_a'],
          dispose: () => {},
        }),
      ],
    })
    configurePluginSettings({
      provider,
      toggleStorage: createMemoryPluginToggleStorage({ disabled: { 'com.example.off': true } }),
    })
    renderWithStore(<PluginSettingsPanel />, { store: rootStore })

    const card = await screen.findByRole('article', { name: '插件 停用插件' })
    expect(within(card).getByRole('checkbox', { name: 'plugin_tool_a' })).toBeDisabled()
  })

  it('shows an explicit unsupported-host empty state and skips scanning', async () => {
    const provider = new FakePluginSettingsProvider({ capabilities: { supported: false } })
    configurePluginSettings({ provider })

    renderWithStore(<PluginSettingsPanel />, { store: rootStore })

    expect(await screen.findByText('当前宿主不支持用户插件')).toBeInTheDocument()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('shows an empty state when the host supports plugins but none are found', async () => {
    const provider = new FakePluginSettingsProvider({ plugins: [] })
    configurePluginSettings({ provider })

    renderWithStore(<PluginSettingsPanel />, { store: rootStore })

    expect(await screen.findByText('还没有插件')).toBeInTheDocument()
  })
})
