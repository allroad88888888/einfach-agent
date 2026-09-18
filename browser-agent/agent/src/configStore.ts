import type { AgentProfile, ConfiguredSkill, ModelConnection } from './types'
import { endpoint } from './validation'

export interface StoredConfig {
  version: 1
  agents: AgentProfile[]
  skills: ConfiguredSkill[]
  connections: Array<ModelConnection & { apiKey?: string }>
}

const STORE = 'config'
const KEY = 'root'

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
      // Version 1 formerly also contained an owner store. Ownership now uses Web Locks so
      // an abnormal tab/worker exit is released by the browser.
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onblocked = () => reject(new Error('IndexedDB open blocked'))
  })
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function keys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); expected.sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0) }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function resources(value: unknown): value is Record<string, string> { return record(value) && Object.values(value).every((item) => typeof item === 'string') }

function decode(value: unknown): StoredConfig | undefined {
  if (!record(value) || !keys(value, ['version', 'agents', 'skills', 'connections']) || value.version !== 1
    || !Array.isArray(value.agents) || !Array.isArray(value.skills) || !Array.isArray(value.connections)) return undefined
  const skills = value.skills.every((item) => record(item) && keys(item, ['name', 'description', 'triggers', 'content', 'resources', 'revision'])
    && typeof item.name === 'string' && item.name.length > 0 && typeof item.description === 'string' && item.description.length > 0
    && Array.isArray(item.triggers) && item.triggers.every((entry) => typeof entry === 'string') && typeof item.content === 'string' && item.content.length > 0
    && resources(item.resources) && revision(item.revision))
  const connections = value.connections.every((item) => record(item) && keys(item, item.apiKey === undefined
    ? ['id', 'label', 'baseUrl', 'models', 'credentialConfigured'] : ['id', 'label', 'baseUrl', 'models', 'credentialConfigured', 'apiKey'])
    && typeof item.id === 'string' && item.id.length > 0 && typeof item.label === 'string' && item.label.length > 0
    && typeof item.baseUrl === 'string' && (() => { try { return endpoint(item.baseUrl) === item.baseUrl } catch { return false } })()
    && strings(item.models) && typeof item.credentialConfigured === 'boolean'
    && item.credentialConfigured === (typeof item.apiKey === 'string' && item.apiKey.length > 0))
  if (!skills || !connections) return undefined
  const connectionIdList = (value.connections as Array<{ id: string }>).map((item) => item.id)
  const skillNameList = (value.skills as Array<{ name: string }>).map((item) => item.name)
  const connectionIds = new Set(connectionIdList)
  const skillNames = new Set(skillNameList)
  const agents = value.agents.every((item) => record(item) && keys(item, ['id', 'name', 'instructions', 'connectionId', 'model', 'toolNames', 'skillNames', 'revision'])
    && typeof item.id === 'string' && item.id.length > 0 && typeof item.name === 'string' && item.name.length > 0
    && typeof item.instructions === 'string' && item.instructions.length > 0 && typeof item.connectionId === 'string' && connectionIds.has(item.connectionId)
    && typeof item.model === 'string' && item.model.length > 0 && strings(item.toolNames) && strings(item.skillNames)
    && item.skillNames.every((name) => skillNames.has(name)) && revision(item.revision))
  const unique = (items: string[]) => new Set(items).size === items.length
  if (!agents || !unique(connectionIdList) || !unique(skillNameList)) return undefined
  const config = value as unknown as StoredConfig
  if (!unique(config.agents.map((item) => item.id)) || !unique(config.agents.map((item) => item.name)) || !unique(config.connections.map((item) => item.label))) return undefined
  return config
}

export async function loadConfig(name: string): Promise<StoredConfig> {
  const db = await open(name)
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(KEY)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (value === undefined) return { version: 1, agents: [], skills: [], connections: [] }
    const decoded = decode(value)
    if (!decoded) {
      throw new Error('Unsupported or corrupt browser-agent configuration')
    }
    return decoded
  } finally { db.close() }
}

export async function saveConfig(name: string, value: StoredConfig): Promise<void> {
  const db = await open(name)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
