import type { ToolRegistry } from '@einfach-agent/core/tools'
import type { createCore } from '@einfach-agent/core/plugin'

export interface AgentProfileInput { id?: string; name: string; instructions: string; connectionId: string; model: string; toolNames: readonly string[]; skillNames: readonly string[] }
export interface AgentProfile extends AgentProfileInput { id: string; revision: number }
export interface ConfiguredSkillInput { name: string; description: string; triggers: readonly string[]; content: string; resources: Readonly<Record<string, string>> }
export interface ConfiguredSkill extends ConfiguredSkillInput { revision: number }
export interface ModelConnectionInput { id?: string; label: string; baseUrl: string; models: readonly string[]; apiKey?: string }
export interface ModelConnection { id: string; label: string; baseUrl: string; models: readonly string[]; credentialConfigured: boolean }
export interface BrowserAgentSnapshot { agents: readonly AgentProfile[]; skills: readonly ConfiguredSkill[]; connections: readonly ModelConnection[] }
export type BrowserCore = ReturnType<typeof createCore>
export interface BrowserAgentClient {
  readonly core: BrowserCore
  getSnapshot(): BrowserAgentSnapshot
  subscribe(listener: () => void): () => void
  saveAgent(input: AgentProfileInput): Promise<AgentProfile>
  deleteAgent(id: string): Promise<void>
  saveSkill(input: ConfiguredSkillInput): Promise<ConfiguredSkill>
  deleteSkill(name: string): Promise<void>
  saveConnection(input: ModelConnectionInput): Promise<ModelConnection>
  deleteConnection(id: string): Promise<void>
  createSession(agentId: string): Promise<string>
  dispose(options?: { preserveRecovery?: boolean }): Promise<void>
}
export interface BrowserAgentOptions { namespace: string; registerTools?: (registry: ToolRegistry) => void; fetch?: typeof globalThis.fetch }
