import {
  activeSessionIdAtom,
  disabledProjectSkillsByWorkspaceAtom,
  projectSkillsAtom,
  rootStore,
  sessionsAtom,
  workspacesAtom,
} from '@einfach-agent/core'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateLocale, appI18n, type AppLocale } from '../../i18n'
import { LOCALE_STORAGE_KEY } from '../../i18n/localeStorage'
import { mcpPendingLaunchConsentsAtom, resetMcpLaunchConsentState } from '../../mcp/launchConsentState'
import {
  mcpAddFormOpenAtom,
  mcpHydrationAtom,
  mcpPersistenceModeAtom,
  mcpServerConfigsAtom,
  mcpServerRuntimeAtom,
  mcpSettingsCapabilitiesAtom,
  resetMcpSettingsState,
} from '../../mcp/state'
import { configurePluginSettings } from '../../plugins/commands'
import { resetPluginSettingsState } from '../../plugins/state'
import { FakePluginSettingsProvider, loadedPlugin } from '../../plugins/testFixtures'
import { createMemoryPluginToggleStorage } from '../../plugins/toggleStorage'
import { resetModelConnectionProfileState } from '../../settings/modelConnectionProfileState'
import {
  modelCredentialEntriesAtom,
  modelCredentialHostAvailableAtom,
  modelEndpointEntryAtom,
  modelEndpointHostAvailableAtom,
  resetAppSettingsState,
} from '../../settings/state'
import { renderWithStore } from '../../test/renderWithStore'
import { uiStore } from '../../uiStore'
import { McpSettingsPanel } from './McpSettingsPanel'
import { ModelCredentialPanel } from './ModelCredentialPanel'
import { PluginSettingsPanel } from './PluginSettingsPanel'
import { ProjectSkillsPanel } from './ProjectSkillsPanel'
import { SettingsCenter } from './SettingsCenter'

const CREDENTIAL = 'sk-凭据-fixture-原文'
const ENDPOINT_URL = 'https://fixture.example.com/v1/原文'
const SERVER_NAME = '本地服务 Fixture 原名'
const PLUGIN_NAME = '插件 Fixture 原名'
const PLUGIN_DIAGNOSTIC = '插件诊断 fixture 原文'
const SKILL_NAME = 'project/技能-fixture'
const SKILL_DESCRIPTION = 'Skill description fixture 原文'
const SKILL_DIAGNOSTIC = 'Skill 诊断 fixture 原文'
const WORKSPACE_ROOT = '/workspace/设置-fixture'

let storedAppLocale: string
let storedLocalePreference: string | null
let storedDocumentLanguage: string

function restoreLocalePreference(): void {
  if (storedLocalePreference === null) {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
  } else {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, storedLocalePreference)
  }
}

function seedModelFixture(): void {
  uiStore.setter(modelCredentialHostAvailableAtom, true)
  uiStore.setter(modelEndpointHostAvailableAtom, true)
  const entries = uiStore.getter(modelCredentialEntriesAtom)
  uiStore.setter(modelCredentialEntriesAtom, {
    ...entries,
    'deepseek-default': {
      draft: CREDENTIAL,
      state: { status: 'ready', configured: true, source: 'config' },
    },
  })
  uiStore.setter(modelEndpointEntryAtom, {
    draft: ENDPOINT_URL,
    state: { status: 'ready', configured: true, baseUrl: ENDPOINT_URL },
  })
}

function seedMcpFixture(): void {
  uiStore.setter(mcpSettingsCapabilitiesAtom, { stdio: true, credentials: true })
  uiStore.setter(mcpAddFormOpenAtom, true)
  uiStore.setter(mcpHydrationAtom, { status: 'ready' })
  uiStore.setter(mcpPersistenceModeAtom, 'persistent')
  uiStore.setter(mcpServerConfigsAtom, [{
    id: 'fixture-server',
    name: SERVER_NAME,
    transport: 'stdio',
    command: 'fixture-command',
    args: ['--fixture-原文'],
    cwd: WORKSPACE_ROOT,
    autoConnect: false,
  }])
  uiStore.setter(mcpServerRuntimeAtom, {
    'fixture-server': { status: 'disconnected', toolCount: 0 },
  })
  uiStore.setter(mcpPendingLaunchConsentsAtom, {
    'fixture-server': {
      id: 'fixture-server',
      name: SERVER_NAME,
      commandLine: 'fixture-command --fixture-原文',
      cwd: WORKSPACE_ROOT,
      envNames: ['FIXTURE_凭据_NAME'],
      reason: 'install',
      autoConnect: false,
    },
  })
}

function seedPluginFixture(): void {
  configurePluginSettings({
    provider: new FakePluginSettingsProvider({
      plugins: [loadedPlugin({
        dirName: 'fixture-plugin',
        id: 'com.fixture.plugin',
        name: PLUGIN_NAME,
        version: '1.0.0-fixture',
        diagnostics: [PLUGIN_DIAGNOSTIC],
        withheldTools: ['fixture_工具_name'],
        dispose: () => undefined,
      })],
    }),
    toggleStorage: createMemoryPluginToggleStorage(),
  })
}

function seedSkillFixture(): void {
  rootStore.setter(workspacesAtom, {
    fixture: {
      id: 'fixture', name: 'Workspace Fixture 原名', rootPath: WORKSPACE_ROOT,
      createdAt: 1, updatedAt: 1,
    },
  })
  rootStore.setter(sessionsAtom, {
    fixture: {
      id: 'fixture', title: 'Session Fixture 原名', workspaceId: 'fixture',
      settings: { vendor: 'fixture-vendor', model: 'fixture-model' },
      createdAt: 1, updatedAt: 1,
    },
  })
  rootStore.setter(activeSessionIdAtom, 'fixture')
  rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {})
  rootStore.setter(projectSkillsAtom, {
    [WORKSPACE_ROOT]: {
      workspaceRoot: WORKSPACE_ROOT,
      diagnostics: [SKILL_DIAGNOSTIC],
      entries: [{
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        triggers: [],
        filePath: '.webAgent/skills/fixture/SKILL.md',
        resources: { 'reference-原文.md': 'fixture' },
        origin: 'agent',
        scope: 'project',
        rootPath: WORKSPACE_ROOT,
      }],
    },
  })
}

function renderSettingsFixture(): void {
  seedModelFixture()
  seedMcpFixture()
  seedPluginFixture()
  seedSkillFixture()
  renderWithStore(
    <>
      <SettingsCenter />
      <ModelCredentialPanel />
      <McpSettingsPanel />
      <PluginSettingsPanel />
      <ProjectSkillsPanel />
    </>,
    { store: uiStore },
  )
}

describe('settings i18n', () => {
  beforeEach(async () => {
    storedAppLocale = appI18n.locale
    storedLocalePreference = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    storedDocumentLanguage = document.documentElement.lang
    resetAppSettingsState(uiStore)
    resetModelConnectionProfileState(uiStore)
    resetMcpSettingsState(uiStore)
    resetMcpLaunchConsentState(uiStore)
    resetPluginSettingsState(uiStore)
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'false')
    await activateLocale('zh-CN')
    document.documentElement.lang = 'zh-CN'
  })

  afterEach(async () => {
    cleanup()
    resetAppSettingsState(uiStore)
    resetModelConnectionProfileState(uiStore)
    resetMcpSettingsState(uiStore)
    resetMcpLaunchConsentState(uiStore)
    resetPluginSettingsState(uiStore)
    if (storedAppLocale === 'zh-CN' || storedAppLocale === 'en') {
      await activateLocale(storedAppLocale as AppLocale)
    } else {
      appI18n.activate(storedAppLocale)
    }
    restoreLocalePreference()
    document.documentElement.lang = storedDocumentLanguage
  })

  it('keeps Chinese as the default across the settings surfaces', async () => {
    renderSettingsFixture()

    expect(appI18n.locale).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(screen.getByRole('button', { name: '打开设置' })).toHaveTextContent('设置')
    expect(screen.getByRole('heading', { name: '模型' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('输入新的 DeepSeek API Key')).toHaveValue(CREDENTIAL)
    expect(screen.getByRole('button', { name: '保存 DeepSeek API Key' })).toBeInTheDocument()
    expect(screen.getByRole('form', { name: '添加 MCP 服务' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存服务' })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: `MCP 服务 ${SERVER_NAME}` })).toHaveTextContent('未连接')
    expect(screen.getByRole('button', { name: '确认并执行' })).toBeInTheDocument()
    expect(await screen.findByRole('article', { name: `插件 ${PLUGIN_NAME}` })).toHaveTextContent('已启用')
    expect(screen.getByText('诊断（1 条）')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '项目 Skills' })).toBeInTheDocument()
    expect(screen.getByText('已发现 1 个技能，1 个已启用')).toBeInTheDocument()
  })

  it('renders English without translating dynamic settings data', async () => {
    await activateLocale('en')
    renderSettingsFixture()

    expect(appI18n.locale).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(screen.getByRole('button', { name: 'Open settings' })).toHaveTextContent('Settings')
    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Official models' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Enter a new DeepSeek API Key')).toHaveValue(CREDENTIAL)
    expect(screen.getByRole('button', { name: 'Delete saved key for DeepSeek' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save DeepSeek API Key' })).toBeInTheDocument()
    expect(screen.getByText(`Registered: ${ENDPOINT_URL}`)).toBeInTheDocument()

    expect(screen.getByRole('form', { name: 'Add MCP server' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Server name' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Transport' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save server' })).toBeInTheDocument()
    const server = screen.getByRole('article', { name: `MCP server ${SERVER_NAME}` })
    expect(server).toHaveTextContent('Disconnected')
    expect(server).toHaveTextContent('fixture-command --fixture-原文')
    expect(screen.getByRole('alert', { name: `Confirm launch of ${SERVER_NAME}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm and run' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Don't run now" })).toBeInTheDocument()

    const plugin = await screen.findByRole('article', { name: `Plugin ${PLUGIN_NAME}` })
    expect(plugin).toHaveTextContent('Enabled')
    expect(plugin).toHaveTextContent('Model-visible tools (1 of 1 tool disabled)')
    expect(screen.getByText('Diagnostics (1 item)')).toBeInTheDocument()
    expect(screen.getByText(PLUGIN_DIAGNOSTIC)).toBeInTheDocument()
    expect(screen.getByText('fixture_工具_name')).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Project Skills' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByText('1 Skill found, 1 enabled')).toBeInTheDocument()
    expect(screen.getByText('Scan messages (1 item)')).toBeInTheDocument()
    expect(screen.getByText(SKILL_NAME)).toBeInTheDocument()
    expect(screen.getByText(SKILL_DESCRIPTION)).toBeInTheDocument()
    expect(screen.getByText(SKILL_DIAGNOSTIC)).toBeInTheDocument()
    expect(screen.getByText('Includes 1 resource file')).toBeInTheDocument()
  })
})
