import { createCore } from '@einfach-agent/core/plugin'
import { createDraftSessionCapabilityPolicy, lockSessionCapabilityPolicy } from '@einfach-agent/core'
import { createProviderTransportFetch } from '@einfach-agent/ai'
import { createIndexedDbHistoryLogDriver, createIndexedDbRecoveryDriver, createIndexedDbSessionsPersistence } from '@einfach-agent/persistence-idb'
import { builtInSkillsRegistry, registerSkillsTools } from '@einfach-agent/tools-skills'
import { compactContextTool } from '@einfach-agent/tools-agents'
import { loadConfig, saveConfig, type StoredConfig } from './configStore'
import { acquireNamespaceOwner } from './namespaceOwner'
import { endpoint, id, required, unique } from './validation'
import type { AgentProfile, AgentProfileInput, BrowserAgentClient, BrowserAgentOptions, BrowserAgentSnapshot, ConfiguredSkill, ConfiguredSkillInput, ModelConnection, ModelConnectionInput } from './types'

function publicSnapshot(config: StoredConfig): BrowserAgentSnapshot {
  return Object.freeze({
    agents: Object.freeze(config.agents.map((item) => Object.freeze({ ...item, toolNames: Object.freeze([...item.toolNames]), skillNames: Object.freeze([...item.skillNames]) }))),
    skills: Object.freeze(config.skills.map((item) => Object.freeze({ ...item, triggers: Object.freeze([...item.triggers]), resources: Object.freeze({ ...item.resources }) }))),
    connections: Object.freeze(config.connections.map(({ apiKey: _key, ...item }) => Object.freeze({ ...item, models: Object.freeze([...item.models]) }))),
  })
}

function validateNamespace(value: string): string {
  const namespace = required(value, 'namespace')
  if (!/^[A-Za-z0-9._-]+$/.test(namespace)) throw new Error('namespace contains unsupported characters')
  return namespace
}

interface BrowserAgentDependencies {
  loadConfig: typeof loadConfig
  saveConfig: typeof saveConfig
}

export async function createBrowserAgentWithDependencies(
  options: BrowserAgentOptions,
  dependencies: BrowserAgentDependencies,
): Promise<BrowserAgentClient> {
  const namespace = validateNamespace(options.namespace)
  const configDb = `einfach-browser-agent-config:${namespace}`
  const owner = await acquireNamespaceOwner(namespace)
  let config: StoredConfig
  try { config = await dependencies.loadConfig(configDb) } catch (error) {
    await owner.release().catch(() => undefined)
    throw error
  }
  let snapshot = publicSnapshot(config)
  let disposed = false
  let closing = false
  let disposePromise: Promise<void> | undefined
  const listeners = new Set<() => void>()
  let mutation = Promise.resolve()

  const transport = createProviderTransportFetch(async (input, init, identity) => {
    const bindingId = identity?.connectionId
    const connectionId = bindingId?.split('::', 1)[0]
    const connection = config.connections.find((item) => item.id === connectionId)
    if (!connectionId || !connection) throw new Error(`Model connection unavailable: ${connectionId ?? '(missing)'}`)
    if (!connection.apiKey) throw new Error(`Model connection credential is not configured: ${connectionId}`)
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${connection.apiKey}`)
    return (options.fetch ?? globalThis.fetch)(input, { ...init, headers })
  }, (bindingId) => {
    const separator = bindingId.indexOf('::')
    return separator < 0 ? undefined : decodeURIComponent(bindingId.slice(separator + 2))
  })
  let candidate: ReturnType<typeof createCore> | undefined
  try {
    candidate = createCore({
      config: { fetchImpl: transport },
      skillRegistry: {
        list: () => [...builtInSkillsRegistry.list(), ...config.skills.map(({ name, description, triggers }) => ({ name, description, triggers: [...triggers] }))],
        buildManifestText: (project) => builtInSkillsRegistry.buildManifestText(project),
      },
      registerTools(registry) { registerSkillsTools(registry); registry.register(compactContextTool); options.registerTools?.(registry) },
    })
    const historyDb = `einfach-browser-agent-history:${namespace}`
    candidate.persistence.configure({
      sessions: createIndexedDbSessionsPersistence(`einfach-browser-agent-sessions:${namespace}`),
      recovery: createIndexedDbRecoveryDriver(historyDb),
      historyLog: createIndexedDbHistoryLogDriver(historyDb),
      recoveryStore: (sessionId) => candidate?.findSessionStore(sessionId)?.store,
      historyFor: (sessionId) => candidate?.findSessionStore(sessionId)?.history,
    })
    await candidate.persistence.hydrate()
  } catch (error) {
    candidate?.persistence.reset()
    await owner.release().catch(() => undefined)
    throw error
  }
  const core = candidate

  async function commit(next: StoredConfig): Promise<void> {
    await dependencies.saveConfig(configDb, next)
    config = next
    snapshot = publicSnapshot(config)
    if (!closing) for (const listener of listeners) listener()
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (closing || disposed) return Promise.reject(new Error('Browser agent client is disposed'))
    const result = mutation.then(operation, operation)
    mutation = result.then(() => undefined, () => undefined)
    return result
  }

  function saveAgent(input: AgentProfileInput): Promise<AgentProfile> { return serialize(async () => {
    const connectionId = required(input.connectionId, 'connectionId')
    if (!config.connections.some((item) => item.id === connectionId)) throw new Error(`Unknown connection: ${connectionId}`)
    const name = required(input.name, 'agent name')
    const existing = input.id ? config.agents.find((item) => item.id === input.id) : undefined
    if (config.agents.some((item) => item.name === name && item.id !== existing?.id)) throw new Error(`Duplicate agent name: ${name}`)
    const skillNames = unique(input.skillNames, 'skillNames')
    const missing = skillNames.find((skill) => !config.skills.some((item) => item.name === skill))
    if (missing) throw new Error(`Unknown skill: ${missing}`)
    const agent: AgentProfile = { ...input, id: existing?.id ?? id('agent'), name, instructions: required(input.instructions, 'instructions'), connectionId, model: required(input.model, 'model'), toolNames: unique(input.toolNames, 'toolNames'), skillNames, revision: (existing?.revision ?? 0) + 1 }
    await commit({ ...config, agents: [...config.agents.filter((item) => item.id !== agent.id), agent] })
    return structuredClone(agent)
  }) }

  function saveSkill(input: ConfiguredSkillInput): Promise<ConfiguredSkill> { return serialize(async () => {
    const name = required(input.name, 'skill name')
    const existing = config.skills.find((item) => item.name === name)
    const skill: ConfiguredSkill = { ...input, name, description: required(input.description, 'description'), content: required(input.content, 'content'), triggers: unique(input.triggers, 'triggers'), resources: { ...input.resources }, revision: (existing?.revision ?? 0) + 1 }
    await commit({ ...config, skills: [...config.skills.filter((item) => item.name !== name), skill] })
    return structuredClone(skill)
  }) }

  function saveConnection(input: ModelConnectionInput): Promise<ModelConnection> { return serialize(async () => {
    const existing = input.id ? config.connections.find((item) => item.id === input.id) : undefined
    const label = required(input.label, 'connection label')
    if (config.connections.some((item) => item.label === label && item.id !== existing?.id)) throw new Error(`Duplicate connection label: ${label}`)
    const connection = { id: existing?.id ?? id('connection'), label, baseUrl: endpoint(input.baseUrl), models: unique(input.models, 'models'), credentialConfigured: Boolean(input.apiKey ?? existing?.apiKey), ...(input.apiKey !== undefined ? { apiKey: required(input.apiKey, 'apiKey') } : existing?.apiKey ? { apiKey: existing.apiKey } : {}) }
    await commit({ ...config, connections: [...config.connections.filter((item) => item.id !== connection.id), connection] })
    return structuredClone((({ apiKey: _key, ...item }) => item)(connection))
  }) }

  async function createSession(agentId: string): Promise<string> {
    if (closing || disposed) throw new Error('Browser agent client is disposed')
    const agent = config.agents.find((item) => item.id === agentId)
    if (!agent) throw new Error(`Unknown agent: ${agentId}`)
    const connection = config.connections.find((item) => item.id === agent.connectionId)
    if (!connection) throw new Error(`Unknown connection: ${agent.connectionId}`)
    const skills = agent.skillNames.map((name) => config.skills.find((item) => item.name === name)).filter((item): item is ConfiguredSkill => Boolean(item))
    const policy = lockSessionCapabilityPolicy(createDraftSessionCapabilityPolicy(), [
      ...agent.toolNames.map((name) => ({ kind: 'tool' as const, name, available: true, selected: true })),
      ...agent.skillNames.map((name) => ({ kind: 'skill' as const, name, available: true, selected: true })),
    ], Date.now())
    const endpointBinding = `${connection.id}::${encodeURIComponent(connection.baseUrl)}`
    const sessionId = core.newSession({ title: agent.name, settings: { vendor: 'openai-compat', model: agent.model, vendorSettings: { connectionId: endpointBinding } }, capabilityPolicy: policy, agentProfile: { agentId: agent.id, revision: agent.revision, instructions: agent.instructions, connectionId: connection.id, skillContents: skills.map((skill) => ({ ...skill })) } })
    return sessionId
  }

  return {
    core,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    saveAgent,
    deleteAgent: (agentId) => serialize(async () => { if (!config.agents.some((item) => item.id === agentId)) throw new Error(`Unknown agent: ${agentId}`); await commit({ ...config, agents: config.agents.filter((item) => item.id !== agentId) }) }),
    saveSkill,
    deleteSkill: (name) => serialize(async () => { if (config.agents.some((item) => item.skillNames.includes(name))) throw new Error(`Skill is referenced by an agent: ${name}`); await commit({ ...config, skills: config.skills.filter((item) => item.name !== name) }) }),
    saveConnection,
    deleteConnection: (connectionId) => serialize(async () => { if (config.agents.some((item) => item.connectionId === connectionId)) throw new Error(`Connection is referenced by an agent: ${connectionId}`); await commit({ ...config, connections: config.connections.filter((item) => item.id !== connectionId) }) }),
    createSession,
    dispose(disposeOptions) {
      if (disposePromise) return disposePromise
      closing = true
      const preserveRecovery = disposeOptions?.preserveRecovery === true
      disposePromise = (async () => {
        await mutation
        if (preserveRecovery) {
          await Promise.all(core.sessionIds().map((sessionId) => core.interruptRunForRecovery(sessionId)))
        } else {
          for (const sessionId of core.sessionIds()) core.stopRun({ sessionId })
        }
        await core.persistence.flush()
        core.persistence.reset()
        listeners.clear()
        disposed = true
        await owner.release()
      })()
      return disposePromise
    },
  }
}

export function createBrowserAgent(options: BrowserAgentOptions): Promise<BrowserAgentClient> {
  return createBrowserAgentWithDependencies(options, { loadConfig, saveConfig })
}
