import { createStore } from '@einfach/core'
import { createRef } from 'react'
import {
  activeSessionIdAtom,
  activeWorkspaceIdAtom,
  browserCardsAtom,
  disabledProjectSkillsByWorkspaceAtom,
  expandedWorkspaceIdsAtom,
  itemsAtom,
  pendingArtifactsAtom,
  planAtom,
  projectSkillsAtom,
  runAtom,
  sessionsAtom,
  workspacesAtom,
  type ConversationItem,
} from '@einfach-agent/core'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateLocale, appI18n, type AppLocale } from '../../i18n'
import { LOCALE_STORAGE_KEY } from '../../i18n/localeStorage'
import { settingsCenterOpenAtom, settingsCenterTabAtom } from '../../settings/settingsCenterState'
import { renderWithStore } from '../../test/renderWithStore'
import { BrowserActionCard } from './BrowserActionCard'
import { CompletedPlanRecord } from './CompletedPlanRecord'
import { Composer } from './Composer'
import { McpSettingsPanel } from './McpSettingsPanel'
import { MessageList } from './MessageList'
import { ModelCredentialPanel } from './ModelCredentialPanel'
import { PluginSettingsPanel } from './PluginSettingsPanel'
import { ProjectSkillsPanel } from './ProjectSkillsPanel'
import { SaveArtifact } from './SaveArtifact'
import { ToolConfirmCard } from './ToolConfirmCard'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { SettingsDialog } from './SettingsDialog'

HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '')
})

const WORKSPACE_NAME = 'Workspace 动态原名'
const SESSION_TITLE = 'Session 动态原名'
const MODEL_TEXT = '模型 reasoning 动态原文'
const TOOL_NAME = 'fixture_工具_name'
const TOOL_JSON = '{"path":"动态/fixture.json"}'
const SUBAGENT_OBJECTIVE = '子 agent 目标动态原文'
const BROWSER_TITLE = '浏览器标题动态原文'
const BROWSER_BODY = '浏览器内容动态原文'
const FILE_NAME = '交付物-动态原名.md'
const SKILL_NAME = 'project/技能-动态原名'

let storedAppLocale: string
let storedLocalePreference: string | null
let storedDocumentLanguage: string

function seedRootStore() {
  const store = createStore()
  store.setter(workspacesAtom, {
    fixture: {
      id: 'fixture', name: WORKSPACE_NAME, rootPath: '/workspace/动态路径',
      createdAt: 1, updatedAt: 1,
    },
  })
  store.setter(activeWorkspaceIdAtom, 'fixture')
  store.setter(expandedWorkspaceIdsAtom, { fixture: true })
  store.setter(sessionsAtom, {
    fixture: {
      id: 'fixture', title: SESSION_TITLE, workspaceId: 'fixture',
      settings: { vendor: 'fixture-vendor', model: 'fixture-model' },
      createdAt: 1, updatedAt: 1,
    },
  })
  store.setter(activeSessionIdAtom, 'fixture')
  store.setter(disabledProjectSkillsByWorkspaceAtom, {})
  store.setter(projectSkillsAtom, {
    '/workspace/动态路径': {
      workspaceRoot: '/workspace/动态路径', diagnostics: [],
      entries: [{
        name: SKILL_NAME, description: 'Skill 描述动态原文', triggers: [],
        filePath: '.webAgent/skills/fixture/SKILL.md', resources: {},
        origin: 'agent', scope: 'project', rootPath: '/workspace/动态路径',
      }],
    },
  })
  return store
}

function seedAgentStore() {
  const store = createStore()
  const items: ConversationItem[] = [
    {
      id: 'tool-model', createdAt: 10,
      item: {
        role: 'assistant', content: null, reasoning_content: MODEL_TEXT,
        tool_calls: [{
          id: 'tool-call', type: 'function',
          function: { name: TOOL_NAME, arguments: TOOL_JSON },
        }],
      },
    },
    {
      id: 'delegate', createdAt: 20,
      item: {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'delegate-call', type: 'function',
          function: {
            name: 'delegate_agent',
            arguments: JSON.stringify({
              strategy: 'parallel_wait_all',
              children: [{ objective: SUBAGENT_OBJECTIVE }, { objective: '子 agent 第二目标动态原文' }],
            }),
          },
        }],
      },
    },
  ]
  store.setter(itemsAtom, items)
  store.setter(runAtom, {
    runId: 'run-fixture', status: 'waiting_confirmation',
    pendingToolConfirmation: {
      callId: 'confirmation-fixture', toolName: TOOL_NAME,
      args: { path: '动态/fixture.json' },
    },
  })
  store.setter(browserCardsAtom, [{
    id: 'browser-fixture', createdAt: 30, title: BROWSER_TITLE, body: BROWSER_BODY,
  }])
  store.setter(pendingArtifactsAtom, [{
    id: 'artifact-fixture', filename: FILE_NAME, content: '# fixture', mimeType: 'text/markdown',
  }])
  store.setter(planAtom, {
    id: 'plan-fixture', title: '计划标题动态原文', objective: '计划目标动态原文',
    status: 'completed', revision: 1, requiresApproval: false, createdAt: 1, updatedAt: 2,
    stages: [{
      id: 'stage-fixture', title: '阶段标题动态原文', objective: '阶段目标动态原文',
      deliverables: ['阶段交付动态原文'], dependencies: [], status: 'completed', evidence: [],
    }],
  })
  return store
}

function FullSurfaceFixture(): React.JSX.Element {
  return (
    <>
      <WorkspaceSidebar />
      <SettingsDialog launchButtonRef={createRef<HTMLButtonElement>()} />
      <MessageList />
      <Composer />
      <ToolConfirmCard />
      <ModelCredentialPanel />
      <McpSettingsPanel />
      <PluginSettingsPanel />
      <ProjectSkillsPanel />
      <CompletedPlanRecord />
      <SaveArtifact />
      <BrowserActionCard card={{
        id: 'direct-browser', createdAt: 40, title: BROWSER_TITLE, body: BROWSER_BODY,
      }} />
    </>
  )
}

function renderFullSurface(): void {
  const store = createStore()
  store.setter(settingsCenterOpenAtom, true)
  store.setter(settingsCenterTabAtom, 'mcp')
  renderWithStore(<FullSurfaceFixture />, {
    store, rootStore: seedRootStore(), agentStore: seedAgentStore(),
  })
}

describe('full-surface i18n delivery', () => {
  beforeEach(() => {
    storedAppLocale = appI18n.locale
    storedLocalePreference = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    storedDocumentLanguage = document.documentElement.lang
  })

  afterEach(async () => {
    cleanup()
    if (storedAppLocale === 'zh-CN' || storedAppLocale === 'en') {
      await activateLocale(storedAppLocale as AppLocale)
    } else await activateLocale('zh-CN')
    if (storedLocalePreference === null) window.localStorage.removeItem(LOCALE_STORAGE_KEY)
    else window.localStorage.setItem(LOCALE_STORAGE_KEY, storedLocalePreference)
    document.documentElement.lang = storedDocumentLanguage
  })

  it.each([
    {
      locale: 'zh-CN' as const,
      labels: ['工作区', '思考过程', '发送', '需要确认', '模型', 'MCP 服务', '插件', '项目 Skills', '计划记录', '1/1 阶段完成', '2 个节点', '9 字符', '待保存文件'],
      settingsNavigation: '设置分类',
      settingsTabs: ['MCP 服务', '模型', '自定义指令', '通用', '项目 Skills', '插件'],
      browserLabel: '浏览器动作卡片', subagentLabel: '子 agent',
    },
    {
      locale: 'en' as const,
      labels: ['Workspaces', 'Reasoning', 'Send', 'Confirmation required', 'Models', 'MCP servers', 'Plugins', 'Project Skills', 'Plan record', '1/1 stage complete', '2 nodes', '9 characters', 'Files to save'],
      settingsNavigation: 'Settings categories',
      settingsTabs: ['MCP servers', 'Models', 'Custom instructions', 'General', 'Project Skills', 'Plugins'],
      browserLabel: 'Browser action card', subagentLabel: 'Sub-agent',
    },
  ])('renders $locale from compiled catalogs and preserves dynamic data', async ({
    locale, labels, settingsNavigation, settingsTabs, browserLabel, subagentLabel,
  }) => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
    await activateLocale(locale)
    document.documentElement.lang = locale
    renderFullSurface()

    expect(appI18n.locale).toBe(locale)
    expect(document.documentElement.lang).toBe(locale)
    for (const label of labels) expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    expect(screen.getByRole('navigation', { name: settingsNavigation })).toBeInTheDocument()
    for (const label of settingsTabs) expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    expect(screen.getAllByLabelText(browserLabel)).toHaveLength(2)
    expect(screen.getByText(subagentLabel)).toBeInTheDocument()

    for (const dynamicText of [
      WORKSPACE_NAME, SESSION_TITLE, MODEL_TEXT, TOOL_NAME, '动态/fixture.json',
      SUBAGENT_OBJECTIVE, BROWSER_TITLE, BROWSER_BODY, FILE_NAME, SKILL_NAME,
    ]) {
      expect(screen.getAllByText((content) => content.includes(dynamicText)).length).toBeGreaterThan(0)
    }
  })
})
